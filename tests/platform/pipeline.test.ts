import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptedRng } from "../../src/platform/rules/rng.js";
import { Platform } from "../../src/platform/engine.js";
import type { WorldState } from "../../src/platform/kp/state.js";
import { BRIEF, calls, lastToolResults, reply, say, scripted, setup } from "./helpers.js";

const cocSheet = { skills: { 侦查: 60 }, san: 50 };

test("a full turn: check, clue, scene, reply are committed together", async () => {
  const provider = scripted([
    () => calls(["check", { actor: "p1", stat: "侦查", reason: "搜索钟楼", difficulty: null, bonusDice: null, pushed: null, value: null, secret: null }]),
    (req) => {
      const [r] = lastToolResults(req);
      assert.equal(r.isError, false);
      assert.equal(r.body.outcome, "success");
      return calls(
        ["update_scene", { name: "钟楼", description: "满地铜屑" }],
        ["record_clue", { text: "楼梯上有新鲜的泥脚印", foundBy: ["p1"] }],
        ["reply", { text: "你在楼梯上发现了新鲜的泥脚印。", whispers: null }],
      );
    },
  ]);
  const { platform, store, campaign } = setup({ provider, rng: scriptedRng([2, 3]), sheets: { p1: cocSheet } });
  const out = await platform.message(campaign.id, { messageId: "m1", playerId: "p1", kind: "action", text: "我仔细搜索钟楼底层" });

  assert.equal(out.turn.status, "complete");
  assert.equal(out.reply, "你在楼梯上发现了新鲜的泥脚印。");
  const { state, version } = store.getState<WorldState>(campaign.id);
  assert.equal(version, 1);
  assert.equal(state.scene.name, "钟楼");
  assert.equal(state.lastClueTurn, 1);
  assert.equal(state.clues[0].text, "楼梯上有新鲜的泥脚印");
  const types = out.events.map((e) => e.type);
  assert.deepEqual(types, ["player", "roll", "state", "state", "kp"]);
  assert.match(out.events[1].text, /林雾：侦查\(60\).*困难成功/);

  // The KP context carried the brief, retrieved scenario text, sheets and the rules guide.
  const system = provider.requests[0].system;
  assert(system.includes(BRIEF));
  assert(system.includes("钟楼底层堆满铜屑"));
  assert(system.includes("克苏鲁的呼唤"));
  assert(system.includes('"侦查":60'));
});

test("bad tool arguments go back to the model, which fixes them; the turn still succeeds", async () => {
  const provider = scripted([
    () => calls(["check", { actor: "p1", stat: "侦查", reason: "搜索", difficulty: "insane" }], ["teleport", {}]),
    (req) => {
      const results = lastToolResults(req);
      assert.equal(results[0].isError, true);
      assert.equal(results[0].body.code, "INVALID_ARGS");
      assert.equal(results[1].body.code, "UNKNOWN_TOOL");
      return calls(["check", { actor: "p1", stat: "侦查", reason: "搜索", difficulty: "hard" }]);
    },
    () => reply("你找到了一些铜屑。"),
  ]);
  const { platform, campaign } = setup({ provider, rng: scriptedRng([1, 0]), sheets: { p1: cocSheet } });
  const out = await platform.message(campaign.id, { messageId: "m1", playerId: "p1", kind: "action", text: "搜索" });
  assert.equal(out.turn.status, "complete");
  assert.equal(out.events.filter((e) => e.type === "roll").length, 1);
});

test("a text-only answer is accepted as the reply", async () => {
  const provider = scripted([() => say("阿澄点点头：“信是昨晚丢的。”")]);
  const { platform, campaign } = setup({ provider });
  const out = await platform.message(campaign.id, { messageId: "m1", playerId: "p2", kind: "dialogue", text: "信什么时候丢的？" });
  assert.equal(out.turn.status, "complete");
  assert.equal(out.reply, "阿澄点点头：“信是昨晚丢的。”");
});

test("a failed turn keeps the dice it rolled but drops every other change", async () => {
  const provider = scripted([
    () => calls(
      ["check", { actor: "p1", stat: "侦查", reason: "搜索" }],
      ["record_clue", { text: "不该被保存的线索", foundBy: null }],
    ),
    () => ({ text: "", calls: [], native: [], stop: "max_tokens" }),
  ]);
  const { platform, store, campaign } = setup({ provider, rng: scriptedRng([5, 5]), sheets: { p1: cocSheet } });
  const out = await platform.message(campaign.id, { messageId: "m1", playerId: "p1", kind: "action", text: "搜索" });
  assert.equal(out.turn.status, "failed");
  assert.match(out.turn.error!, /截断/);
  assert.deepEqual(out.events.map((e) => e.type), ["player", "roll", "error"]);
  const { state, version } = store.getState<WorldState>(campaign.id);
  assert.equal(version, 0);
  assert.equal(state.clues.length, 0);
});

test("same messageId is processed once, including after a failure", async () => {
  const provider = scripted([() => reply("第一次")]);
  const { platform, campaign } = setup({ provider });
  const a = await platform.message(campaign.id, { messageId: "m1", playerId: "p1", kind: "auto", text: "你好" });
  const b = await platform.message(campaign.id, { messageId: "m1", playerId: "p1", kind: "auto", text: "你好" });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.reply, "第一次");
  assert.equal(provider.requests.length, 1);
});

test("turns of one campaign run one at a time, in order", async () => {
  const order: string[] = [];
  const provider = scripted([
    (req) => (order.push(String(JSON.parse(req.history[0].role === "user" ? req.history[0].text : "{}").text)), reply("A")),
    (req) => (order.push(String(JSON.parse(req.history[0].role === "user" ? req.history[0].text : "{}").text)), reply("B")),
  ]);
  const { platform, store, campaign } = setup({ provider });
  await Promise.all([
    platform.message(campaign.id, { messageId: "m1", playerId: "p1", kind: "auto", text: "一" }),
    platform.message(campaign.id, { messageId: "m2", playerId: "p2", kind: "auto", text: "二" }),
  ]);
  assert.deepEqual(order, ["一", "二"]);
  assert.deepEqual(store.turns(campaign.id).map((t) => t.n), [1, 2]);
});

test("secret rolls, KP notes, clocks and whispers never reach the public view", async () => {
  const provider = scripted([
    () => calls(
      ["check", { actor: "p1", stat: "心理学", reason: "判断老秦是否说谎", value: 50, secret: true }],
      ["note_secret", { text: "老秦在撒谎，齿轮在他口袋里" }],
      ["advance_clock", { name: "走私船靠岸", delta: 1, size: 4, note: "货物被卸下" }],
      ["reply", { text: "老秦避开了你的目光。", whispers: [{ playerId: "p1", text: "你觉得他在隐瞒什么。" }] }],
    ),
  ]);
  const { platform, campaign } = setup({ provider, rng: scriptedRng([3, 0]) });
  await platform.message(campaign.id, { messageId: "m1", playerId: "p1", kind: "action", text: "我观察老秦的表情" });

  const pub = JSON.stringify(platform.publicView(campaign.id));
  for (const secret of ["心理学", "齿轮在他口袋里", "走私船靠岸", "你觉得他在隐瞒什么"])
    assert(!pub.includes(secret), `public view leaked: ${secret}`);
  assert(pub.includes("老秦避开了你的目光"));

  const kp = platform.kpView(campaign.id);
  assert.equal(kp.state.clocks["走私船靠岸"].filled, 1);
  assert.deepEqual(kp.state.kpNotes, ["老秦在撒谎，齿轮在他口袋里"]);
  assert(kp.events.some((e) => e.type === "whisper" && e.actor === "p1"));
});

test("sanity loss from a rule tool is applied to the character sheet", async () => {
  const provider = scripted([
    () => calls(["sanity_check", { actor: "p1", successLoss: "1", failureLoss: "1d6", reason: "看见尸体", value: null, secret: null }]),
    () => reply("你感到一阵恶心。"),
  ]);
  const { platform, store, campaign } = setup({ provider, rng: scriptedRng([8, 0, 4]), sheets: { p1: cocSheet } });
  await platform.message(campaign.id, { messageId: "m1", playerId: "p1", kind: "action", text: "我掀开草席" });
  const sheet = store.characters(campaign.id).find((c) => c.playerId === "p1")!.sheet as any;
  assert.equal(sheet.san, 46); // roll 80 fails vs 50 → 1d6 = 4
});

test("pacing directives reach the KP when the table stalls", async () => {
  const steps = Array.from({ length: 6 }, () => () => reply("……"));
  const provider = scripted(steps);
  const { platform, campaign } = setup({ provider });
  for (let i = 1; i <= 6; i++)
    await platform.message(campaign.id, { messageId: `m${i}`, playerId: "p1", kind: "auto", text: `第${i}句` });
  const last = provider.requests[5].system;
  assert.match(last, /已有 6 轮没有新线索/);
  assert.match(last, /周岚 已 6 轮没有行动/);
});

test("start turn opens the game without a player", async () => {
  const provider = scripted([
    (req) => {
      assert.match((req.history[0] as any).text, /请开场/);
      return calls(["update_scene", { name: "码头", description: null }], ["set_thread", { title: "查明钟楼停摆的原因", kind: "main", status: "open" }], ["reply", { text: "雾气笼罩着码头……", whispers: null }]);
    },
  ]);
  const { platform, store, campaign } = setup({ provider });
  const out = await platform.start(campaign.id, { messageId: "start-1" });
  assert.equal(out.turn.playerId, null);
  assert.equal(store.getState<WorldState>(campaign.id).state.threads[0].title, "查明钟楼停摆的原因");
});

test("unknown players are rejected; interrupted turns become failed on restart", async () => {
  const provider = scripted([]);
  const { platform, store, campaign } = setup({ provider });
  await assert.rejects(platform.message(campaign.id, { messageId: "x", playerId: "nobody", kind: "auto", text: "hi" }), /不在这个团/);
  store.createTurn(campaign.id, "crashed", "p1");
  const restarted = new Platform(store, { providerFactory: () => provider });
  assert.equal(restarted.init().interruptedTurns, 1);
  assert.equal(store.findTurn(campaign.id, "crashed")!.status, "failed");
});

test("the demo provider runs the real loop offline", async () => {
  const { store } = setup({ provider: scripted([]) });
  const platform = new Platform(store, { rng: scriptedRng([17]), autoCompress: false });
  const c = store.listCampaigns()[0];
  const out = await platform.message(c.id, { messageId: "d1", playerId: "p1", kind: "action", text: "我推开钟楼的门" });
  assert.equal(out.turn.status, "complete");
  assert.match(out.reply!, /离线演示/);
  assert.match(out.events.find((e) => e.type === "roll")!.text, /1d20=17/);
});
