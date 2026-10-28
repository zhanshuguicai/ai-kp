// Summary fidelity: summaries must keep the clues found and the NPCs met in what they cover.
// A summary that drops one is rewritten once with the missing items named, then patched by the program.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepsClue, missingFacts } from "../../src/platform/context/compressor.js";
import { calls, reply, scripted, setup } from "./helpers.js";

test("clues are matched loosely (rewording is fine), NPC names exactly", () => {
  const clue = "码头账簿记录着一艘没有船名的货船";
  assert(keepsClue("调查员在码头账簿里发现：记录着一艘没有船名的货船，常在夜里靠岸。", clue));
  assert(keepsClue("账簿上记着一艘无名货船——码头账簿记录着它没有船名", clue));
  assert(!keepsClue("调查员去了码头，和工人聊了聊。", clue));
  assert.deepEqual(missingFacts("老秦在钟楼里等着。", { clues: [], names: ["老秦", "阿澄"] }), { clues: [], names: ["阿澄"] });
});

/** Two turns that record a clue and an NPC, so a summary of them must keep both. */
async function playTwoTurns(summaries: string[]) {
  const provider = scripted(
    [
      () =>
        calls(
          ["record_clue", { text: "码头账簿记录着一艘没有船名的货船", clueId: null, foundBy: ["p1"] }],
          ["update_npc", { name: "老秦", status: "在钟楼值守", attitude: "警惕" }],
          ["reply", { text: "你在账簿里找到了一条奇怪的记录。", whispers: null }],
        ),
      () => reply("雾更浓了。"),
    ],
    summaries,
  );
  const { platform, store, campaign } = setup({ provider });
  await platform.message(campaign.id, { messageId: "m1", playerId: "p1", text: "我翻看码头的账簿" });
  await platform.message(campaign.id, { messageId: "m2", playerId: "p2", text: "我们回钟楼" });
  await platform.compressNow(campaign.id);
  return { provider, store, campaign };
}

test("a summary that drops a clue is rewritten with the missing items named", async () => {
  const { provider, store, campaign } = await playTwoTurns([
    JSON.stringify({ public: "调查员查了账簿。", kp: "调查员查了账簿，老秦起了疑心。" }),
    JSON.stringify({ public: "调查员在账簿里发现一艘没有船名的货船。", kp: "码头账簿记录着一艘没有船名的货船；老秦在钟楼值守，起了疑心。" }),
  ]);
  assert.equal(provider.completions.length, 2);
  assert.match(provider.completions[1], /漏掉了以下内容[\s\S]*线索：码头账簿记录着一艘没有船名的货船/);
  assert(!/NPC：老秦/.test(provider.completions[1]), "only what was missing is named");
  const [s] = store.activeSummaries(campaign.id);
  assert(!s.kpText.includes("【必须保留】"), "the rewrite was good enough, no patch");
});

test("if the rewrite still drops facts, the program appends them; clues also go into the public version", async () => {
  const { store, campaign } = await playTwoTurns([
    JSON.stringify({ public: "调查员到处看了看。", kp: "调查员到处看了看。" }),
    JSON.stringify({ public: "调查员还是到处看了看。", kp: "调查员还是到处看了看。" }),
  ]);
  const [s] = store.activeSummaries(campaign.id);
  assert.match(s.kpText, /【必须保留】线索：码头账簿记录着一艘没有船名的货船；NPC：老秦/);
  assert.match(s.publicText, /已发现的线索：码头账簿记录着一艘没有船名的货船/);
  assert(!s.publicText.includes("老秦"), "NPC names are not added to the public version");
});
