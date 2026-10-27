// Platform service: scenarios, campaigns, characters and the turn pipeline.
//   player message → dedupe → assemble layered context → KP tool loop → one transaction commit
//   → background compression.
import { PlatformError, ensure } from "./errors.js";
import { Store, DEFAULT_SETTINGS, type Campaign, type CampaignSettings, type GameEvent, type NewEvent, type Turn } from "./storage/store.js";
import { chunkScenario } from "./scenario/chunker.js";
import { ScenarioIndex } from "./scenario/retriever.js";
import { getRuleSystem, listRuleSystems } from "./rules/registry.js";
import { cryptoRng } from "./rules/rng.js";
import type { Outcome, Rng } from "./rules/types.js";
import { createProvider, isProviderId, PROVIDER_IDS, resolveProviderConfig, type ProviderConfig, type ModelProvider } from "./providers/index.js";
import type { Fetcher } from "./providers/http.js";
import { initialState, publicState, type WorldState } from "./kp/state.js";
import { buildKpTools, type TurnScratch } from "./kp/tools.js";
import { runAgent } from "./kp/agent.js";
import { direct, type Directive } from "./director/director.js";
import { assembleContext } from "./context/assembler.js";
import { compress } from "./context/compressor.js";

export const MESSAGE_KINDS = ["dialogue", "action", "ooc", "auto"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface PlatformOptions {
  env?: NodeJS.ProcessEnv;
  fetcher?: Fetcher;
  rng?: Rng;
  /** Override model creation (tests). */
  providerFactory?: (id: string) => ModelProvider;
  /** Run compression after each turn (default true). */
  autoCompress?: boolean;
}

export interface TurnOutcome {
  turn: Turn;
  duplicate: boolean;
  reply: string | null;
  events: GameEvent[];
}

const str = (v: unknown, field: string, max: number) => {
  ensure(typeof v === "string" && v.trim().length > 0, "INVALID_INPUT", `${field} 不能为空`);
  ensure((v as string).length <= max, "INPUT_TOO_LONG", `${field} 最多 ${max} 字符，不会静默截断`);
  return (v as string).trim();
};
const obj = (v: unknown) => {
  ensure(typeof v === "object" && v !== null && !Array.isArray(v), "INVALID_INPUT", "需要 JSON 对象");
  return v as Record<string, any>;
};

export class Platform {
  private queues = new Map<string, Promise<unknown>>();
  private compressing = new Map<string, Promise<void>>();
  private indexes = new Map<string, ScenarioIndex>();
  readonly env: NodeJS.ProcessEnv;
  private rng: Rng;

  constructor(
    public store: Store,
    private opts: PlatformOptions = {},
  ) {
    this.env = opts.env ?? process.env;
    this.rng = opts.rng ?? cryptoRng;
  }

  init() {
    return { interruptedTurns: this.store.failInterruptedTurns() };
  }

  // ---------------- providers ----------------
  providerConfig(id: string): ProviderConfig {
    ensure(isProviderId(id), "INVALID_PROVIDER", `不支持的模型供应商 ${id}`);
    return resolveProviderConfig(id, this.store.getSetting(`provider:${id}`), this.env);
  }
  provider(id: string): ModelProvider {
    if (this.opts.providerFactory) return this.opts.providerFactory(id);
    return createProvider(id, id === "demo" ? undefined : this.providerConfig(id), this.opts.fetcher);
  }
  providers() {
    return [
      { id: "demo", model: "offline-demo", configured: true, note: "离线演示：固定脚本，无智能" },
      ...PROVIDER_IDS.map((id) => {
        const { apiKey, ...c } = this.providerConfig(id);
        return { id, ...c, configured: !!apiKey };
      }),
    ];
  }
  configureProvider(id: string, body: unknown) {
    ensure(isProviderId(id), "INVALID_PROVIDER", `不支持的模型供应商 ${id}`);
    const b = obj(body);
    const stored: Partial<ProviderConfig> = { ...(this.store.getSetting<Partial<ProviderConfig>>(`provider:${id}`) ?? {}) };
    if (b.apiKey) stored.apiKey = str(b.apiKey, "apiKey", 500);
    if (b.deleteApiKey === true) delete stored.apiKey;
    if (b.model !== undefined) stored.model = b.model ? str(b.model, "model", 200) : undefined;
    if (b.baseUrl !== undefined) {
      if (b.baseUrl) {
        const u = new URL(str(b.baseUrl, "baseUrl", 500));
        ensure(["http:", "https:"].includes(u.protocol) && !u.username && !u.password, "INVALID_INPUT", "接口地址需要 http(s) 且不能含凭证");
        stored.baseUrl = u.toString().replace(/\/$/, "");
      } else delete stored.baseUrl;
    }
    this.store.setSetting(`provider:${id}`, stored);
    return this.providers().find((p) => p.id === id);
  }

  // ---------------- scenarios ----------------
  addScenario(body: unknown) {
    const b = obj(body);
    const title = str(b.title, "title", 200);
    const text = str(b.text, "text", 500_000);
    const brief = b.brief ? str(b.brief, "brief", 20_000) : "";
    const chunks = chunkScenario(text);
    const s = this.store.addScenario({ title, text, brief }, chunks);
    return { id: s.id, title, characters: text.length, chunks: chunks.length, hasBrief: !!brief };
  }
  index(scenarioId: string): ScenarioIndex {
    let idx = this.indexes.get(scenarioId);
    if (!idx) {
      idx = new ScenarioIndex(this.store.chunks(scenarioId));
      this.indexes.set(scenarioId, idx);
    }
    return idx;
  }

  // ---------------- campaigns ----------------
  systems() {
    return listRuleSystems().map((s) => ({ ...s, exampleSheet: getRuleSystem(s.id).exampleSheet() }));
  }
  createCampaign(body: unknown): Campaign {
    const b = obj(body);
    const system = getRuleSystem(str(b.systemId, "systemId", 60));
    this.store.getScenario(str(b.scenarioId, "scenarioId", 60));
    const provider = str(b.provider, "provider", 30);
    ensure(provider === "demo" || isProviderId(provider), "INVALID_PROVIDER", "provider 需为 demo / anthropic / openai / gemini");
    ensure(Array.isArray(b.players) && b.players.length >= 1 && b.players.length <= 12, "INVALID_INPUT", "需要 1-12 名玩家");
    const settings: CampaignSettings = structuredClone(DEFAULT_SETTINGS);
    if (b.settings?.budgets) Object.assign(settings.budgets, b.settings.budgets);
    if (b.settings?.director) Object.assign(settings.director, b.settings.director);
    const players = (b.players as unknown[]).map((p) => {
      const o = obj(p);
      return {
        id: str(o.id, "player.id", 64),
        name: str(o.name, "player.name", 60),
        sheet: o.sheet === undefined || o.sheet === null ? null : (system.parseSheet(o.sheet), o.sheet),
      };
    });
    ensure(new Set(players.map((p) => p.id)).size === players.length, "INVALID_INPUT", "玩家 id 不能重复");
    return this.store.tx(() => {
      const c = this.store.createCampaign(
        { name: str(b.name, "name", 100), systemId: system.id, scenarioId: b.scenarioId, provider, settings },
        initialState(),
      );
      for (const p of players) this.store.upsertCharacter({ campaignId: c.id, playerId: p.id, name: p.name, sheet: p.sheet });
      return c;
    });
  }
  setCharacter(campaignId: string, playerId: string, body: unknown) {
    const c = this.store.getCampaign(campaignId);
    const b = obj(body);
    const sheet = b.sheet === undefined || b.sheet === null ? null : b.sheet;
    if (sheet) getRuleSystem(c.systemId).parseSheet(sheet);
    this.store.upsertCharacter({ campaignId, playerId: str(playerId, "playerId", 64), name: str(b.name, "name", 60), sheet });
    return this.store.characters(campaignId);
  }

  kpView(campaignId: string) {
    const campaign = this.store.getCampaign(campaignId);
    const { state, version } = this.store.getState<WorldState>(campaignId);
    return {
      campaign,
      scenario: (({ text, ...s }) => ({ ...s, characters: text.length }))(this.store.getScenario(campaign.scenarioId)),
      characters: this.store.characters(campaignId),
      state,
      stateVersion: version,
      summaries: this.store.activeSummaries(campaignId),
      turns: this.store.turns(campaignId, 30),
      events: this.store.events(campaignId, { limit: 300 }),
    };
  }
  publicView(campaignId: string) {
    const campaign = this.store.getCampaign(campaignId);
    const { state } = this.store.getState<WorldState>(campaignId);
    return {
      campaign: { id: campaign.id, name: campaign.name, systemId: campaign.systemId },
      players: this.store.characters(campaignId).map((c) => ({ id: c.playerId, name: c.name })),
      state: publicState(state),
      summaries: this.store.activeSummaries(campaignId).map((s) => ({ level: s.level, text: s.publicText })),
      events: this.store.events(campaignId, { limit: 300, publicOnly: true }),
    };
  }

  // ---------------- turns ----------------
  message(campaignId: string, body: unknown): Promise<TurnOutcome> {
    const b = obj(body);
    const input = {
      messageId: str(b.messageId, "messageId", 200),
      playerId: str(b.playerId, "playerId", 64),
      kind: (b.kind ?? "auto") as MessageKind,
      text: str(b.text, "text", 6000),
    };
    ensure(MESSAGE_KINDS.includes(input.kind), "INVALID_INPUT", "kind 需为 dialogue / action / ooc / auto");
    return this.enqueue(campaignId, () => this.process(campaignId, input));
  }
  start(campaignId: string, body: unknown): Promise<TurnOutcome> {
    const b = obj(body);
    const messageId = str(b.messageId, "messageId", 200);
    return this.enqueue(campaignId, () =>
      this.process(campaignId, { messageId, playerId: null, kind: "start", text: "请主持开场" }),
    );
  }

  private enqueue<T>(campaignId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(campaignId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.queues.set(campaignId, next);
    void next.finally(() => {
      if (this.queues.get(campaignId) === next) this.queues.delete(campaignId);
    }).catch(() => {});
    return next;
  }

  private turnResult(turn: Turn, duplicate: boolean): TurnOutcome {
    const events = this.store
      .events(turn.campaignId, { limit: 200, publicOnly: true })
      .filter((e) => e.turnId === turn.id);
    return { turn, duplicate, reply: turn.reply, events };
  }

  private async process(
    campaignId: string,
    input: { messageId: string; playerId: string | null; kind: MessageKind | "start"; text: string },
  ): Promise<TurnOutcome> {
    const campaign = this.store.getCampaign(campaignId);
    const existing = this.store.findTurn(campaignId, input.messageId);
    if (existing) return this.turnResult(existing, true);
    const characters = this.store.characters(campaignId);
    if (input.playerId)
      ensure(characters.some((c) => c.playerId === input.playerId), "INVALID_PLAYER", "玩家不在这个团里", 404);

    const turn = this.store.createTurn(campaignId, input.messageId, input.playerId);
    this.store.appendEvents(campaignId, [
      {
        turnId: turn.id,
        type: "player",
        actor: input.playerId,
        visibility: "public",
        text: input.text,
        data: { n: turn.n, kind: input.kind },
      },
    ]);

    const { state, version } = this.store.getState<WorldState>(campaignId);
    const scratch: TurnScratch = {
      turn,
      state: structuredClone(state),
      sheets: Object.fromEntries(characters.filter((c) => c.sheet).map((c) => [c.playerId, structuredClone(c.sheet)])),
      players: characters.map((c) => ({ id: c.playerId, name: c.name })),
      events: [],
    };
    let directives: Directive[] = [];
    try {
      const system = getRuleSystem(campaign.systemId);
      const scenario = this.store.getScenario(campaign.scenarioId);
      const index = this.index(campaign.scenarioId);
      directives = this.directives(campaign, turn, state);
      const recent = this.store.events(campaignId, { afterSeq: this.store.summarizedThrough(campaignId) });
      const ctx = assembleContext({
        system,
        scenario,
        index,
        state,
        players: characters.map((c) => ({ id: c.playerId, name: c.name, sheet: c.sheet })),
        summaries: this.store.activeSummaries(campaignId),
        recent,
        directives,
        query: input.text,
        budgets: campaign.settings.budgets,
      });
      const player = characters.find((c) => c.playerId === input.playerId);
      const userInput =
        input.kind === "start"
          ? "请开场：交代背景，描述开场场景，抛出主线钩子；并用 update_scene、set_thread、update_npc 建立初始状态。"
          : JSON.stringify({ turn: turn.n, playerId: input.playerId, playerName: player?.name, kind: input.kind, text: input.text });
      const tools = buildKpTools({ system, index, rng: this.rng });
      const trace = await runAgent(this.provider(campaign.provider), ctx.system, userInput, tools, scratch);
      const reply = scratch.reply!;

      this.store.tx(() => {
        const events: NewEvent[] = [
          ...scratch.events,
          ...reply.whispers.map((w): NewEvent => ({ turnId: turn.id, type: "whisper", actor: w.playerId, visibility: "whisper", text: w.text, data: {} })),
          { turnId: turn.id, type: "kp", actor: null, visibility: "public", text: reply.text, data: { via: trace.via } },
          {
            turnId: turn.id,
            type: "directive",
            actor: null,
            visibility: "kp",
            text: directives.map((d) => d.reason).join("；") || "节奏正常",
            data: { directives, context: ctx.usage, trace },
          },
        ];
        this.store.appendEvents(campaignId, events);
        this.store.putState(campaignId, scratch.state, version);
        for (const c of characters)
          if (Object.hasOwn(scratch.sheets, c.playerId) && JSON.stringify(scratch.sheets[c.playerId]) !== JSON.stringify(c.sheet))
            this.store.upsertCharacter({ ...c, sheet: scratch.sheets[c.playerId] });
        this.store.finishTurn(turn.id, "complete", reply.text, null);
      });
    } catch (e) {
      const known = e instanceof PlatformError;
      const message = known ? e.message : "主持本轮时发生内部错误";
      if (!known) console.error(e);
      // Dice already rolled stay on record (they were real); other changes from this turn are dropped.
      const rolls = scratch.events.filter((ev) => ev.type === "roll");
      this.store.tx(() => {
        this.store.appendEvents(campaignId, [
          ...rolls,
          {
            turnId: turn.id,
            type: "error",
            actor: null,
            visibility: "public",
            text: `${message}。${rolls.length ? "已掷出的骰点保留，" : ""}本轮其他变化未保存；请用新的消息重试。`,
            data: { code: known ? e.code : "INTERNAL" },
          },
        ]);
        this.store.finishTurn(turn.id, "failed", null, message);
      });
    }
    if (this.opts.autoCompress !== false) this.scheduleCompress(campaign);
    return this.turnResult(this.store.findTurn(campaignId, input.messageId)!, false);
  }

  directives(campaign: Campaign, turn: Turn, state: WorldState): Directive[] {
    const turns = this.store.turns(campaign.id, 200);
    const lastSpoke: Record<string, number> = {};
    for (const t of turns) if (t.playerId) lastSpoke[t.playerId] = t.n;
    const recentOutcomes = this.store
      .events(campaign.id, { limit: 40 })
      .filter((e) => e.type === "roll" && e.data?.result?.outcome)
      .map((e) => e.data.result.outcome as Outcome);
    return direct({
      turn: turn.n,
      state,
      players: this.store.characters(campaign.id).map((c) => ({ id: c.playerId, name: c.name })),
      lastSpoke,
      recentOutcomes,
      settings: campaign.settings.director,
    });
  }

  // ---------------- compression ----------------
  private scheduleCompress(campaign: Campaign) {
    if (this.compressing.has(campaign.id)) return;
    const job = (async () => {
      try {
        // Up to two passes: one level-1 summary, then a possible chapter merge.
        for (let i = 0; i < 2; i++) {
          const r = await compress(this.store, campaign, this.provider(campaign.provider));
          if (!r.level1 && !r.level2) break;
        }
      } catch (e) {
        // Compression is best effort: context assembly clips recent events, and the next turn retries.
        console.error(`[compress ${campaign.id}]`, e instanceof Error ? e.message : e);
      } finally {
        this.compressing.delete(campaign.id);
      }
    })();
    this.compressing.set(campaign.id, job);
  }

  /** Compress now regardless of thresholds (manual button). Runs in the campaign queue. */
  compressNow(campaignId: string) {
    const campaign = this.store.getCampaign(campaignId);
    return this.enqueue(campaignId, () => compress(this.store, campaign, this.provider(campaign.provider), { force: true }));
  }

  /** Wait for queued turns and background compression of a campaign (tests, shutdown). */
  async idle(campaignId: string) {
    await this.queues.get(campaignId)?.catch(() => {});
    await this.compressing.get(campaignId);
  }
}
