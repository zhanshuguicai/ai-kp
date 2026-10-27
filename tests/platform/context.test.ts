import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkScenario } from "../../src/platform/scenario/chunker.js";
import { ScenarioIndex, terms } from "../../src/platform/scenario/retriever.js";
import { estimateTokens, clipToTokens } from "../../src/platform/context/tokens.js";
import { parseSummary } from "../../src/platform/context/compressor.js";
import { direct } from "../../src/platform/director/director.js";
import { initialState } from "../../src/platform/kp/state.js";
import { DEFAULT_SETTINGS } from "../../src/platform/storage/store.js";
import { SCENARIO, reply, scripted, setup } from "./helpers.js";

// ---------------- scenario ----------------

test("chunker keeps heading paths and recognises Chinese heading styles", () => {
  const chunks = chunkScenario(SCENARIO);
  assert.deepEqual(chunks.map((c) => c.heading), [
    "雾港停钟 / 背景",
    "雾港停钟 / 场景：钟楼",
    "雾港停钟 / 场景：码头",
    "雾港停钟 / NPC",
    "雾港停钟 / 真相",
  ]);
  const cn = chunkScenario("第一章 迷雾\n雾很浓。\n\n【场景：灯塔】\n灯塔无人。\n\n一、附录\n地图略。");
  assert.deepEqual(cn.map((c) => c.heading), ["第一章 迷雾", "第一章 迷雾 / 【场景：灯塔】", "第一章 迷雾 / 一、附录"]);
  for (const c of chunks) assert.equal(SCENARIO.slice(c.start, c.start + 5), c.text.slice(0, 5));
});

test("long text is split under the size limit without losing characters", () => {
  const long = "钟声。".repeat(2000);
  const chunks = chunkScenario(long, { target: 500, max: 800 });
  assert(chunks.length > 5);
  assert(chunks.every((c) => c.text.length <= 800));
  assert.equal(chunks.map((c) => c.text).join("").replace(/\n/g, ""), long);
});

test("bigram BM25 finds the right chunk for Chinese queries", () => {
  assert.deepEqual(terms("老秦 gear 2"), ["老秦", "gear", "2"]);
  const index = new ScenarioIndex(chunkScenario(SCENARIO).map((c) => ({ ...c, scenarioId: "s" })));
  assert.match(index.search("我去码头翻看账簿")[0].chunk.heading, /码头/);
  assert.match(index.search("守钟人老秦在哪")[0].chunk.heading, /NPC/);
  assert.deepEqual(index.search("！！！"), []);
  const picked = index.select("账簿", 60, [0]);
  assert.equal(picked[0].idx, 0, "forced chunks come first and output is in scenario order");
});

test("token estimate treats CJK as ~1 token per character", () => {
  assert.equal(estimateTokens("雾港停钟"), 4);
  assert.equal(estimateTokens("abcdefg"), 2);
  const clipped = clipToTokens("钟".repeat(100), 20);
  assert(estimateTokens(clipped) <= 25 && clipped.endsWith("（已截断）"));
});

// ---------------- director ----------------

test("director: clue drought, fail streak, clocks, long scene, quiet players, finished main thread", () => {
  const state = initialState();
  state.clocks = { 追兵: { filled: 3, size: 4, note: "" }, 仪式: { filled: 6, size: 6, note: "邪神降临" } };
  state.threads = [{ title: "主线", kind: "main", status: "done" }];
  const ds = direct({
    turn: 9,
    state,
    players: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }],
    lastSpoke: { a: 9, b: 3 },
    recentOutcomes: ["success", "failure", "critical_failure", "failure"],
    settings: DEFAULT_SETTINGS.director,
  });
  const kinds = ds.map((d) => `${d.kind}${d.target ? `:${d.target}` : ""}`);
  assert.deepEqual(kinds.sort(), ["breathe", "escalate", "escalate:仪式", "escalate:追兵", "hint", "spotlight:b", "wrap_up"].sort());
  assert.equal(ds.find((d) => d.target === "仪式")!.strength, 3);
});

test("director stays quiet when pacing is fine", () => {
  const state = initialState();
  state.lastClueTurn = 3;
  state.scene.sinceTurn = 2;
  const ds = direct({ turn: 4, state, players: [{ id: "a", name: "甲" }], lastSpoke: { a: 4 }, recentOutcomes: ["success"], settings: DEFAULT_SETTINGS.director });
  assert.deepEqual(ds, []);
});

// ---------------- compression ----------------

test("summary parsing tolerates surrounding text and rejects garbage", () => {
  assert.deepEqual(parseSummary('好的：\n{"public":"甲进了钟楼","kp":"甲进了钟楼，老秦起疑"}'), { public: "甲进了钟楼", kp: "甲进了钟楼，老秦起疑" });
  assert.throws(() => parseSummary("没有 JSON"), /有效 JSON/);
});

test("old turns are compressed automatically; the context then uses summaries instead of raw lines", async () => {
  const long = "我在雾中仔细检查每一块石砖和每一道裂缝，".repeat(8);
  const provider = scripted(
    Array.from({ length: 12 }, (_, i) => () => reply(`第${i + 1}轮的回应：雾气翻涌，钟楼静默。`.repeat(4))),
    [
      JSON.stringify({ public: "前几轮调查员在钟楼附近搜索。", kp: "KP版：前几轮搜索钟楼，老秦起疑。" }),
      JSON.stringify({ public: "第二段公开摘要", kp: "KP版第二段" }),
      JSON.stringify({ public: "第三段公开摘要", kp: "KP版第三段" }),
      JSON.stringify({ public: "章节：雾港的前半夜", kp: "KP章节：前半夜，老秦已起疑" }),
    ],
  );
  const { platform, store, campaign } = setup({
    provider,
    autoCompress: true,
    budgets: { recent: 600, summaries: 60, scenario: 2000, state: 800 },
  });
  for (let i = 1; i <= 12; i++) {
    await platform.message(campaign.id, { messageId: `m${i}`, playerId: i % 2 ? "p1" : "p2", kind: "action", text: `第${i}轮行动：${long}` });
    await platform.idle(campaign.id);
  }
  assert(provider.completions.length >= 2, "compression ran");
  assert(!provider.completions[0].includes("第12轮行动"), "the newest turn is never summarized");

  const active = store.activeSummaries(campaign.id);
  assert(active.some((s) => s.level === 2), "older summaries folded into a chapter");
  const through = store.summarizedThrough(campaign.id);
  assert(through > 0);

  // Next turn: the context holds the KP summaries, and only unsummarized events verbatim.
  const last = provider.requests[provider.requests.length - 1].system;
  assert.match(last, /## 前情摘要\n/);
  assert(last.includes(active[0].kpText));
  assert(!last.includes("第1轮行动"), "summarized raw lines are gone from the context");

  // Public view shows only public summaries.
  const pub = JSON.stringify(platform.publicView(campaign.id).summaries);
  assert(!pub.includes("KP"));
});

test("compression failure is harmless: the turn result stands and the next turn still works", async () => {
  const provider = scripted([() => reply("一"), () => reply("二"), () => reply("三")], ["不是 JSON", "也不是"]);
  const { platform, store, campaign } = setup({ provider, autoCompress: true, budgets: { recent: 10, summaries: 100, scenario: 1000, state: 500 } });
  for (const id of ["a", "b", "c"]) {
    const out = await platform.message(campaign.id, { messageId: id, playerId: "p1", kind: "auto", text: "继续调查钟楼的齿轮" });
    assert.equal(out.turn.status, "complete");
    await platform.idle(campaign.id);
  }
  assert.equal(store.activeSummaries(campaign.id).length, 0);
});
