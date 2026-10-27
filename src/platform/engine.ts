// Platform service: scenarios, campaigns, characters and the turn pipeline.
//   player message → dedupe → assemble layered context → KP tool loop → one transaction commit
//   → background compression.
import { PlatformError, ensure } from "./errors.js";
import { createHash, randomBytes } from "node:crypto";
import { Store, normalizeSettings, type Campaign, type CampaignSettings, type GameEvent, type NewEvent, type Turn } from "./storage/store.js";
import { chunkScenario } from "./scenario/chunker.js";
import { ScenarioIndex } from "./scenario/retriever.js";
import { getRuleSystem, listRuleSystems } from "./rules/registry.js";
import { cryptoRng } from "./rules/rng.js";
import type { Outcome, Rng } from "./rules/types.js";
import {
  AUX_DEFAULTS,
  createProvider,
  isProviderId,
  isReasoningEffort,
  PROVIDER_IDS,
  resolveProviderConfig,
  type ProviderConfig,
  type ModelProvider,
} from "./providers/index.js";
import type { Fetcher } from "./providers/http.js";
import { initialState, publicState, type WorldState } from "./kp/state.js";
import { buildKpTools, checkRecords, PUSH_WINDOW, type CheckRecord, type TurnScratch } from "./kp/tools.js";
import { runAgent } from "./kp/agent.js";
import { direct, type Directive } from "./director/director.js";
import { assembleContext } from "./context/assembler.js";
import { compress, compressThreshold, pendingTokens } from "./context/compressor.js";
import { compileScenario, demoCompile, renderGuide, type CompiledScenario, type ScenarioBlurb } from "./scenario/compiler.js";

export const MESSAGE_KINDS = ["dialogue", "action", "ooc", "auto"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
const OOC_MARK = /^\s*(?:ooc\s*[:：]|[（(])/i;

export interface PlatformOptions {
  env?: NodeJS.ProcessEnv;
  fetcher?: Fetcher;
  rng?: Rng;
  /** Override model creation (tests). */
  providerFactory?: (id: string, opts: { role: ModelRole; model: string }) => ModelProvider;
  /** Run compression after each turn (default true). */
  autoCompress?: boolean;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type ModelRole = "main" | "aux" | "compile";
/** Reading a whole scenario can take minutes. */
const COMPILE_TIMEOUT_MS = 600_000;
export interface ResolvedModels {
  main: { provider: string; model: string };
  aux: { provider: string; model: string };
}

const MODEL_NAME = /^\S{1,200}$/;

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
  private compressErrors = new Map<string, string>();
  private compiling = new Map<string, Promise<void>>();
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
  /** Which provider and model a campaign uses for its main KP and for auxiliary work. */
  models(campaign: Campaign): ResolvedModels {
    const m = campaign.settings.models;
    const defaultModel = (provider: string) => (provider === "demo" ? "offline-demo" : this.providerConfig(provider).model);
    const auxProvider = m.auxProvider ?? campaign.provider;
    return {
      main: { provider: campaign.provider, model: m.main ?? defaultModel(campaign.provider) },
      aux: {
        provider: auxProvider,
        model: m.auxModel ?? (isProviderId(auxProvider) ? AUX_DEFAULTS[auxProvider] : undefined) ?? defaultModel(auxProvider),
      },
    };
  }
  provider(id: string, model?: string, role: ModelRole = "main", overrides: Partial<ProviderConfig> = {}): ModelProvider {
    if (this.opts.providerFactory) return this.opts.providerFactory(id, { role, model: model ?? "" });
    if (id === "demo") return createProvider("demo", undefined);
    const config = this.providerConfig(id);
    // Summaries need little thinking; with the main model's effort, reasoning used up the output budget
    // and summaries came back truncated in live tests.
    const aux = role === "aux" && config.reasoningEffort ? { reasoningEffort: "low" as const } : {};
    return createProvider(id, { ...config, ...(model ? { model } : {}), ...aux, ...overrides }, this.opts.fetcher);
  }
  private modelFor(campaign: Campaign, role: "main" | "aux"): ModelProvider {
    const r = this.models(campaign)[role];
    return this.provider(r.provider, r.model, role);
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
    if (b.reasoningEffort !== undefined) {
      ensure(b.reasoningEffort === null || isReasoningEffort(b.reasoningEffort), "INVALID_INPUT", "reasoningEffort 需为 none/minimal/low/medium/high/xhigh");
      stored.reasoningEffort = b.reasoningEffort ?? undefined;
    }
    if (b.maxTokens !== undefined) {
      ensure(b.maxTokens === null || (Number.isInteger(b.maxTokens) && b.maxTokens >= 256 && b.maxTokens <= 64000), "INVALID_INPUT", "maxTokens 需为 256-64000 的整数");
      stored.maxTokens = b.maxTokens ?? undefined;
    }
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
  /**
   * Import a scenario. With `compile: { provider, model? }` the KP guide and blurb are built in the
   * background; the response never contains scenario text or compiled content.
   */
  addScenario(body: unknown) {
    const b = obj(body);
    const title = str(b.title, "title", 200);
    const text = str(b.text, "text", 500_000);
    const brief = b.brief ? str(b.brief, "brief", 20_000) : "";
    const chunks = chunkScenario(text);
    const s = this.store.addScenario({ title, text, brief }, chunks);
    if (b.compile !== undefined && b.compile !== null) this.compileScenario(s.id, b.compile);
    return this.scenarioSummary(s.id);
  }
  /** Spoiler-free scenario info: size, compile status and blurb only. */
  scenarioSummary(id: string) {
    const s = this.store.getScenario(id);
    return {
      id: s.id,
      title: s.title,
      characters: s.text.length,
      chunks: this.index(id).size,
      hasBrief: !!s.brief,
      compileStatus: s.compileStatus,
      compileError: s.compileError,
      blurb: s.blurb as ScenarioBlurb | null,
    };
  }
  /** Start (or restart) compiling a scenario in the background. */
  compileScenario(id: string, body: unknown) {
    const s = this.store.getScenario(id);
    const b = obj(body);
    const provider = str(b.provider, "provider", 30);
    ensure(provider === "demo" || isProviderId(provider), "INVALID_PROVIDER", "provider 需为 demo / openrouter / anthropic / openai / gemini");
    const model = b.model ? str(b.model, "model", 200) : undefined;
    ensure(!model || MODEL_NAME.test(model), "INVALID_INPUT", "model 需为不含空格的模型名");
    ensure(!this.compiling.has(id), "COMPILE_RUNNING", "这个剧本正在编译中", 409);
    // Fail fast on missing credentials instead of in the background.
    const llm = provider === "demo" ? null : this.provider(provider, model, "compile", { timeoutMs: COMPILE_TIMEOUT_MS });
    this.store.setCompileStatus(id, "running");
    const job = (async () => {
      try {
        const out = llm ? await compileScenario(llm, s.title, s.text, this.store.chunks(id)) : demoCompile(s.title);
        this.store.saveCompiled(id, out.compiled, out.blurb);
      } catch (e) {
        // Error messages are ours (codes and generic text), never model output or scenario text.
        const message = e instanceof PlatformError ? e.message : "编译时发生内部错误";
        if (!(e instanceof PlatformError)) console.error(e);
        this.store.setCompileStatus(id, "failed", message);
      } finally {
        this.compiling.delete(id);
      }
    })();
    this.compiling.set(id, job);
    return this.scenarioSummary(id);
  }
  /** Wait for a background compile (tests, shutdown). */
  async compileIdle(id: string) {
    await this.compiling.get(id);
  }
  compiled(scenarioId: string): CompiledScenario | null {
    const s = this.store.getScenario(scenarioId);
    return s.compileStatus === "done" ? (s.compiled as CompiledScenario) : null;
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
    const settings: CampaignSettings = normalizeSettings(b.settings);
    if (b.models !== undefined) settings.models = this.parseModels(b.models, settings.models);
    settings.compression = this.parseCompression(obj(b.settings ?? {}).compression ?? {}, settings, { threshold: null });
    const players = (b.players as unknown[]).map((p) => {
      const o = obj(p);
      return {
        id: str(o.id, "player.id", 64),
        name: str(o.name, "player.name", 60),
        sheet: o.sheet === undefined || o.sheet === null ? null : (system.parseSheet(o.sheet), o.sheet),
      };
    });
    ensure(new Set(players.map((p) => p.id)).size === players.length, "INVALID_INPUT", "玩家 id 不能重复");
    // Threat clocks from the compiled scenario start empty; they are KP-only.
    const state = initialState();
    for (const k of this.compiled(b.scenarioId)?.clocks ?? [])
      state.clocks[k.name] = { filled: 0, size: k.size, note: k.consequence };
    return this.store.tx(() => {
      const c = this.store.createCampaign(
        { name: str(b.name, "name", 100), systemId: system.id, scenarioId: b.scenarioId, provider, settings },
        state,
      );
      for (const p of players) this.store.upsertCharacter({ campaignId: c.id, playerId: p.id, name: p.name, sheet: p.sheet });
      return c;
    });
  }
  private parseModels(body: unknown, current: CampaignSettings["models"]): CampaignSettings["models"] {
    const b = obj(body);
    const next = { ...current };
    for (const key of ["main", "auxModel"] as const)
      if (b[key] !== undefined) {
        ensure(b[key] === null || b[key] === "" || (typeof b[key] === "string" && MODEL_NAME.test(b[key])), "INVALID_INPUT", `${key} 需为不含空格的模型名`);
        next[key] = b[key] || null;
      }
    if (b.auxProvider !== undefined) {
      ensure(b.auxProvider === null || b.auxProvider === "" || b.auxProvider === "demo" || isProviderId(b.auxProvider), "INVALID_PROVIDER", "auxProvider 需为 demo / openrouter / anthropic / openai / gemini");
      next.auxProvider = b.auxProvider || null;
    }
    return next;
  }
  private parseCompression(body: unknown, settings: CampaignSettings, current: CampaignSettings["compression"]): CampaignSettings["compression"] {
    const b = obj(body);
    if (b.threshold === undefined) return current;
    const max = settings.budgets.recent;
    ensure(
      b.threshold === null || (Number.isInteger(b.threshold) && (b.threshold as number) >= 500 && (b.threshold as number) <= max),
      "INVALID_INPUT",
      `压缩阈值需为 500-${max} 的整数（不能超过"最近经过"预算，否则旧记录会先被截掉），或 null 用默认`,
    );
    return { threshold: (b.threshold as number | null) ?? null };
  }
  setCompression(campaignId: string, body: unknown) {
    const c = this.store.getCampaign(campaignId);
    const settings = { ...c.settings, compression: this.parseCompression(body, c.settings, c.settings.compression) };
    this.store.updateSettings(campaignId, settings);
    return this.compressionStatus({ ...c, settings });
  }
  /** Spoiler-free compression status: sizes and turn numbers only, never summary text. */
  compressionStatus(campaign: Campaign) {
    const summaries = this.store.activeSummaries(campaign.id);
    const through = this.store.summarizedThrough(campaign.id);
    const lastTurn = through ? this.store.turnOfSeq(campaign.id, through) : null;
    return {
      threshold: compressThreshold(campaign),
      custom: campaign.settings.compression.threshold !== null,
      pendingTokens: pendingTokens(this.store, campaign),
      summaries: summaries.filter((s) => s.level === 1).length,
      chapters: summaries.filter((s) => s.level === 2).length,
      summarizedThroughTurn: lastTurn,
      running: this.compressing.has(campaign.id),
      lastError: this.compressErrors.get(campaign.id) ?? null,
    };
  }
  setModels(campaignId: string, body: unknown) {
    const c = this.store.getCampaign(campaignId);
    const settings = { ...c.settings, models: this.parseModels(body, c.settings.models) };
    this.store.updateSettings(campaignId, settings);
    return this.models({ ...c, settings });
  }

  setCharacter(campaignId: string, playerId: string, body: unknown) {
    const c = this.store.getCampaign(campaignId);
    const b = obj(body);
    const sheet = b.sheet === undefined || b.sheet === null ? null : b.sheet;
    if (sheet) getRuleSystem(c.systemId).parseSheet(sheet);
    this.store.upsertCharacter({ campaignId, playerId: str(playerId, "playerId", 64), name: str(b.name, "name", 60), sheet });
    return this.store.characters(campaignId);
  }

  // ---------------- players & invites ----------------
  /** Create (or replace) invite tokens. Only a hash is stored; old links stop working. */
  issueInvites(campaignId: string, playerId?: string) {
    this.store.getCampaign(campaignId);
    const targets = this.store.characters(campaignId).filter((c) => !playerId || c.playerId === playerId);
    ensure(targets.length, "NOT_FOUND", "玩家不存在", 404);
    return targets.map((c) => {
      const token = randomBytes(24).toString("base64url");
      this.store.setPlayerTokenHash(campaignId, c.playerId, hashToken(token));
      return { playerId: c.playerId, name: c.name, token };
    });
  }
  addPlayer(campaignId: string, body: unknown) {
    const c = this.store.getCampaign(campaignId);
    const b = obj(body);
    const id = str(b.id, "id", 64);
    ensure(!this.store.characters(campaignId).some((p) => p.playerId === id), "INVALID_INPUT", "玩家 id 已存在");
    ensure(this.store.characters(campaignId).length < 12, "INVALID_INPUT", "每个团最多 12 名玩家");
    this.store.upsertCharacter({ campaignId: c.id, playerId: id, name: str(b.name, "name", 60), sheet: null });
    return this.issueInvites(campaignId, id)[0];
  }
  /** Resolve a player invite token. */
  authPlayer(token: unknown): { campaignId: string; playerId: string } {
    ensure(typeof token === "string" && token.length >= 20 && token.length <= 100, "PLAYER_REQUIRED", "需要玩家邀请链接", 401);
    const hit = this.store.findPlayerByTokenHash(hashToken(token as string));
    ensure(hit, "PLAYER_REQUIRED", "邀请链接无效或已被重新生成", 401);
    return hit;
  }

  // ---------------- views ----------------
  /**
   * What the organizer sees: setup, health and cost, and the same public log every player sees.
   * Nothing here may contain secrets: no KP notes, clocks, secret rolls, whispers, KP summaries,
   * directive texts or scenario text.
   */
  organizerView(campaignId: string) {
    const campaign = this.store.getCampaign(campaignId);
    const characters = this.store.characters(campaignId);
    const turns = this.store.turns(campaignId, 50);
    const turnN = new Map(turns.map((t) => [t.id, t.n]));
    const summaries = this.store.activeSummaries(campaignId);
    const scenario = this.store.getScenario(campaign.scenarioId);
    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        systemId: campaign.systemId,
        provider: campaign.provider,
        createdAt: campaign.createdAt,
        revealedAt: campaign.revealedAt,
        models: campaign.settings.models,
      },
      models: this.safeModels(campaign),
      usage: this.store.usageTotals(campaignId),
      scenario: this.scenarioSummary(scenario.id),
      players: characters.map((c) => ({ id: c.playerId, name: c.name, invited: !!c.invited, hasSheet: c.sheet !== null })),
      turns: turns.map((t) => ({
        n: t.n,
        status: t.status,
        player: t.playerId ? (characters.find((c) => c.playerId === t.playerId)?.name ?? t.playerId) : null,
        error: t.error,
        at: t.createdAt,
      })),
      diagnostics: this.store.turnDiagnostics(campaignId, 50).map(({ turnId, data }) => ({
        n: turnId ? (turnN.get(turnId) ?? null) : null,
        via: data?.trace?.via ?? null,
        rounds: data?.trace?.rounds ?? null,
        tools: (data?.trace?.toolCalls ?? []).map((c: any) => ({ name: c.name, ok: c.ok, error: c.error ?? null })),
        // Kinds only: the reason texts can name clocks, clues and plans.
        directives: (data?.directives ?? []).map((d: any) => d.kind),
        contextTokens: data?.context?.total ?? null,
        usage: data?.trace?.usage ?? null,
      })),
      memory: { summaries: summaries.length, chapters: summaries.filter((s) => s.level === 2).length },
      compression: this.compressionStatus(campaign),
      public: this.publicView(campaignId),
    };
  }

  /** What one player sees: public events and state, plus whispers to them and their own sheet. */
  playerView(campaignId: string, playerId: string) {
    const pub = this.publicView(campaignId);
    const me = this.store.characters(campaignId).find((c) => c.playerId === playerId);
    ensure(me, "PLAYER_REQUIRED", "玩家已不在这个团里", 401);
    const system = getRuleSystem(this.store.getCampaign(campaignId).systemId);
    return {
      ...pub,
      me: { id: me.playerId, name: me.name, sheet: me.sheet, exampleSheet: system.exampleSheet(), systemName: system.name },
      // Spoiler-free by construction (see compiler.blurbLeaks); never the compiled guide.
      scenario: (({ title, blurb }) => ({ title, blurb }))(this.scenarioSummary(this.store.getCampaign(campaignId).scenarioId)),
      events: this.store.events(campaignId, { limit: 300, forPlayer: playerId }),
    };
  }
  setOwnSheet(campaignId: string, playerId: string, body: unknown) {
    const me = this.store.characters(campaignId).find((c) => c.playerId === playerId);
    ensure(me, "PLAYER_REQUIRED", "玩家已不在这个团里", 401);
    const b = obj(body);
    return this.setCharacter(campaignId, playerId, { name: b.name ?? me.name, sheet: b.sheet });
  }
  playerMessage(campaignId: string, playerId: string, body: unknown): Promise<TurnOutcome> {
    const b = obj(body);
    return this.message(campaignId, { ...b, playerId }).then((out) => ({
      ...out,
      events: this.store.events(campaignId, { limit: 200, forPlayer: playerId }).filter((e) => e.turnId === out.turn.id),
    }));
  }

  /**
   * Unlock the KP view for this campaign. One-way, and announced to the table so everyone knows
   * the organizer can now see secrets.
   */
  reveal(campaignId: string, body: unknown) {
    const b = obj(body);
    ensure(b.confirm === true, "CONFIRM_REQUIRED", "解锁会看到全部秘密且无法撤销，需要 confirm: true");
    const before = this.store.getCampaign(campaignId).revealedAt;
    const at = this.store.setRevealed(campaignId);
    if (!before)
      this.store.appendEvents(campaignId, [
        {
          turnId: null,
          type: "system",
          actor: null,
          visibility: "public",
          text: "组织者解锁了 KP 视图（复盘或调试）。从现在起，本团的秘密对组织者不再保密。",
          data: { revealedAt: at },
        },
      ]);
    return { revealedAt: at };
  }

  /** Full KP view with every secret. Only after the organizer explicitly unlocked it. */
  kpView(campaignId: string) {
    const campaign = this.store.getCampaign(campaignId);
    ensure(campaign.revealedAt, "SPOILER_LOCKED", "KP 视图已锁定：包含剧本秘密。复盘时可在组织者页面解锁", 403);
    const { state, version } = this.store.getState<WorldState>(campaignId);
    return {
      campaign,
      models: this.safeModels(campaign),
      usage: this.store.usageTotals(campaignId),
      scenario: (({ text, ...s }) => ({ ...s, characters: text.length }))(this.store.getScenario(campaign.scenarioId)),
      characters: this.store.characters(campaignId),
      state,
      stateVersion: version,
      summaries: this.store.activeSummaries(campaignId),
      turns: this.store.turns(campaignId, 30),
      events: this.store.events(campaignId, { limit: 300 }),
    };
  }
  /** Resolve models for display without failing the whole view on a bad provider config. */
  private safeModels(campaign: Campaign): ResolvedModels | null {
    try {
      return this.models(campaign);
    } catch {
      return null;
    }
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
    // Players just write; out-of-character talk is marked the way tables usually do it.
    if (input.kind === "auto" && OOC_MARK.test(input.text)) input.kind = "ooc";
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
      priorChecks: this.priorChecks(campaignId, turn.n, characters.map((c) => c.playerId)),
    };
    let directives: Directive[] = [];
    try {
      const system = getRuleSystem(campaign.systemId);
      const scenario = this.store.getScenario(campaign.scenarioId);
      const index = this.index(campaign.scenarioId);
      const compiled = this.compiled(campaign.scenarioId);
      directives = this.directives(campaign, turn, state, compiled);
      // Remember which clock levels were warned about (committed with the turn).
      for (const d of directives)
        if (d.kind === "escalate" && d.target && scratch.state.clocks[d.target])
          scratch.state.clocks[d.target].warned = scratch.state.clocks[d.target].filled;
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
        guide: compiled ? renderGuide(compiled, campaign.settings.budgets.scenario) : "",
        budgets: campaign.settings.budgets,
      });
      const player = characters.find((c) => c.playerId === input.playerId);
      const userInput =
        input.kind === "start"
          ? "请开场：交代背景，描述开场场景，抛出主线钩子；并用 update_scene、set_thread、update_npc 建立初始状态。"
          : JSON.stringify({ turn: turn.n, playerId: input.playerId, playerName: player?.name, kind: input.kind, text: input.text });
      const tools = buildKpTools({ system, index, rng: this.rng, clueIds: compiled?.clues.map((c) => c.id) });
      const trace = await runAgent(this.modelFor(campaign, "main"), { system: ctx.system, parts: ctx.parts }, userInput, tools, scratch);
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

  /** Player checks from recent turns, for the push rules (see kp/tools guardRerolls). */
  private priorChecks(campaignId: string, n: number, playerIds: string[]): CheckRecord[] {
    const players = new Set(playerIds);
    return this.store
      .events(campaignId, { limit: 400 })
      .filter((e) => e.type === "roll" && typeof e.data?.turn === "number" && e.data.turn >= n - PUSH_WINDOW && e.data.turn < n)
      .flatMap((e) => checkRecords(e.data.tool, { ...e.data.result, pushed: e.data.pushed === true }, e.data.turn, (id) => players.has(id)));
  }

  directives(campaign: Campaign, turn: Turn, state: WorldState, compiled: CompiledScenario | null = null): Directive[] {
    // Compiled clues not found yet; those located in the current scene first.
    const found = new Set(state.clues.map((c) => c.ref).filter(Boolean));
    const scene = state.scene.name;
    const here = (location: string) => !!location && !!scene && (scene.includes(location) || location.includes(scene));
    const pendingClues = (compiled?.clues ?? [])
      .filter((c) => !found.has(c.id))
      .sort((a, b) => Number(here(b.location)) - Number(here(a.location)));
    const turns = this.store.turns(campaign.id, 200);
    const lastSpoke: Record<string, number> = {};
    for (const t of turns) if (t.playerId) lastSpoke[t.playerId] = t.n;
    const recentOutcomes = this.store
      .events(campaign.id, { limit: 40 })
      .filter((e) => e.type === "roll" && e.data?.result)
      // For a contest, count how it went for the players' side.
      .map((e) => (e.data.result.kind === "opposed" ? e.data.result.sides.find((s: any) => s.actor)?.outcome : e.data.result.outcome) as Outcome | undefined)
      .filter((o): o is Outcome => !!o);
    return direct({
      turn: turn.n,
      state,
      players: this.store.characters(campaign.id).map((c) => ({ id: c.playerId, name: c.name })),
      lastSpoke,
      recentOutcomes,
      settings: campaign.settings.director,
      pendingClues,
    });
  }

  // ---------------- compression ----------------
  private scheduleCompress(campaign: Campaign) {
    if (this.compressing.has(campaign.id)) return;
    const job = (async () => {
      try {
        // Up to two passes: one level-1 summary, then a possible chapter merge.
        for (let i = 0; i < 2; i++) {
          // Re-read: models may have been changed since the turn started.
          const current = this.store.getCampaign(campaign.id);
          const r = await compress(this.store, current, this.modelFor(current, "aux"));
          if (!r.level1 && !r.level2) break;
        }
        this.compressErrors.delete(campaign.id);
      } catch (e) {
        // Only our own messages are kept; a provider's raw output could contain plot.
        this.compressErrors.set(campaign.id, e instanceof PlatformError ? e.message : "摘要时发生内部错误");
        // Compression is best effort: context assembly clips recent events, and the next turn retries.
        console.error(`[compress ${campaign.id}]`, e instanceof Error ? e.message : e);
      } finally {
        this.compressing.delete(campaign.id);
      }
    })();
    this.compressing.set(campaign.id, job);
  }

  /** Compress now regardless of thresholds (manual button). Runs in the campaign queue. */
  /** Returns only whether summaries were written: their KP text would be a spoiler. */
  async compressNow(campaignId: string) {
    const campaign = this.store.getCampaign(campaignId);
    const r = await this.enqueue(campaignId, () => compress(this.store, campaign, this.modelFor(campaign, "aux"), { force: true }));
    return { level1: !!r.level1, level2: !!r.level2 };
  }

  /** Wait for queued turns and background compression of a campaign (tests, shutdown). */
  async idle(campaignId: string) {
    await this.queues.get(campaignId)?.catch(() => {});
    await this.compressing.get(campaignId);
  }
}
