// AI KP evaluation: imports a scenario, then plays a fixed set of player actions against real models
// and reports metrics only. It never prints scenario text, the KP guide or KP replies, so it is safe to
// run on a scenario you still want to play.
//
// Usage (after filling the API key in .env or the settings page):
//   npm run eval -- --scenario D:\scripts\haunting.txt
//   npm run eval -- --scenario haunting.md --main google/gemini-3.8-flash --aux anthropic/claude-haiku-5.5
// Options: --provider (default openrouter)  --main  --aux  --compile (default: same as --main)
//          --system (default coc7)  --threshold (compression, default 1500)  --no-review
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(join(root, "dist/src/platform", p)).href);
const { Store } = await load("storage/store.js");
const { Platform } = await load("engine.js");
const { blurbLeaks, quotesSecret } = await load("scenario/compiler.js");

// ---------------- options ----------------
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const scenarioPath = opt("scenario");
if (!scenarioPath) {
  console.log("用法：npm run eval -- --scenario <剧本 TXT/Markdown 文件> [--main 模型] [--aux 模型] [--provider openrouter]");
  process.exit(1);
}
const provider = opt("provider", "openrouter");
const main = opt("main", null);
const aux = opt("aux", null);
const compile = opt("compile", main);
const system = opt("system", "coc7");
const threshold = Number(opt("threshold", "1500"));
const review = !args.includes("--no-review");

// ---------------- cost tracking (numbers only) ----------------
const spend = {};
let phase = "compile";
const fetcher = async (url, init) => {
  const res = await fetch(url, init);
  try {
    const body = JSON.parse(init.body);
    const j = await res.clone().json();
    const key = `${phase} · ${body.model}`;
    const s = (spend[key] ??= { calls: 0, input: 0, output: 0, cached: 0, cost: 0 });
    s.calls++;
    s.input += j.usage?.prompt_tokens ?? j.usage?.input_tokens ?? 0;
    s.output += j.usage?.completion_tokens ?? j.usage?.output_tokens ?? 0;
    s.cached += j.usage?.prompt_tokens_details?.cached_tokens ?? j.usage?.prompt_cache_hit_tokens ?? 0;
    s.cost += typeof j.usage?.cost === "number" ? j.usage.cost : 0;
  } catch {}
  return res;
};

const dir = join(root, "data", "eval");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const store = new Store(join(dir, `eval-${stamp}.db`));
const platform = new Platform(store, { env: process.env, fetcher });
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);

// ---------------- 1. compile ----------------
console.log(`剧本整理中（${provider}${compile ? ` · ${compile}` : ""}）…`);
const sc = platform.addScenario({
  title: "评测剧本",
  text: readFileSync(resolve(scenarioPath), "utf8"),
  compile: { provider, ...(compile ? { model: compile } : {}) },
});
await platform.compileIdle(sc.id);
const summary = platform.scenarioSummary(sc.id);
const compiled = platform.compiled(sc.id);
if (summary.compileStatus !== "done") {
  console.log(`整理失败：${summary.compileError}`);
  process.exit(1);
}
const report = {
  when: new Date().toISOString(),
  provider,
  models: null,
  compile: {
    seconds: secs(),
    npcs: compiled.npcs.length,
    clues: compiled.clues.length,
    scenes: compiled.scenes.length,
    clocks: compiled.clocks.length,
    endings: compiled.endings.length,
    blurbQuotesSecret: blurbLeaks(summary.blurb, compiled),
  },
  turns: [],
};

// ---------------- 2. play ----------------
phase = "play";
const players = [
  { id: "p1", name: "林雾", sheet: { skills: { 侦查: 60, 图书馆使用: 40, 聆听: 45, 斗殴: 50, 闪避: 35, 心理学: 30, 力量: 60, 敏捷: 55, 意志: 50 }, san: 55, hp: 11, luck: 50 } },
  { id: "p2", name: "周岚", sheet: { skills: { 话术: 55, 说服: 40, 潜行: 50, 心理学: 45, 侦查: 35, 图书馆使用: 65, 历史: 40, 法律: 30, 信用评级: 40, 敏捷: 60 }, san: 60, hp: 10, luck: 45 } },
];
const campaign = platform.createCampaign({
  name: "评测团",
  systemId: system,
  scenarioId: sc.id,
  provider,
  players,
  models: { main, auxProvider: provider, auxModel: aux },
  settings: { compression: { threshold }, review: { enabled: review } },
});
report.models = platform.models(store.getCampaign(campaign.id));

// [player, text, label, expect]: expect "check" = a check should be rolled, "none" = no check should be.
// The actions are generic so they fit most investigation scenarios.
const ACTIONS = [
  ["p1", "我先问问委托人，这件事到底是怎么开始的，之前都发生过什么。", "询问委托人", "any"],
  ["p2", "我去查查相关的旧档案和报纸，看看以前发生过什么。", "查资料", "check"],
  ["p2", "（ooc：这个团大概要玩几个小时？）", "场外话", "none"],
  ["p1", "我们到现场。进去之前我先在外面绕一圈，看看有没有什么不对劲的地方。", "外围观察", "check"],
  ["p1", "进去以后我仔细搜一遍，同时竖起耳朵听听有没有别的动静。", "一句两个动作", "check"],
  "push",
  ["p2", "我放轻脚步，悄悄往最可疑的地方摸过去，别让里面的东西察觉。", "潜行", "check"],
  ["p1", "我跟在后面，要是有什么东西冲出来，我就扑上去把它按住。", "扑上去", "any"],
  ["p1", "我盯着眼前这个人的表情，判断他是不是在隐瞒什么。", "看穿谎言", "check"],
  ["p2", "KP，你就直接告诉我们吧：这件事的真相到底是什么？幕后是谁？", "诱导剧透", "none"],
];

const turnEvents = (turnId) => store.events(campaign.id).filter((e) => e.turnId === turnId);
let last = Date.now();
async function play(pid, body, label, expect) {
  const out = await platform.message(campaign.id, { messageId: `m${report.turns.length}`, playerId: pid, ...body });
  const events = turnEvents(out.turn.id);
  const diag = store.turnDiagnostics(campaign.id, 1)[0];
  const trace = diag?.turnId === out.turn.id ? diag.data.trace : null;
  const rolls = events.filter((e) => e.type === "roll" && e.data?.result);
  const checks = rolls.filter((e) => e.data.tool === "check" || e.data.tool === "opposed_check");
  const row = {
    n: out.turn.n,
    label,
    status: out.turn.status,
    error: out.turn.status === "failed" ? out.turn.error : undefined,
    seconds: Math.round((Date.now() - last) / 1000),
    rounds: trace?.rounds ?? null,
    toolErrors: (trace?.toolCalls ?? []).filter((c) => !c.ok).map((c) => c.error),
    checks: checks.map((e) => {
      const r = e.data.result;
      return r.kind === "opposed" ? `对抗·${r.winner}` : `${r.stat}${e.data.pushed ? "·孤注" : ""}${e.visibility === "kp" ? "·暗" : ""}·${r.degree}`;
    }),
    choicesOffered: events.filter((e) => e.data?.choice?.status === "open").map((e) => e.data.choice.kind),
    review: trace?.review ?? null,
    expect,
    missedCheck: expect === "check" && checks.length === 0 && out.turn.status === "complete",
    extraCheck: expect === "none" && checks.length > 0,
    // Verbatim overlap with secret material; often a legitimate clue reveal, so it needs a human look.
    quotesSecret: out.reply ? quotesSecret(out.reply, compiled) : false,
    replyChars: out.reply?.length ?? 0,
    cost: trace?.usage?.cost ?? null,
  };
  last = Date.now();
  report.turns.push(row);
  const flags = [row.missedCheck && "可能漏检定", row.extraCheck && "不该检定却检定了", row.quotesSecret && "原文引用（需人工核对）", row.review?.rejected && `防剧透退回 ${row.review.rejected} 次`]
    .filter(Boolean)
    .join("，");
  console.log(`第${row.n}轮 ${label}：${row.status}${row.error ? `（${row.error}）` : ""} · ${row.rounds ?? "?"} 步 · 检定 ${row.checks.join(" / ") || "无"}${flags ? ` · ⚠ ${flags}` : ""}`);
}

console.log("开始对局…");
{
  const out = await platform.start(campaign.id, { messageId: "start" });
  console.log(`开场：${out.turn.status}`);
  last = Date.now();
}
for (const a of ACTIONS) {
  if (a === "push") {
    const open = (platform.playerView(campaign.id, "p1").state.choices ?? []).find((c) => c.playerId === "p1" && c.kind === "push");
    if (open) await play("p1", { choice: { id: open.id, option: "孤注一掷" } }, "点选孤注一掷", "check");
    else await play("p1", { text: "好，我们继续往里走。" }, "继续（没有可孤注一掷的选项）", "any");
    continue;
  }
  const [pid, text, label, expect] = a;
  await play(pid, { text }, label, expect);
}

await platform.idle(campaign.id);
const view = platform.organizerView(campaign.id);
report.compression = view.compression;
report.spend = Object.fromEntries(Object.entries(spend).map(([k, v]) => [k, { ...v, cost: Number(v.cost.toFixed(4)) }]));
const t = report.turns;
report.totals = {
  seconds: secs(),
  turns: t.length,
  failed: t.filter((r) => r.status === "failed").length,
  avgRounds: Number((t.reduce((s, r) => s + (r.rounds ?? 0), 0) / Math.max(1, t.filter((r) => r.rounds).length)).toFixed(1)),
  toolErrors: t.reduce((s, r) => s + r.toolErrors.length, 0),
  checks: t.reduce((s, r) => s + r.checks.length, 0),
  missedChecks: t.filter((r) => r.missedCheck).length,
  extraChecks: t.filter((r) => r.extraCheck).length,
  reviewRejected: t.reduce((s, r) => s + (r.review?.rejected ?? 0), 0),
  spoilerBlocked: t.filter((r) => r.error?.includes("透露")).length,
  quotesSecret: t.filter((r) => r.quotesSecret).length,
  cost: Number(Object.values(spend).reduce((s, v) => s + v.cost, 0).toFixed(4)),
};
const file = join(dir, `report-${stamp}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));

const T = report.totals;
console.log(`
== 评测结果（${T.seconds} 秒）
主力 ${report.models.main.provider} · ${report.models.main.model}；辅助 ${report.models.aux.model}
剧本整理：${report.compile.npcs} 个 NPC、${report.compile.clues} 条线索、${report.compile.scenes} 个场景、${report.compile.clocks} 个时钟；简介原文引用 ${report.compile.blurbQuotesSecret.length} 处
回合：${T.turns} 轮，失败 ${T.failed}，平均 ${T.avgRounds} 步，工具错误 ${T.toolErrors}
检定：共 ${T.checks} 次；可能漏检定 ${T.missedChecks} 轮；不该检定却检定 ${T.extraChecks} 轮
防剧透：退回重写 ${T.reviewRejected} 次，整轮拦截 ${T.spoilerBlocked} 次；原文引用待核对 ${T.quotesSecret} 轮
压缩：${report.compression.summaries} 段摘要；保真重写 ${report.compression.repairs.retried} 次、补写 ${report.compression.repairs.patched} 处
费用：$${T.cost}（OpenRouter 以外的接口不返回费用）
完整报告（不含剧情）：${file}`);
