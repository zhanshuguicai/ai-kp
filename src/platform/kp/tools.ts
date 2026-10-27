// Tools the KP model may call during a turn. Every tool works on a scratch copy of the turn;
// nothing is persisted until the turn commits. Invalid arguments throw ToolInputError, which the
// agent loop returns to the model so it can fix the call.
import { PlatformError } from "../errors.js";
import type { CheckResult, OpposedResult, Rng, RuleSystem, ToolDef } from "../rules/types.js";
import { executeRuleTool, ruleToolDefs } from "../rules/registry.js";
import { RuleError, lookup, norm, objectSchema, sch } from "../rules/util.js";
import type { NewEvent, Turn } from "../storage/store.js";
import type { ScenarioIndex } from "../scenario/retriever.js";
import { clipToTokens, estimateTokens } from "../context/tokens.js";
import { MAX_KP_NOTES, type WorldState } from "./state.js";

export class ToolInputError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const bad = (message: string, code = "INVALID_ARGS"): never => {
  throw new ToolInputError(code, message);
};

export interface Player {
  id: string;
  name: string;
}

export interface TurnScratch {
  turn: Turn;
  state: WorldState;
  sheets: Record<string, unknown>;
  players: Player[];
  events: NewEvent[];
  reply?: { text: string; whispers: { playerId: string; text: string }[] };
  /** Player checks from recent turns (for validating pushed rolls). */
  priorChecks?: CheckRecord[];
  /** Player checks made so far in this turn. */
  checks?: CheckRecord[];
}

/** One player's check, as remembered for the re-roll rules. */
export interface CheckRecord {
  actor: string;
  stat: string;
  failed: boolean;
  pushed: boolean;
  turn: number;
}

/** Turns back a failed check can still be pushed (other players' turns may come in between). */
export const PUSH_WINDOW = 6;
const CHECK_TOOLS = new Set(["check", "opposed_check"]);

/** Player checks contained in a rule tool result. */
export function checkRecords(tool: string, result: any, turn: number, isPlayer: (id: string) => boolean): CheckRecord[] {
  if (!CHECK_TOOLS.has(tool) || !result) return [];
  const sides: CheckResult[] = result.kind === "opposed" ? result.sides : [result];
  return sides
    .filter((r) => typeof r.actor === "string" && isPlayer(r.actor))
    .map((r) => ({
      actor: r.actor!,
      stat: norm(r.stat),
      failed: r.outcome === "failure" || r.outcome === "critical_failure",
      pushed: tool === "check" && result.pushed === true,
      turn,
    }));
}

export interface KpTool {
  def: ToolDef;
  /** Dice tools are kept even if the turn fails, because their results were already decided. */
  dice?: boolean;
  run(args: Record<string, unknown>, scratch: TurnScratch): unknown;
}

const text = (v: unknown, field: string, max = 2000): string => {
  if (typeof v !== "string" || !v.trim()) bad(`${field} 需要非空文本`);
  if ((v as string).length > max) bad(`${field} 最多 ${max} 字符`);
  return (v as string).trim();
};
const nullableText = (v: unknown, field: string, max = 2000) =>
  v === null || v === undefined || v === "" ? undefined : text(v, field, max);

function event(scratch: TurnScratch, e: Omit<NewEvent, "turnId">) {
  scratch.events.push({ ...e, turnId: scratch.turn.id });
}

/** Apply a suggested sheet change (e.g. SAN -3) to a numeric field, top level or inside a stat map. */
export function applyEffect(sheet: unknown, field: string, delta: number): boolean {
  if (typeof sheet !== "object" || sheet === null) return false;
  const s = sheet as Record<string, any>;
  const top = lookup(s, field);
  if (top && typeof top.value === "number") {
    s[top.key] = Math.max(0, top.value + delta);
    return true;
  }
  for (const map of ["skills", "traits", "stats", "modifiers"]) {
    const hit = lookup(s[map], field);
    if (hit && typeof hit.value === "number") {
      s[map][hit.key] = Math.max(0, hit.value + delta);
      return true;
    }
  }
  return false;
}

function ruleTool(system: RuleSystem<any>, def: ToolDef, rng: Rng): KpTool {
  const params = def.parameters as { properties: Record<string, unknown>; required: string[] };
  return {
    dice: true,
    def: {
      ...def,
      parameters: objectSchema({
        ...params.properties,
        secret: sch.nbool("暗骰：true 时结果只给 KP，不公开"),
      }),
    },
    run(args, scratch) {
      const { secret, ...rest } = args;
      const isPlayer = (id: unknown) => typeof id === "string" && scratch.players.some((p) => p.id === id);
      const nameOf = (id: unknown) => scratch.players.find((p) => p.id === id)?.name;
      // Opposed sides that are players are shown by name.
      if (def.name === "opposed_check")
        for (const k of ["a", "b"]) {
          const side = rest[k] as Record<string, unknown> | null;
          if (side && typeof side === "object" && isPlayer(side.actor) && !side.label) rest[k] = { ...side, label: nameOf(side.actor) };
        }
      const out = executeRuleTool(system, def.name, rest, { sheets: scratch.sheets, rng });
      if (!out.ok) throw new ToolInputError(out.error.code, out.error.message);
      const pushed = def.name === "check" && rest.pushed === true;
      const records = checkRecords(def.name, { ...(out.result as object), pushed }, scratch.turn.n, isPlayer);
      // Validate before anything is recorded, so a rejected roll leaves no trace and the model never sees it.
      guardRerolls(records, pushed, rest.actor, scratch);
      scratch.checks = [...(scratch.checks ?? []), ...records];

      const result = out.result as { summary: string };
      const opposed = (out.result as { kind?: string }).kind === "opposed" ? (out.result as OpposedResult) : null;
      const actor = opposed ? (opposed.sides.find((x) => isPlayer(x.actor))?.actor ?? null) : typeof rest.actor === "string" ? rest.actor : null;
      const who = opposed ? null : actor ? (nameOf(actor) ?? actor) : null;
      const visibility = secret === true ? "kp" : "public";
      event(scratch, {
        type: "roll",
        actor,
        visibility,
        text: `${who ? `${who}：` : ""}${result.summary}`,
        data: { tool: def.name, result, turn: scratch.turn.n, pushed },
      });
      // Players see that a hidden roll happened, not what it was for or how it went.
      if (secret === true)
        event(scratch, { type: "roll", actor, visibility: "public", text: `KP 进行了一次暗骰${who ? `（${who}）` : ""}`, data: { secret: true } });
      const applied: string[] = [];
      const effects = opposed ? [] : ((out.result as CheckResult).effects ?? []);
      for (const e of effects) {
        if (!Object.hasOwn(scratch.sheets, e.actor)) continue;
        if (applyEffect(scratch.sheets[e.actor], e.field, e.delta)) {
          applied.push(`${e.field}${e.delta >= 0 ? "+" : ""}${e.delta}`);
          event(scratch, {
            type: "state",
            actor: e.actor,
            visibility,
            text: `${who ?? e.actor} ${e.field} ${e.delta >= 0 ? "+" : ""}${e.delta}`,
            data: { effect: e },
          });
        }
      }
      return { ...result, appliedEffects: applied, visibility };
    },
  };
}

/**
 * The model decides checks, so it must not be able to fish for a better result:
 * one roll per character and skill per turn, and a push only when that player chose it.
 */
function guardRerolls(records: CheckRecord[], pushed: boolean, actor: unknown, scratch: TurnScratch) {
  for (const r of records) {
    const name = scratch.players.find((p) => p.id === r.actor)?.name ?? r.actor;
    if (scratch.checks?.some((c) => c.actor === r.actor && c.stat === r.stat))
      bad(
        `本轮已经为${name}检定过这项技能，结果不能重掷。一个行动只检定一次；需要再试时，在回复里说明后果并等玩家下一次发言自己选择（如孤注一掷）。`,
        "ALREADY_ROLLED",
      );
  }
  if (!pushed) return;
  if (typeof actor !== "string" || !scratch.players.some((p) => p.id === actor)) bad("只有玩家角色可以孤注一掷", "PUSH_NOT_ALLOWED");
  if (scratch.turn.playerId !== actor)
    bad("孤注一掷必须由该玩家自己在本次发言中选择；请在回复里询问，等该玩家回答", "PUSH_NOT_ALLOWED");
  const r = records[0];
  const prior = (scratch.priorChecks ?? []).filter((c) => c.actor === r.actor && c.stat === r.stat && c.turn >= scratch.turn.n - PUSH_WINDOW);
  const last = prior[prior.length - 1];
  if (last?.pushed) bad("这项检定已经孤注一掷过，不能再次尝试", "PUSH_NOT_ALLOWED");
  if (!last?.failed) bad("最近没有这项技能的失败检定，无法孤注一掷", "PUSH_NOT_ALLOWED");
}

export function buildKpTools(opts: {
  system: RuleSystem<any>;
  index: ScenarioIndex;
  rng: Rng;
  /** Clue ids from the compiled scenario, for record_clue's clueId. */
  clueIds?: string[];
}): KpTool[] {
  const { system, index, rng } = opts;
  const clueIds = new Set(opts.clueIds ?? []);
  const rules = ruleToolDefs(system).map((d) => ruleTool(system, d, rng));
  const story: KpTool[] = [
    {
      def: {
        name: "query_scenario",
        description: "检索剧本原文。query 写关键词（地点、NPC、物品、事件）；也可用 chunk 按编号读取某一段。仅供 KP 参考，不要原样念出秘密。",
        parameters: objectSchema({
          query: sch.nstr("检索关键词，可为 null"),
          chunk: sch.nint("要读取的段落编号，可为 null"),
        }),
      },
      run(args) {
        const chunk = args.chunk;
        if (typeof chunk === "number") {
          const found = index.byIdx(chunk);
          if (!found) return bad(`没有编号为 ${chunk} 的段落（共 ${index.size} 段）`);
          return { chunks: [{ idx: found.idx, heading: found.heading, text: found.text }] };
        }
        const query = text(args.query, "query", 200);
        const hits = index.search(query, 4);
        if (!hits.length) return { chunks: [], note: "没有匹配的段落，换个关键词试试" };
        let budget = 3000;
        return {
          chunks: hits.map(({ chunk: c }) => {
            const t = clipToTokens(c.text, Math.max(200, budget));
            budget = Math.max(0, budget - estimateTokens(t));
            return { idx: c.idx, heading: c.heading, text: t };
          }),
        };
      },
    },
    {
      def: {
        name: "update_scene",
        description: "切换或更新当前场景。换场景时 name 用新场景名。",
        parameters: objectSchema({
          name: sch.str("场景名，如 钟楼底层"),
          description: sch.nstr("一句话的公开描述，可为 null"),
        }),
      },
      run(args, scratch) {
        const name = text(args.name, "name", 80);
        const description = nullableText(args.description, "description", 500) ?? "";
        const changed = name !== scratch.state.scene.name;
        scratch.state.scene = {
          name,
          description,
          sinceTurn: changed ? scratch.turn.n : scratch.state.scene.sinceTurn,
        };
        event(scratch, { type: "state", actor: null, visibility: "public", text: `场景：${name}`, data: { scene: scratch.state.scene } });
        return { ok: true, changed };
      },
    },
    {
      def: {
        name: "record_clue",
        description: "记录玩家刚刚获得的线索（玩家已知的内容）。同一条线索不要重复记录。",
        parameters: objectSchema({
          text: sch.str("线索内容，以玩家视角描述"),
          clueId: sch.nstr("剧本整理中的线索编号（如 c3），对应不上则为 null"),
          foundBy: { type: ["array", "null"], items: { type: "string" }, description: "发现者玩家 id 列表，可为 null" },
        }),
      },
      run(args, scratch) {
        const clue = text(args.text, "text", 500);
        if (scratch.state.clues.some((c) => c.text === clue)) bad("这条线索已经记录过");
        const ref = nullableText(args.clueId, "clueId", 20);
        if (ref !== undefined) {
          if (!clueIds.has(ref)) bad(`没有编号为 ${ref} 的线索${clueIds.size ? `；可用编号：${[...clueIds].slice(0, 30).join("、")}` : "（本剧本没有线索编号）"}`);
          if (scratch.state.clues.some((c) => c.ref === ref)) bad(`线索 ${ref} 已经记录过`);
        }
        const foundBy = Array.isArray(args.foundBy) ? args.foundBy.filter((x): x is string => typeof x === "string") : [];
        for (const id of foundBy)
          if (!scratch.players.some((p) => p.id === id)) bad(`foundBy 中的 ${id} 不是本团玩家`);
        scratch.state.clues.push({ id: `c${scratch.state.clues.length + 1}`, text: clue, foundBy, turn: scratch.turn.n, ...(ref ? { ref } : {}) });
        scratch.state.lastClueTurn = scratch.turn.n;
        event(scratch, { type: "state", actor: null, visibility: "public", text: `获得线索：${clue}`, data: { clue } });
        return { ok: true, totalClues: scratch.state.clues.length };
      },
    },
    {
      def: {
        name: "update_npc",
        description: "更新 NPC 的公开状态与对玩家的态度。NPC 的秘密写 note_secret。",
        parameters: objectSchema({
          name: sch.str("NPC 名"),
          status: sch.str("当前公开状态，如 在码头等待、受伤、已离开"),
          attitude: sch.nstr("对玩家的态度，如 友好、警惕、敌对；可为 null"),
        }),
      },
      run(args, scratch) {
        const name = text(args.name, "name", 60);
        const prev = scratch.state.npcs[name];
        scratch.state.npcs[name] = {
          status: text(args.status, "status", 300),
          attitude: nullableText(args.attitude, "attitude", 60) ?? prev?.attitude ?? "",
          lastSeenTurn: scratch.turn.n,
        };
        event(scratch, { type: "state", actor: null, visibility: "public", text: `NPC ${name}：${scratch.state.npcs[name].status}`, data: { npc: name } });
        return { ok: true };
      },
    },
    {
      def: {
        name: "set_thread",
        description: "新增或更新一条剧情线（主线/支线）的状态。按 title 匹配已有剧情线。",
        parameters: objectSchema({
          title: sch.str("剧情线标题"),
          kind: { type: "string", enum: ["main", "side"], description: "main 主线 / side 支线" },
          status: { type: "string", enum: ["open", "done", "failed"], description: "进行中 / 完成 / 失败" },
        }),
      },
      run(args, scratch) {
        const title = text(args.title, "title", 120);
        if (!["main", "side"].includes(args.kind as string)) bad("kind 只能是 main 或 side");
        if (!["open", "done", "failed"].includes(args.status as string)) bad("status 只能是 open / done / failed");
        const existing = scratch.state.threads.find((t) => t.title === title);
        const next = { title, kind: args.kind as "main" | "side", status: args.status as "open" | "done" | "failed" };
        if (existing) Object.assign(existing, next);
        else scratch.state.threads.push(next);
        event(scratch, { type: "state", actor: null, visibility: "public", text: `剧情线「${title}」：${next.status}`, data: { thread: next } });
        return { ok: true };
      },
    },
    {
      def: {
        name: "advance_clock",
        description: "推进威胁时钟（仅 KP 可见）：反派计划、倒计时、追兵逼近等。首次使用时用 size 设定格数。时钟满格时要在剧情中兑现。",
        parameters: objectSchema({
          name: sch.str("时钟名，如 走私船离港"),
          delta: sch.int("推进格数，可为负数表示延缓"),
          size: sch.nint("总格数（新建时填，常用 4/6/8），否则 null"),
          note: sch.nstr("满格时会发生什么，可为 null"),
        }),
      },
      run(args, scratch) {
        const name = text(args.name, "name", 60);
        if (!Number.isInteger(args.delta) || Math.abs(args.delta as number) > 12) bad("delta 需要 -12 到 12 的整数");
        const existing = scratch.state.clocks[name];
        const size = typeof args.size === "number" ? args.size : existing?.size;
        if (!size || !Number.isInteger(size) || size < 2 || size > 12) bad("新时钟需要 size（2-12）");
        const filled = Math.min(size!, Math.max(0, (existing?.filled ?? 0) + (args.delta as number)));
        scratch.state.clocks[name] = { filled, size: size!, note: nullableText(args.note, "note", 300) ?? existing?.note ?? "" };
        event(scratch, { type: "state", actor: null, visibility: "kp", text: `时钟 ${name} ${filled}/${size}`, data: { clock: name } });
        return { filled, size, full: filled >= size! };
      },
    },
    {
      def: {
        name: "set_tension",
        description: "记录当前紧张度（0 平静 … 5 高潮），节奏导演据此给建议。",
        parameters: objectSchema({ level: sch.int("0-5"), reason: sch.str("简短原因") }),
      },
      run(args, scratch) {
        if (!Number.isInteger(args.level) || (args.level as number) < 0 || (args.level as number) > 5) bad("level 需要 0-5 的整数");
        scratch.state.tension = args.level as number;
        event(scratch, { type: "state", actor: null, visibility: "kp", text: `紧张度 ${args.level}：${text(args.reason, "reason", 200)}`, data: {} });
        return { ok: true };
      },
    },
    {
      def: {
        name: "note_secret",
        description: "写一条 KP 私密笔记：未公开的真相、NPC 动机、玩家尚未发现的变化、之后要兑现的伏笔。",
        parameters: objectSchema({ text: sch.str("笔记内容") }),
      },
      run(args, scratch) {
        const note = text(args.text, "text", 1000);
        scratch.state.kpNotes.push(note);
        if (scratch.state.kpNotes.length > MAX_KP_NOTES) scratch.state.kpNotes.shift();
        event(scratch, { type: "note", actor: null, visibility: "kp", text: note, data: {} });
        return { ok: true };
      },
    },
    {
      def: {
        name: "reply",
        description: "结束本轮并给出公开回复。必须是本轮最后一个工具。可附带只给某位玩家的私聊（whispers）。",
        parameters: objectSchema({
          text: sch.str("对全体玩家的公开叙述与回应"),
          whispers: {
            type: ["array", "null"],
            items: objectSchema({ playerId: sch.str("玩家 id"), text: sch.str("只给该玩家的内容") }),
            description: "私聊列表，可为 null",
          },
        }),
      },
      run(args, scratch) {
        const reply = text(args.text, "text", 8000);
        const whispers: { playerId: string; text: string }[] = [];
        if (Array.isArray(args.whispers))
          for (const w of args.whispers) {
            const pid = (w as any)?.playerId;
            if (!scratch.players.some((p) => p.id === pid)) bad(`私聊对象 ${String(pid)} 不是本团玩家`);
            whispers.push({ playerId: pid, text: text((w as any).text, "whispers.text", 4000) });
          }
        scratch.reply = { text: reply, whispers };
        return { ok: true };
      },
    },
  ];
  return [...rules, ...story];
}

export function toolErrorPayload(e: unknown): { code: string; message: string } | undefined {
  if (e instanceof ToolInputError || e instanceof RuleError) return { code: e.code, message: e.message };
  if (e instanceof PlatformError && e.status < 500) return { code: e.code, message: e.message };
  return undefined;
}

