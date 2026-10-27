import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blurbLeaks,
  compileScenario,
  normalizeCompiled,
  partition,
  renderGuide,
  sharesSpan,
  quotesSecret,
} from "../../src/platform/scenario/compiler.js";
import { chunkScenario } from "../../src/platform/scenario/chunker.js";
import { Platform } from "../../src/platform/engine.js";
import { Store } from "../../src/platform/storage/store.js";
import type { WorldState } from "../../src/platform/kp/state.js";
import { SCENARIO, calls, lastToolResults, reply, scripted, setup } from "./helpers.js";

// Distinctive secrets inside the compiled guide.
const SECRET = {
  npc: "老秦拆下了顶层齿轮藏在床板下面",
  clue: "账簿第七页记着无名货船的卸货时刻",
  truth: "走私者把钟声当作卸货暗号已经三年",
  clockConsequence: "走私船离港带走全部证据",
};

const EXTRACTED = {
  brief: `${SECRET.truth}。守钟人为阻止他们拆下齿轮。`,
  npcs: [
    { name: "老秦", publicFace: "沉默的守钟人", secret: SECRET.npc, motive: "阻止走私" },
    { name: "阿澄", publicFace: "焦急的信使", secret: "", motive: "找回信" },
  ],
  clues: [
    { id: "c1", text: "楼梯上有新鲜的泥脚印", conclusion: "有人夜里上过钟楼", sources: ["侦查 楼梯"], location: "钟楼" },
    { id: "c2", text: SECRET.clue, conclusion: "货船与停钟有关", sources: ["会计", "询问 码头工人"], location: "码头" },
  ],
  scenes: [{ name: "钟楼", summary: "铜屑与脚印" }, { name: "码头", summary: "账簿与货船" }],
  clocks: [{ name: "走私船离港", size: 6, consequence: SECRET.clockConsequence }],
  endings: [{ name: "真相大白", condition: "揭露走私并修好钟" }],
  opening: "调查员们受信使阿澄之托来到停摆的钟楼下。",
};
const BLURB = {
  pitch: "雾港的钟停了，一封信不见了。",
  setting: "1920 年代的港口小城，你们受托寻找一封遗失的信。",
  players: "2-4 人",
  duration: "3 小时",
  tone: "调查、悬疑",
  contentWarnings: ["轻度惊悚"],
  recommendedSystem: "克苏鲁的呼唤 第七版",
};

const chunks = () => chunkScenario(SCENARIO).map((c) => ({ ...c, scenarioId: "s" }));
const compiler = (outputs: unknown[]) => scripted([], outputs.map((o) => (typeof o === "string" ? o : JSON.stringify(o))));

// ---------------- compiler unit tests ----------------

test("compile: extraction and blurb are parsed and normalized", async () => {
  const p = compiler([`好的，结果如下：\n${JSON.stringify(EXTRACTED)}`, BLURB]);
  const { compiled, blurb } = await compileScenario(p, "雾港停钟", SCENARIO, chunks());
  assert.equal(compiled.npcs[0].secret, SECRET.npc);
  assert.deepEqual(compiled.clues.map((c) => c.id), ["c1", "c2"]);
  assert.equal(compiled.clocks[0].size, 6);
  assert.deepEqual(blurb, BLURB);
  assert.equal(p.completions.length, 2);
  // The blurb prompt is built from the opening and extraction, marked as secret material.
  assert.match(p.completions[1], /这些都是秘密/);
});

test("compile: a blurb that quotes secrets is rewritten once, then the leaky field is dropped", async () => {
  const leaky = { ...BLURB, setting: `其实${SECRET.npc}，没人知道。` };
  const p = compiler([EXTRACTED, leaky, leaky]);
  const { blurb } = await compileScenario(p, "雾港停钟", SCENARIO, chunks());
  assert.equal(p.completions.length, 3, "one retry");
  assert.match(p.completions[2], /原样引用了秘密内容（字段：setting）/);
  assert.equal(blurb.setting, "", "still leaking: dropped");
  assert.equal(blurb.pitch, BLURB.pitch);

  const fixed = compiler([EXTRACTED, leaky, BLURB]);
  assert.equal((await compileScenario(fixed, "雾港停钟", SCENARIO, chunks())).blurb.setting, BLURB.setting);
});

test("compile: long scenarios are extracted part by part and merged", async () => {
  // A tiny part budget forces several parts.
  const parts = partition(chunks(), 120).length;
  assert(parts >= 2, `expected several parts, got ${parts}`);
  const partials = Array.from({ length: parts }, (_, i) => ({ brief: `第${i + 1}部分` }));
  const p = compiler([...partials, EXTRACTED, BLURB]);
  const { compiled } = await compileScenario(p, "雾港停钟", SCENARIO, chunks(), { partTokens: 120 });
  const extractCalls = p.completions.filter((c) => c.includes("部分："));
  assert.equal(extractCalls.length, parts);
  assert.match(extractCalls[0], new RegExp(`第 1/${parts} 部分`));
  assert(p.completions.some((c) => c.startsWith("#1\n")), "merge call receives the partial JSONs");
  assert.equal(compiled.npcs.length, 2);
});

test("compile: malformed JSON is retried once, then reported without model text", async () => {
  const ok = compiler(["不是 JSON", EXTRACTED, BLURB]);
  assert.equal((await compileScenario(ok, "t", SCENARIO, chunks())).compiled.clues.length, 2);
  const bad = compiler(["不是 JSON", "还不是"]);
  await assert.rejects(compileScenario(bad, "t", SCENARIO, chunks()), (e: any) => e.code === "COMPILE_FORMAT" && !e.message.includes("还不是"));
});

test("normalize: caps sizes, fixes duplicate clue ids, rejects empty output", () => {
  const c = normalizeCompiled({
    brief: "真相",
    clues: [{ id: "c1", text: "甲" }, { id: "c1", text: "乙" }, { text: "丙" }, { id: "c<script>", text: "丁" }, { text: "" }],
    clocks: [{ name: "钟", size: 99 }],
    npcs: [{ name: "" }, { name: "老秦", secret: "x".repeat(2000) }],
  });
  assert.equal(new Set(c.clues.map((x) => x.id)).size, 4);
  assert.equal(c.clues[3].id, "cscript");
  assert.equal(c.clocks[0].size, 6, "invalid size falls back");
  assert.equal(c.npcs.length, 1);
  assert.equal(c.npcs[0].secret.length, 600);
  assert.throws(() => normalizeCompiled({}), /没有从剧本中抽取到任何内容/);
});

test("the leak check ignores names and background the players are told anyway", () => {
  const c = {
    brief: "委托人陈三（Chen San）其实早已知道灯塔下的尸体是谁",
    npcs: [{ name: "陈三（Chen San）", publicFace: "药铺掌柜", secret: "", motive: "" }],
    clues: [],
    scenes: [],
    clocks: [],
    endings: [],
    opening: "1926年秋天的望潮镇，陈三（Chen San）请你们去灯塔看看",
  } as any;
  assert(!quotesSecret("药铺掌柜陈三（Chen San）搓着手说话", c), "a name from the opening is not a leak");
  assert(!quotesSecret("1926年秋天的望潮镇，海风很大", c));
  assert(quotesSecret("其实早已知道灯塔下的尸体是谁", c), "the secret part still counts");
});

test("sharesSpan and blurbLeaks detect verbatim quotes only", () => {
  assert(sharesSpan("前言老秦拆下了顶层齿轮藏在床板下面后记", SECRET.npc));
  assert(!sharesSpan("老秦是个守钟人", SECRET.npc));
  const c = normalizeCompiled(EXTRACTED);
  assert.deepEqual(blurbLeaks(BLURB, c), []);
  assert.deepEqual(blurbLeaks({ ...BLURB, contentWarnings: [SECRET.clockConsequence] }, c), ["contentWarnings"]);
});

test("renderGuide lists secrets and clue ids for the KP, within budget", () => {
  const g = renderGuide(normalizeCompiled(EXTRACTED), 2000);
  for (const s of [SECRET.npc, SECRET.clue, SECRET.truth, "c2｜", "走私船离港 6 格"]) assert(g.includes(s), s);
  assert(renderGuide(normalizeCompiled(EXTRACTED), 40).endsWith("（已截断）"));
});

// ---------------- engine integration ----------------

async function compiledCampaign(main = scripted([])) {
  const ctx = setup({ provider: main, compiler: compiler([EXTRACTED, BLURB]) });
  // setup() imports a scenario without compiling; compile it now and open a fresh campaign on it.
  const started = ctx.platform.compileScenario(ctx.scenarioId, { provider: "openrouter" });
  assert.equal(started.compileStatus, "running");
  await ctx.platform.compileIdle(ctx.scenarioId);
  const campaign = ctx.platform.createCampaign({
    name: "编译后的团",
    systemId: "coc7",
    scenarioId: ctx.scenarioId,
    provider: "demo",
    players: [{ id: "p1", name: "林雾" }, { id: "p2", name: "周岚" }],
  });
  return { ...ctx, campaign };
}

test("compiled secrets never reach the organizer or players", async () => {
  const { platform, store, campaign, scenarioId } = await compiledCampaign();
  assert.equal(store.getScenario(scenarioId).compileStatus, "done");
  const visible = JSON.stringify([
    platform.scenarioSummary(scenarioId),
    store.listScenarios(),
    platform.organizerView(campaign.id),
    platform.playerView(campaign.id, "p1"),
  ]);
  for (const s of Object.values(SECRET)) assert(!visible.includes(s), `leaked: ${s}`);
  assert(visible.includes(BLURB.pitch), "the blurb is shown");
  assert.equal(platform.playerView(campaign.id, "p1").scenario.blurb!.setting, BLURB.setting);
});

test("compiled clocks are seeded (KP-only) and the guide sits in the cached part of the KP context", async () => {
  const main = scripted([() => reply("好")]);
  const { platform, store, campaign } = await compiledCampaign(main);
  const { state } = store.getState<WorldState>(campaign.id);
  assert.deepEqual(state.clocks["走私船离港"], { filled: 0, size: 6, note: SECRET.clockConsequence });

  await platform.message(campaign.id, { messageId: "m1", playerId: "p1", kind: "action", text: "我去钟楼看看" });
  const parts = main.requests[0].systemParts!;
  assert(parts.stable.includes("KP 指南"));
  assert(parts.stable.includes(SECRET.npc));
  assert(parts.stable.includes("c2｜"));
});

test("record_clue accepts compiled clue ids and rejects unknown or repeated ones", async () => {
  const main = scripted([
    () => calls(["record_clue", { text: "泥脚印", foundBy: null, clueId: "c9" }]),
    (req) => {
      assert.match(lastToolResults(req)[0].body.message, /可用编号：c1、c2/);
      return calls(["record_clue", { text: "泥脚印", foundBy: ["p1"], clueId: "c1" }], ["reply", { text: "你看到了脚印。", whispers: null }]);
    },
    () => calls(["record_clue", { text: "又一个泥脚印", foundBy: null, clueId: "c1" }]),
    (req) => {
      assert.match(lastToolResults(req)[0].body.message, /c1 已经记录过/);
      return reply("没有新发现。");
    },
  ]);
  const { platform, store, campaign } = await compiledCampaign(main);
  await platform.message(campaign.id, { messageId: "a", playerId: "p1", kind: "action", text: "查看楼梯" });
  await platform.message(campaign.id, { messageId: "b", playerId: "p1", kind: "action", text: "再看看" });
  assert.deepEqual(store.getState<WorldState>(campaign.id).state.clues.map((c) => c.ref), ["c1"]);
});

test("when clues dry up, the director names undiscovered compiled clues (KP-only)", async () => {
  const main = scripted(Array.from({ length: 5 }, () => () => reply("……")));
  const { platform, campaign } = await compiledCampaign(main);
  for (let i = 1; i <= 5; i++) await platform.message(campaign.id, { messageId: `m${i}`, playerId: "p1", kind: "auto", text: `第${i}句` });
  const last = main.requests[4].systemParts!.dynamic;
  assert.match(last, /尚未发现：c1「楼梯上有新鲜的泥脚印」（侦查 楼梯）；c2/);
  // The organizer sees only the directive kind.
  const diag = platform.organizerView(campaign.id).diagnostics.at(-1)!;
  assert.deepEqual(diag.directives, ["hint", "spotlight"]);
});

test("compile failures are reported without model text; demo compile needs no model", async () => {
  const failing = scripted([], []);
  failing.complete = async () => {
    throw new Error(`upstream said: ${SECRET.npc}`);
  };
  const ctx = setup({ provider: scripted([]), compiler: failing });
  ctx.platform.compileScenario(ctx.scenarioId, { provider: "openrouter" });
  await ctx.platform.compileIdle(ctx.scenarioId);
  const s = ctx.platform.scenarioSummary(ctx.scenarioId);
  assert.equal(s.compileStatus, "failed");
  assert.equal(s.compileError, "编译时发生内部错误");

  const demo = new Platform(ctx.store, { autoCompress: false });
  demo.compileScenario(ctx.scenarioId, { provider: "demo" });
  await demo.compileIdle(ctx.scenarioId);
  assert.match(String((demo.scenarioSummary(ctx.scenarioId).blurb as any).pitch), /离线演示/);
  assert.throws(() => ctx.platform.compileScenario(ctx.scenarioId, { provider: "nope" }), /provider/);
});

test("importing with compile starts it; a compile cut short by a restart is marked failed", async () => {
  const ctx = setup({ provider: scripted([]), compiler: compiler([EXTRACTED, BLURB]) });
  const s = ctx.platform.addScenario({ title: "二号剧本", text: SCENARIO, compile: { provider: "openrouter" } });
  assert.equal(s.compileStatus, "running");
  assert.equal((s as any).text, undefined, "import response has no scenario text");
  await ctx.platform.compileIdle(s.id);
  assert.equal(ctx.platform.scenarioSummary(s.id).compileStatus, "done");

  const dir = mkdtempSync(join(tmpdir(), "aikp-compile-"));
  try {
    const path = join(dir, "db.sqlite");
    const a = new Store(path);
    const sc = a.addScenario({ title: "t", text: "x", brief: "" }, []);
    a.setCompileStatus(sc.id, "running");
    a.close();
    const b = new Store(path);
    assert.equal(b.getScenario(sc.id).compileStatus, "failed");
    assert.match(b.getScenario(sc.id).compileError!, /重启中断/);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
