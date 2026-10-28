// Spoiler review: the auxiliary model checks each public reply against the KP-only material
// before it is published. A leak goes back to the KP for a rewrite; a second leak blocks the turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../../src/platform/kp/review.js";
import type { ModelProvider } from "../../src/platform/providers/types.js";
import { BRIEF, calls, lastToolResults, reply, say, scripted, setup } from "./helpers.js";

/** An aux provider that answers review prompts with the given verdicts, in order, and records the prompts. */
function judge(verdicts: (boolean | Error)[]) {
  const prompts: string[] = [];
  const provider: ModelProvider = {
    id: "judge",
    model: "judge",
    async step() {
      throw new Error("not used");
    },
    async complete(req) {
      prompts.push(req.prompt);
      const v = verdicts.shift();
      if (v instanceof Error) throw v;
      return JSON.stringify({ leak: !!v, reason: v ? "第二句说出了老秦拆齿轮的真相" : "" });
    },
  };
  return { provider, prompts };
}

test("verdict parsing tolerates surrounding text and rejects garbage", () => {
  assert.deepEqual(parseVerdict('结论：{"leak": true, "reason": "说出了真相"}'), { leak: true, reason: "说出了真相" });
  assert.throws(() => parseVerdict('{"leak": "yes"}'));
  assert.throws(() => parseVerdict("没有 JSON"));
});

test("a leaking reply is sent back once; the rewrite is published, and the judge saw secrets, known clues and new clues", async () => {
  const provider = scripted([
    () => calls(["record_clue", { text: "楼梯上有泥脚印", clueId: null, foundBy: ["p1"] }], ["reply", { text: "其实是老秦拆了齿轮。", whispers: null }]),
    (req) => {
      const [, rejected] = lastToolResults(req);
      assert.equal(rejected.isError, true);
      assert.equal(rejected.body.code, "SPOILER");
      assert.match(rejected.body.message, /老秦拆齿轮/, "the KP is told what to remove");
      return reply("你在楼梯上发现了新鲜的泥脚印。");
    },
  ]);
  const aux = judge([true, false]);
  const { platform, store, campaign } = setup({ provider, aux: aux.provider, review: true });
  const out = await platform.message(campaign.id, { messageId: "m1", playerId: "p1", text: "我搜索楼梯" });

  assert.equal(out.turn.status, "complete");
  assert.equal(out.reply, "你在楼梯上发现了新鲜的泥脚印。");
  assert(!store.events(campaign.id).some((e) => e.text.includes("其实是老秦")), "the rejected text was never stored");
  assert.equal(store.getState<any>(campaign.id).state.clues.length, 1, "the clue was recorded once");
  const first = aux.prompts[0];
  assert(first.includes(BRIEF), "the judge sees the KP brief");
  assert.match(first, /本轮刚给出的线索（允许出现）：\n- 楼梯上有泥脚印/);
  assert.match(first, /我搜索楼梯/);

  // The organizer sees counts only, never the reason (it quotes the secret).
  const diag = platform.organizerView(campaign.id).diagnostics.at(-1)!;
  assert.deepEqual(diag.review, { checked: 2, rejected: 1, errors: 0 });
  assert(!JSON.stringify(platform.organizerView(campaign.id)).includes("老秦拆齿轮"));
});

test("two leaks in a row block the turn; nothing is published and the player can resend", async () => {
  const provider = scripted([() => reply("真相是老秦拆了齿轮。"), () => reply("我再说一遍，老秦拆了齿轮。")]);
  const { platform, store, campaign } = setup({ provider, aux: judge([true, true]).provider, review: true });
  const out = await platform.message(campaign.id, { messageId: "m1", playerId: "p1", text: "我问老秦" });
  assert.equal(out.turn.status, "failed");
  assert.match(out.turn.error!, /可能提前透露了剧情/);
  assert(!store.events(campaign.id, { publicOnly: true }).some((e) => e.text.includes("拆了齿轮")));
  // The failed turn still leaves diagnostics (counts and tool names only).
  const diag = platform.organizerView(campaign.id).diagnostics.at(-1)!;
  assert.deepEqual([diag.n, diag.review], [1, { checked: 2, rejected: 2, errors: 0 }]);
});

test("text-only replies are reviewed too, and a failing judge does not stop the game", async () => {
  const provider = scripted([() => say("老秦其实拆了齿轮。"), () => reply("老秦沉默地看着你。"), () => reply("钟楼很安静。")]);
  const aux = judge([true, false, new Error("aux down")]);
  const { platform, campaign } = setup({ provider, aux: aux.provider, review: true });
  const a = await platform.message(campaign.id, { messageId: "m1", playerId: "p1", text: "我盯着老秦" });
  assert.equal(a.reply, "老秦沉默地看着你。");
  const b = await platform.message(campaign.id, { messageId: "m2", playerId: "p1", text: "我听听钟楼" });
  assert.equal(b.turn.status, "complete", "an unreachable judge lets the reply through");
  assert.deepEqual(platform.organizerView(campaign.id).diagnostics.at(-1)!.review, { checked: 1, rejected: 0, errors: 1 });
});

test("whispers are reviewed with the reply; review can be turned off per campaign", async () => {
  const provider = scripted([() => reply("钟楼很安静。", [{ playerId: "p2", text: "你注意到老秦袖口有铜屑。" }]), () => reply("好的。")]);
  const aux = judge([false]);
  const { platform, store, campaign } = setup({ provider, aux: aux.provider, review: true });
  await platform.message(campaign.id, { messageId: "m1", playerId: "p1", text: "我看看四周" });
  assert.match(aux.prompts[0], /（只发给 周岚 的私聊）你注意到老秦袖口有铜屑。/);

  store.updateSettings(campaign.id, { ...store.getCampaign(campaign.id).settings, review: { enabled: false } });
  await platform.message(campaign.id, { messageId: "m2", playerId: "p1", text: "继续" });
  assert.equal(aux.prompts.length, 1, "no review when switched off");
});

test("the organizer can switch review per campaign; new campaigns have it on", () => {
  const { platform, store, scenarioId } = setup({ provider: scripted([]) });
  const c = platform.createCampaign({ name: "新团", systemId: "coc7", scenarioId, provider: "demo", players: [{ id: "p", name: "P" }] });
  assert.deepEqual(platform.organizerView(c.id).review, { enabled: true });
  assert.throws(() => platform.setReview(c.id, { enabled: "no" }), /true 或 false/);
  platform.setReview(c.id, { enabled: false });
  assert.equal(store.getCampaign(c.id).settings.review.enabled, false);
});

test("the judge also sees what players were already told in earlier public replies", async () => {
  const provider = scripted([() => reply("地下室的门上钉着三道铁螺栓。"), () => reply("你们回想起地下室那扇被封死的门。")]);
  const aux = judge([false, false]);
  const { platform, campaign } = setup({ provider, aux: aux.provider, review: true });
  await platform.message(campaign.id, { messageId: "m1", playerId: "p1", text: "我看看厨房" });
  await platform.message(campaign.id, { messageId: "m2", playerId: "p1", text: "我们整理一下线索" });
  assert.match(aux.prompts[1], /【KP 已公开】地下室的门上钉着三道铁螺栓。/);
});
