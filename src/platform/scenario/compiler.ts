// Scenario compiler. Reads the raw scenario once with a model and produces:
//  - a KP guide (core truth, NPC secrets, numbered clues, scenes, threat clocks, endings), used only
//    in the KP model's context and never shown to the organizer or players;
//  - a spoiler-free blurb for choosing a scenario.
// Long scenarios are extracted part by part, then merged.
import { PlatformError } from "../errors.js";
import type { ModelProvider } from "../providers/types.js";
import type { ScenarioChunk } from "../storage/store.js";
import { clipToTokens, estimateTokens } from "../context/tokens.js";

export interface CompiledScenario {
  brief: string;
  npcs: { name: string; publicFace: string; secret: string; motive: string }[];
  clues: { id: string; text: string; conclusion: string; sources: string[]; location: string }[];
  scenes: { name: string; summary: string }[];
  clocks: { name: string; size: number; consequence: string }[];
  endings: { name: string; condition: string }[];
  opening: string;
}

export interface ScenarioBlurb {
  pitch: string;
  setting: string;
  players: string;
  duration: string;
  tone: string;
  contentWarnings: string[];
  recommendedSystem: string;
}

const LIMITS = { npcs: 40, clues: 80, scenes: 40, clocks: 10, endings: 10, text: 600, brief: 4000 };

const EXTRACT_SYSTEM = `你是跑团剧本分析员，为一个 AI 主持人（KP）整理剧本。只输出 JSON，不要任何解释。格式：
{
  "brief": "核心真相与主线：发生了什么、谁在背后、玩家需要查明什么、高潮如何展开（不超过 1500 字）",
  "npcs": [{"name": "", "publicFace": "玩家初见时的样子", "secret": "隐藏的真相，没有则空字符串", "motive": "动机"}],
  "clues": [{"id": "c1", "text": "线索内容", "conclusion": "这条线索指向的结论", "sources": ["获取途径，如 侦查 楼梯 / 询问 老秦 / 图书馆使用"], "location": "所在场景"}],
  "scenes": [{"name": "场景名", "summary": "这里有什么、会发生什么"}],
  "clocks": [{"name": "威胁或倒计时", "size": 4, "consequence": "满格时发生什么"}],
  "endings": [{"name": "结局名", "condition": "达成条件"}],
  "opening": "开场时玩家所处的情境与钩子"
}
要求：忠于原文，不编造；保留专有名词原文；同一结论尽量列出多条线索与多种获取途径；剧本没写的字段给空数组或空字符串。`;

const MERGE_SYSTEM = `你会收到同一个跑团剧本分段整理出的多个 JSON。把它们合并成一个，格式与输入相同。
去除重复，同一 NPC/场景只保留一条并合并信息；线索重新编号为 c1、c2…；brief 改写为全剧本的核心真相与主线。只输出 JSON。`;

const BLURB_SYSTEM = `你为一个跑团剧本写给玩家看的介绍，用来决定要不要玩它。这些人之后会作为玩家参加，绝不能剧透。只输出 JSON：
{"pitch": "一句话吸引人的介绍", "setting": "开场背景：玩家一开始就知道的时代、地点、处境（2-4 句）", "players": "建议人数，如 2-4 人", "duration": "预计时长，如 3-4 小时", "tone": "基调，如 调查、恐怖、悬疑", "contentWarnings": ["可能令人不适的内容类型，只写类别，不写情节"], "recommendedSystem": "原文使用的规则，如 克苏鲁的呼唤 第七版，未知则空字符串"}
严禁出现：幕后黑手、NPC 的秘密或真实身份、线索内容、结局、任何玩家开场时不知道的事。宁可写得模糊。`;

const str = (v: unknown, max = LIMITS.text) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export function parseJson(raw: string, what: string): any {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  throw new PlatformError("COMPILE_FORMAT", `${what}：模型没有返回有效 JSON`, 502);
}

/** Validate and cap a model's extraction. Missing fields become empty; clue ids are made unique. */
export function normalizeCompiled(v: any): CompiledScenario {
  const clues: CompiledScenario["clues"] = [];
  const seen = new Set<string>();
  for (const c of arr(v?.clues).slice(0, LIMITS.clues)) {
    const text = str(c?.text);
    if (!text) continue;
    let id = str(c?.id, 20).replace(/[^\w-]/g, "") || `c${clues.length + 1}`;
    if (seen.has(id)) id = `c${clues.length + 1}`;
    while (seen.has(id)) id += "x";
    seen.add(id);
    clues.push({
      id,
      text,
      conclusion: str(c?.conclusion),
      sources: arr(c?.sources).map((s) => str(s, 120)).filter(Boolean).slice(0, 8),
      location: str(c?.location, 120),
    });
  }
  const compiled: CompiledScenario = {
    brief: str(v?.brief, LIMITS.brief),
    npcs: arr(v?.npcs)
      .slice(0, LIMITS.npcs)
      .map((n) => ({ name: str(n?.name, 60), publicFace: str(n?.publicFace), secret: str(n?.secret), motive: str(n?.motive) }))
      .filter((n) => n.name),
    clues,
    scenes: arr(v?.scenes)
      .slice(0, LIMITS.scenes)
      .map((s) => ({ name: str(s?.name, 80), summary: str(s?.summary) }))
      .filter((s) => s.name),
    clocks: arr(v?.clocks)
      .slice(0, LIMITS.clocks)
      .map((c) => ({
        name: str(c?.name, 60),
        size: Number.isInteger(c?.size) && c.size >= 2 && c.size <= 12 ? c.size : 6,
        consequence: str(c?.consequence),
      }))
      .filter((c) => c.name),
    endings: arr(v?.endings)
      .slice(0, LIMITS.endings)
      .map((e) => ({ name: str(e?.name, 60), condition: str(e?.condition) }))
      .filter((e) => e.name),
    opening: str(v?.opening, 1500),
  };
  if (!compiled.brief && !compiled.npcs.length && !compiled.clues.length)
    throw new PlatformError("COMPILE_EMPTY", "模型没有从剧本中抽取到任何内容", 502);
  return compiled;
}

export function normalizeBlurb(v: any): ScenarioBlurb {
  return {
    pitch: str(v?.pitch, 200),
    setting: str(v?.setting, 800),
    players: str(v?.players, 40),
    duration: str(v?.duration, 40),
    tone: str(v?.tone, 80),
    contentWarnings: arr(v?.contentWarnings).map((w) => str(w, 40)).filter(Boolean).slice(0, 10),
    recommendedSystem: str(v?.recommendedSystem, 60),
  };
}

const spansOf = (s: string, n: number) => {
  const y = s.replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i + n <= y.length; i++) out.add(y.slice(i, i + n));
  return out;
};

/**
 * True when `a` and `b` share a run of at least `n` identical characters (ignoring whitespace).
 * Runs that also appear in `publicText` do not count: names and background the players are told anyway.
 */
export function sharesSpan(a: string, b: string, n = 10, publicText = ""): boolean {
  const x = a.replace(/\s+/g, "");
  if (x.length < n || b.replace(/\s+/g, "").length < n) return false;
  const spans = spansOf(b, n);
  const known = publicText ? spansOf(publicText, n) : new Set<string>();
  for (let i = 0; i + n <= x.length; i++) {
    const s = x.slice(i, i + n);
    if (spans.has(s) && !known.has(s)) return true;
  }
  return false;
}

/** What the players are told anyway: the opening, NPC names and their public faces, scene names. */
export function publicMaterial(c: CompiledScenario): string {
  return [c.opening, ...c.npcs.map((x) => `${x.name}\n${x.publicFace}`), ...c.scenes.map((x) => x.name)].join("\n");
}

/** True when `text` quotes compiled secret material verbatim (beyond what is public anyway). */
export function quotesSecret(text: string, c: CompiledScenario): boolean {
  const known = publicMaterial(c);
  return secretsOf(c).some((s) => sharesSpan(text, s, 10, known));
}

/** Secret material the blurb must not quote. */
function secretsOf(c: CompiledScenario): string[] {
  return [
    c.brief,
    ...c.npcs.flatMap((n) => [n.secret, n.motive]),
    ...c.clues.flatMap((x) => [x.text, x.conclusion]),
    ...c.endings.map((e) => e.condition),
    ...c.clocks.map((k) => k.consequence),
  ].filter((s) => s.length >= 10);
}

/** Blurb fields that quote secret material verbatim. */
export function blurbLeaks(blurb: ScenarioBlurb, compiled: CompiledScenario): (keyof ScenarioBlurb)[] {
  const fields: (keyof ScenarioBlurb)[] = ["pitch", "setting", "tone"];
  const leaky = fields.filter((f) => quotesSecret(blurb[f] as string, compiled));
  if (blurb.contentWarnings.some((w) => quotesSecret(w, compiled))) leaky.push("contentWarnings");
  return leaky;
}

/** Split chunks into parts of roughly `budget` tokens for long scenarios. */
export function partition(chunks: ScenarioChunk[], budget: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const c of chunks) {
    const piece = `〔${c.heading || "无标题"}〕\n${c.text}\n\n`;
    if (cur && estimateTokens(cur + piece) > budget) {
      parts.push(cur);
      cur = "";
    }
    cur += piece;
  }
  if (cur) parts.push(cur);
  return parts;
}

export interface CompileOptions {
  /** Above this many tokens, extract part by part. */
  partTokens?: number;
  maxTokens?: number;
}

export async function compileScenario(
  provider: ModelProvider,
  title: string,
  text: string,
  chunks: ScenarioChunk[],
  opts: CompileOptions = {},
): Promise<{ compiled: CompiledScenario; blurb: ScenarioBlurb }> {
  const partTokens = opts.partTokens ?? 100_000;
  const maxTokens = opts.maxTokens ?? 24_000;
  const ask = async (system: string, prompt: string, what: string) => {
    // One retry for malformed output; model errors (network, credits) are not retried here.
    try {
      return parseJson(await provider.complete({ system, prompt, maxTokens }), what);
    } catch (e) {
      if (!(e instanceof PlatformError) || e.code !== "COMPILE_FORMAT") throw e;
      return parseJson(await provider.complete({ system, prompt: `${prompt}\n\n（上次输出不是合法 JSON，请只输出 JSON。）`, maxTokens }), what);
    }
  };

  let compiled: CompiledScenario;
  if (estimateTokens(text) <= partTokens) {
    compiled = normalizeCompiled(await ask(EXTRACT_SYSTEM, `剧本《${title}》全文：\n\n${text}`, "剧本抽取"));
  } else {
    const parts = partition(chunks, partTokens);
    const partials: unknown[] = [];
    for (const [i, part] of parts.entries())
      partials.push(await ask(EXTRACT_SYSTEM, `剧本《${title}》第 ${i + 1}/${parts.length} 部分：\n\n${part}`, `剧本抽取（第 ${i + 1} 部分）`));
    compiled = normalizeCompiled(await ask(MERGE_SYSTEM, partials.map((p, i) => `#${i + 1}\n${JSON.stringify(p)}`).join("\n\n"), "合并"));
  }

  // The blurb is written from the opening and the extraction, not from raw text that may open with spoilers.
  const blurbPrompt = `剧本标题：《${title}》
开场（玩家已知）：${compiled.opening || "（原文未单独说明）"}
供你判断基调与内容的整理稿（这些都是秘密，不能写进介绍）：
${clipToTokens(JSON.stringify({ brief: compiled.brief, scenes: compiled.scenes, npcs: compiled.npcs.map((n) => ({ name: n.name, publicFace: n.publicFace })) }), 8000)}
原文前段（判断时代与人数用）：
${clipToTokens(text, 3000)}`;
  let blurb = normalizeBlurb(await ask(BLURB_SYSTEM, blurbPrompt, "简介"));
  let leaky = blurbLeaks(blurb, compiled);
  if (leaky.length) {
    blurb = normalizeBlurb(await ask(BLURB_SYSTEM, `${blurbPrompt}\n\n上一版简介原样引用了秘密内容（字段：${leaky.join("、")}），请重写得更模糊。`, "简介"));
    leaky = blurbLeaks(blurb, compiled);
    // Still quoting secrets: drop those fields rather than show them.
    for (const f of leaky) (blurb as any)[f] = f === "contentWarnings" ? [] : "";
  }
  return { compiled, blurb };
}

/** KP guide for the context window, within a token budget. */
export function renderGuide(c: CompiledScenario, budget: number): string {
  const lines = [
    c.brief ? `核心真相与主线：\n${c.brief}` : "",
    c.opening ? `开场：${c.opening}` : "",
    c.npcs.length
      ? `NPC（秘密只给 KP）：\n${c.npcs.map((n) => `- ${n.name}｜外在：${n.publicFace || "—"}｜秘密：${n.secret || "无"}｜动机：${n.motive || "—"}`).join("\n")}`
      : "",
    c.clues.length
      ? `线索（记录时用 record_clue 的 clueId）：\n${c.clues.map((x) => `- ${x.id}｜${x.text}｜指向：${x.conclusion || "—"}｜途径：${x.sources.join(" / ") || "—"}｜地点：${x.location || "—"}`).join("\n")}`
      : "",
    c.scenes.length ? `场景：\n${c.scenes.map((s) => `- ${s.name}：${s.summary}`).join("\n")}` : "",
    c.clocks.length ? `威胁时钟（开团时已建立）：\n${c.clocks.map((k) => `- ${k.name} ${k.size} 格：${k.consequence}`).join("\n")}` : "",
    c.endings.length ? `结局：\n${c.endings.map((e) => `- ${e.name}：${e.condition}`).join("\n")}` : "",
  ];
  return clipToTokens(lines.filter(Boolean).join("\n\n"), budget);
}

/** Offline demo: no model, so no extraction — only a clearly labelled placeholder blurb. */
export function demoCompile(title: string): { compiled: CompiledScenario; blurb: ScenarioBlurb } {
  return {
    compiled: { brief: "", npcs: [], clues: [], scenes: [], clocks: [], endings: [], opening: "" },
    blurb: {
      pitch: `《${title}》（离线演示：没有用模型编译，无简介）`,
      setting: "",
      players: "",
      duration: "",
      tone: "",
      contentWarnings: [],
      recommendedSystem: "",
    },
  };
}
