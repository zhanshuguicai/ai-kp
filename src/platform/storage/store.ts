// SQLite storage. The event log is append-only and is the source of truth;
// state snapshots and summaries are derived data that can be rebuilt from it.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { PlatformError, ensure, now } from "../errors.js";

export type Visibility = "public" | "kp" | "whisper";
export type EventType =
  | "player"
  | "kp"
  | "roll"
  | "state"
  | "note"
  | "whisper"
  | "directive"
  | "system"
  | "error";

export interface GameEvent {
  seq: number;
  campaignId: string;
  turnId: string | null;
  type: EventType;
  actor: string | null;
  visibility: Visibility;
  text: string;
  data: any;
  createdAt: string;
}
export type NewEvent = Omit<GameEvent, "seq" | "campaignId" | "createdAt">;

export interface Scenario {
  id: string;
  title: string;
  text: string;
  brief: string;
  createdAt: string;
}
export interface ScenarioChunk {
  scenarioId: string;
  idx: number;
  heading: string;
  text: string;
  start: number;
}

export interface CampaignSettings {
  /** Token budgets for each context layer. */
  budgets: { scenario: number; state: number; summaries: number; recent: number };
  director: { clueDrought: number; sceneLength: number; quietTurns: number; failStreak: number };
  /** Per-campaign model choice; null = provider default. Aux handles summaries and other cheap work. */
  models: { main: string | null; auxProvider: string | null; auxModel: string | null };
}
export interface Campaign {
  id: string;
  name: string;
  systemId: string;
  scenarioId: string;
  provider: string;
  settings: CampaignSettings;
  createdAt: string;
}
export interface Character {
  campaignId: string;
  playerId: string;
  name: string;
  sheet: unknown;
}
export type TurnStatus = "processing" | "complete" | "failed";
export interface Turn {
  id: string;
  campaignId: string;
  n: number;
  messageId: string;
  playerId: string | null;
  status: TurnStatus;
  reply: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}
export interface Summary {
  id: string;
  campaignId: string;
  level: 1 | 2;
  fromSeq: number;
  toSeq: number;
  publicText: string;
  kpText: string;
  superseded: boolean;
  createdAt: string;
}

export const DEFAULT_SETTINGS: CampaignSettings = {
  budgets: { scenario: 6000, state: 1500, summaries: 4000, recent: 8000 },
  director: { clueDrought: 4, sceneLength: 8, quietTurns: 4, failStreak: 3 },
  models: { main: null, auxProvider: null, auxModel: null },
};

/** Fill settings saved by older versions with current defaults. */
export function normalizeSettings(raw: any): CampaignSettings {
  return {
    budgets: { ...DEFAULT_SETTINGS.budgets, ...(raw?.budgets ?? {}) },
    director: { ...DEFAULT_SETTINGS.director, ...(raw?.director ?? {}) },
    models: { ...DEFAULT_SETTINGS.models, ...(raw?.models ?? {}) },
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, brief TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scenario_chunks (
  scenario_id TEXT NOT NULL REFERENCES scenarios(id), idx INTEGER NOT NULL, heading TEXT NOT NULL,
  text TEXT NOT NULL, start INTEGER NOT NULL, PRIMARY KEY (scenario_id, idx));
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, system_id TEXT NOT NULL, scenario_id TEXT NOT NULL REFERENCES scenarios(id),
  provider TEXT NOT NULL, settings TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS characters (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id), player_id TEXT NOT NULL, name TEXT NOT NULL,
  sheet TEXT NOT NULL, PRIMARY KEY (campaign_id, player_id));
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), n INTEGER NOT NULL,
  message_id TEXT NOT NULL, player_id TEXT, status TEXT NOT NULL, reply TEXT, error TEXT,
  created_at TEXT NOT NULL, finished_at TEXT, UNIQUE (campaign_id, message_id), UNIQUE (campaign_id, n));
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL REFERENCES campaigns(id), turn_id TEXT,
  type TEXT NOT NULL, actor TEXT, visibility TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_by_campaign ON events (campaign_id, seq);
CREATE TABLE IF NOT EXISTS world_state (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id), version INTEGER NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), level INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, public_text TEXT NOT NULL, kp_text TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS summaries_by_campaign ON summaries (campaign_id, superseded, from_seq);
`;

const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = (v: unknown) => JSON.parse(String(v));

export class Store {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  /** Run fn in a transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  // ---------- settings ----------
  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? (parse(row.value) as T) : undefined;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, json(value));
  }

  // ---------- scenarios ----------
  addScenario(s: { title: string; text: string; brief: string }, chunks: Omit<ScenarioChunk, "scenarioId">[]): Scenario {
    const scenario: Scenario = { id: randomUUID(), ...s, createdAt: now() };
    this.tx(() => {
      this.db
        .prepare("INSERT INTO scenarios (id, title, text, brief, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(scenario.id, s.title, s.text, s.brief, scenario.createdAt);
      const insert = this.db.prepare(
        "INSERT INTO scenario_chunks (scenario_id, idx, heading, text, start) VALUES (?, ?, ?, ?, ?)",
      );
      for (const c of chunks) insert.run(scenario.id, c.idx, c.heading, c.text, c.start);
    });
    return scenario;
  }
  getScenario(id: string): Scenario {
    const r = this.db.prepare("SELECT * FROM scenarios WHERE id = ?").get(id);
    ensure(r, "NOT_FOUND", "剧本不存在", 404);
    return { id: String(r.id), title: String(r.title), text: String(r.text), brief: String(r.brief), createdAt: String(r.created_at) };
  }
  listScenarios() {
    return this.db
      .prepare(
        "SELECT s.id, s.title, length(s.text) AS characters, length(s.brief) > 0 AS has_brief, s.created_at, (SELECT count(*) FROM scenario_chunks c WHERE c.scenario_id = s.id) AS chunks FROM scenarios s ORDER BY s.created_at DESC",
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        title: String(r.title),
        characters: Number(r.characters),
        chunks: Number(r.chunks),
        hasBrief: Boolean(r.has_brief),
        createdAt: String(r.created_at),
      }));
  }
  chunks(scenarioId: string): ScenarioChunk[] {
    return this.db
      .prepare("SELECT * FROM scenario_chunks WHERE scenario_id = ? ORDER BY idx")
      .all(scenarioId)
      .map((r) => ({
        scenarioId: String(r.scenario_id),
        idx: Number(r.idx),
        heading: String(r.heading),
        text: String(r.text),
        start: Number(r.start),
      }));
  }

  // ---------- campaigns ----------
  createCampaign(c: Omit<Campaign, "id" | "createdAt">, initialState: unknown): Campaign {
    const campaign: Campaign = { id: randomUUID(), ...c, createdAt: now() };
    this.tx(() => {
      this.db
        .prepare("INSERT INTO campaigns (id, name, system_id, scenario_id, provider, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(campaign.id, c.name, c.systemId, c.scenarioId, c.provider, json(c.settings), campaign.createdAt);
      this.db
        .prepare("INSERT INTO world_state (campaign_id, version, state) VALUES (?, 0, ?)")
        .run(campaign.id, json(initialState));
    });
    return campaign;
  }
  getCampaign(id: string): Campaign {
    const r = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
    ensure(r, "NOT_FOUND", "团不存在", 404);
    return {
      id: String(r.id),
      name: String(r.name),
      systemId: String(r.system_id),
      scenarioId: String(r.scenario_id),
      provider: String(r.provider),
      settings: normalizeSettings(parse(r.settings)),
      createdAt: String(r.created_at),
    };
  }
  updateSettings(campaignId: string, settings: CampaignSettings) {
    const res = this.db.prepare("UPDATE campaigns SET settings = ? WHERE id = ?").run(json(settings), campaignId);
    ensure(Number(res.changes) === 1, "NOT_FOUND", "团不存在", 404);
  }

  /** Token and cost totals over all completed turns (recorded on each turn's directive event). */
  usageTotals(campaignId: string) {
    const r = this.db
      .prepare(
        `SELECT count(*) AS turns,
           sum(json_extract(data, '$.trace.usage.input')) AS input,
           sum(json_extract(data, '$.trace.usage.output')) AS output,
           sum(json_extract(data, '$.trace.usage.cached')) AS cached,
           sum(json_extract(data, '$.trace.usage.cost')) AS cost
         FROM events WHERE campaign_id = ? AND type = 'directive'`,
      )
      .get(campaignId);
    return {
      turns: Number(r?.turns ?? 0),
      input: Number(r?.input ?? 0),
      output: Number(r?.output ?? 0),
      cached: Number(r?.cached ?? 0),
      cost: r?.cost === null || r?.cost === undefined ? null : Number(r.cost),
    };
  }

  listCampaigns() {
    return this.db
      .prepare(
        "SELECT c.id, c.name, c.system_id, c.provider, c.created_at, (SELECT max(n) FROM turns t WHERE t.campaign_id = c.id) AS turns FROM campaigns c ORDER BY c.created_at DESC",
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        systemId: String(r.system_id),
        provider: String(r.provider),
        turns: Number(r.turns ?? 0),
        createdAt: String(r.created_at),
      }));
  }

  // ---------- characters ----------
  upsertCharacter(ch: Character) {
    this.db
      .prepare(
        "INSERT INTO characters (campaign_id, player_id, name, sheet) VALUES (?, ?, ?, ?) ON CONFLICT(campaign_id, player_id) DO UPDATE SET name = excluded.name, sheet = excluded.sheet",
      )
      .run(ch.campaignId, ch.playerId, ch.name, json(ch.sheet));
  }
  characters(campaignId: string): Character[] {
    return this.db
      .prepare("SELECT * FROM characters WHERE campaign_id = ? ORDER BY rowid")
      .all(campaignId)
      .map((r) => ({
        campaignId: String(r.campaign_id),
        playerId: String(r.player_id),
        name: String(r.name),
        sheet: parse(r.sheet),
      }));
  }

  // ---------- turns ----------
  private turnRow(r: any): Turn {
    return {
      id: String(r.id),
      campaignId: String(r.campaign_id),
      n: Number(r.n),
      messageId: String(r.message_id),
      playerId: r.player_id === null ? null : String(r.player_id),
      status: r.status as TurnStatus,
      reply: r.reply === null ? null : String(r.reply),
      error: r.error === null ? null : String(r.error),
      createdAt: String(r.created_at),
      finishedAt: r.finished_at === null ? null : String(r.finished_at),
    };
  }
  findTurn(campaignId: string, messageId: string): Turn | undefined {
    const r = this.db.prepare("SELECT * FROM turns WHERE campaign_id = ? AND message_id = ?").get(campaignId, messageId);
    return r ? this.turnRow(r) : undefined;
  }
  createTurn(campaignId: string, messageId: string, playerId: string | null): Turn {
    return this.tx(() => {
      const last = this.db.prepare("SELECT max(n) AS n FROM turns WHERE campaign_id = ?").get(campaignId);
      const turn: Turn = {
        id: randomUUID(),
        campaignId,
        n: Number(last?.n ?? 0) + 1,
        messageId,
        playerId,
        status: "processing",
        reply: null,
        error: null,
        createdAt: now(),
        finishedAt: null,
      };
      this.db
        .prepare("INSERT INTO turns (id, campaign_id, n, message_id, player_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(turn.id, campaignId, turn.n, messageId, playerId, turn.status, turn.createdAt);
      return turn;
    });
  }
  finishTurn(id: string, status: Exclude<TurnStatus, "processing">, reply: string | null, error: string | null) {
    this.db
      .prepare("UPDATE turns SET status = ?, reply = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(status, reply, error, now(), id);
  }
  turns(campaignId: string, limit = 50): Turn[] {
    return this.db
      .prepare("SELECT * FROM turns WHERE campaign_id = ? ORDER BY n DESC LIMIT ?")
      .all(campaignId, limit)
      .map((r) => this.turnRow(r))
      .reverse();
  }
  /** Turns left "processing" by a crash cannot be resumed safely; mark them failed. */
  failInterruptedTurns(): number {
    const rows = this.db.prepare("SELECT id, campaign_id FROM turns WHERE status = 'processing'").all();
    for (const r of rows)
      this.tx(() => {
        this.finishTurn(String(r.id), "failed", null, "服务重启中断了本轮；已完成的骰点保留，请重新发送行动。");
        this.appendEvents(String(r.campaign_id), [
          { turnId: String(r.id), type: "error", actor: null, visibility: "public", text: "服务重启中断了本轮，请重新发送行动。", data: {} },
        ]);
      });
    return rows.length;
  }

  // ---------- events ----------
  appendEvents(campaignId: string, events: NewEvent[]): number[] {
    const insert = this.db.prepare(
      "INSERT INTO events (campaign_id, turn_id, type, actor, visibility, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    return this.tx(() =>
      events.map((e) =>
        Number(insert.run(campaignId, e.turnId, e.type, e.actor, e.visibility, e.text, json(e.data), now()).lastInsertRowid),
      ),
    );
  }
  events(campaignId: string, opts: { afterSeq?: number; limit?: number; publicOnly?: boolean } = {}): GameEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE campaign_id = ? AND seq > ? ${opts.publicOnly ? "AND visibility = 'public'" : ""} ORDER BY seq DESC LIMIT ?`,
      )
      .all(campaignId, opts.afterSeq ?? 0, opts.limit ?? 1_000_000);
    return rows.reverse().map((r) => ({
      seq: Number(r.seq),
      campaignId: String(r.campaign_id),
      turnId: r.turn_id === null ? null : String(r.turn_id),
      type: r.type as EventType,
      actor: r.actor === null ? null : String(r.actor),
      visibility: r.visibility as Visibility,
      text: String(r.text),
      data: parse(r.data),
      createdAt: String(r.created_at),
    }));
  }

  // ---------- world state ----------
  getState<T>(campaignId: string): { version: number; state: T } {
    const r = this.db.prepare("SELECT version, state FROM world_state WHERE campaign_id = ?").get(campaignId);
    ensure(r, "NOT_FOUND", "团状态不存在", 404);
    return { version: Number(r.version), state: parse(r.state) };
  }
  putState(campaignId: string, state: unknown, expectedVersion: number) {
    const res = this.db
      .prepare("UPDATE world_state SET state = ?, version = version + 1 WHERE campaign_id = ? AND version = ?")
      .run(json(state), campaignId, expectedVersion);
    if (Number(res.changes) !== 1)
      throw new PlatformError("STATE_CONFLICT", "团状态已被其他操作修改，请重试", 409);
  }

  // ---------- summaries ----------
  private summaryRow(r: any): Summary {
    return {
      id: String(r.id),
      campaignId: String(r.campaign_id),
      level: Number(r.level) as 1 | 2,
      fromSeq: Number(r.from_seq),
      toSeq: Number(r.to_seq),
      publicText: String(r.public_text),
      kpText: String(r.kp_text),
      superseded: Boolean(r.superseded),
      createdAt: String(r.created_at),
    };
  }
  activeSummaries(campaignId: string): Summary[] {
    return this.db
      .prepare("SELECT * FROM summaries WHERE campaign_id = ? AND superseded = 0 ORDER BY from_seq")
      .all(campaignId)
      .map((r) => this.summaryRow(r));
  }
  addSummary(s: Omit<Summary, "id" | "createdAt" | "superseded">, supersedes: string[] = []): Summary {
    const summary: Summary = { ...s, id: randomUUID(), superseded: false, createdAt: now() };
    this.tx(() => {
      this.db
        .prepare("INSERT INTO summaries (id, campaign_id, level, from_seq, to_seq, public_text, kp_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(summary.id, s.campaignId, s.level, s.fromSeq, s.toSeq, s.publicText, s.kpText, summary.createdAt);
      const mark = this.db.prepare("UPDATE summaries SET superseded = 1 WHERE id = ? AND campaign_id = ?");
      for (const id of supersedes) mark.run(id, s.campaignId);
    });
    return summary;
  }
  /** Highest event seq already covered by a summary (0 if none). */
  summarizedThrough(campaignId: string): number {
    const r = this.db
      .prepare("SELECT max(to_seq) AS s FROM summaries WHERE campaign_id = ? AND superseded = 0")
      .get(campaignId);
    return Number(r?.s ?? 0);
  }
}
