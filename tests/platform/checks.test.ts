// "Action in, checks out": players only describe actions; the KP model rolls, under rules that stop it
// from fishing for results (one roll per character and skill per turn, pushes only when the player chose).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptedRng } from "../../src/platform/rules/rng.js";
import { executeRuleTool, ruleToolDefs } from "../../src/platform/rules/registry.js";
import { coc7, dnd5e, fate, pbta, pf2e } from "../../src/platform/rules/index.js";
import type { RuleSystem } from "../../src/platform/rules/types.js";
import { calls, lastToolResults, reply, scripted, setup } from "./helpers.js";

const sheet = { skills: { 侦查: 60, 潜行: 40 }, san: 50 };
const check = (actor: string, stat: string, extra: Record<string, unknown> = {}) =>
  ["check", { actor, stat, reason: `${stat}检定`, ...extra }] as [string, Record<string, unknown>];
const opposed = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  ["opposed_check", { reason: "潜入码头", a, b }] as [string, Record<string, unknown>];

function run(tool: string, args: Record<string, unknown>, rolls: number[], system: RuleSystem<any> = coc7, sheets: Record<string, unknown> = { p1: sheet }) {
  const out = executeRuleTool(system, tool, args, { sheets, rng: scriptedRng(rolls) });
  assert(out.ok, JSON.stringify(out));
  return out.result as any;
}

// ---------------- opposed checks in the rule layer ----------------

test("CoC7 opposed: the higher success level wins", () => {
  // 侦查 60 rolls 23 (hard success); NPC 潜行 50 rolls 40 (regular success).
  const r = run("opposed_check", { reason: "发现跟踪者", a: { actor: "p1", stat: "侦查", label: "林雾" }, b: { actor: null, stat: "潜行", value: 50, label: "走私者" } }, [2, 3, 4, 0]);
  assert.equal(r.kind, "opposed");
  assert.equal(r.winner, "a");
  assert.equal(r.sides[0].outcome, "success");
  assert.equal(r.sides[1].outcome, "failure");
  assert.match(r.summary, /^对抗：林雾 侦查\(60\) D100=23 困难成功 vs 走私者 潜行\(50\) D100=40 常规成功 → 林雾 胜$/);
});

test("CoC7 opposed: same level goes to the higher skill; two failures are a stalemate", () => {
  const sameLevel = run("opposed_check", { reason: "x", a: { actor: "p1", stat: "侦查" }, b: { actor: null, stat: "潜行", value: 70, label: "老秦" } }, [5, 0, 6, 0]);
  assert.equal(sameLevel.winner, "b");
  assert.match(sameLevel.notes[0], /技能值较高/);
  const bothFail = run("opposed_check", { reason: "x", a: { actor: "p1", stat: "侦查" }, b: { actor: null, stat: "潜行", value: 30 } }, [8, 0, 9, 0]);
  assert.equal(bothFail.winner, "tie");
  assert.match(bothFail.notes[0], /僵持/);
});

test("d20 and FATE contests compare totals; PF2e and PbtA have no opposed tool", () => {
  const dnd = run("opposed_check", { reason: "擒抱", a: { actor: null, stat: "运动", value: 3 }, b: { actor: null, stat: "特技", value: 5 } }, [10, 8], dnd5e, {});
  assert.equal(dnd.winner, "tie");
  assert.match(dnd.notes[0], /维持现状/);
  assert(!/DC/.test(dnd.summary), dnd.summary);

  const f = run("opposed_check", { reason: "追逐", a: { actor: null, stat: "运动", value: 2 }, b: { actor: null, stat: "运动", value: 1 } }, [1, 1, 0, 0, -1, 0, 0, 0], fate, {});
  assert.equal(f.winner, "a");
  assert.match(f.notes[0], /风格成功/);

  for (const s of [pf2e, pbta]) assert(!ruleToolDefs(s).some((d) => d.name === "opposed_check"), s.id);
  assert(ruleToolDefs(coc7).some((d) => d.name === "opposed_check"));
  // Fixed targets and pushes do not apply to a contest.
  const side = (ruleToolDefs(coc7).find((d) => d.name === "opposed_check")!.parameters as any).properties.a.properties;
  assert(!("difficulty" in side) && !("pushed" in side) && "label" in side);
});

// ---------------- re-roll rules in the KP layer ----------------

test("the same character cannot roll the same skill twice in one turn; the rejected roll leaves no trace", async () => {
  const provider = scripted([
    () => calls(check("p1", "侦查")),
    (req) => {
      assert.equal(lastToolResults(req)[0].body.outcome, "failure");
      // Fishing for a better result, also via an alias of the same skill.
      return calls(check("p1", "Spot Hidden"), check("p2", "侦查"));
    },
    (req) => {
      const [again, other] = lastToolResults(req);
      assert.equal(again.isError, true);
      assert.equal(again.body.code, "ALREADY_ROLLED");
      assert.equal(other.isError, false, "another character may roll the same skill");
      return reply("你没找到什么。");
    },
  ]);
  const { platform, store, campaign } = setup({ provider, rng: scriptedRng([9, 0, 1, 1, 2, 0]), sheets: { p1: sheet, p2: sheet } });
  const out = await platform.message(campaign.id, { messageId: "m1", playerId: "p1", text: "我再仔细找找楼梯" });
  assert.equal(out.turn.status, "complete");
  const rolls = store.events(campaign.id).filter((e) => e.type === "roll");
  assert.deepEqual(rolls.map((e) => e.actor), ["p1", "p2"]);
});

const offer = (playerId: string, kind: "push" | "custom", stat: string | null, options: string[] | null = null) =>
  ["offer_choice", { playerId, kind, stat, prompt: kind === "push" ? "再失败会惊动楼上的人。" : "要付出代价吗？", options }] as [string, Record<string, unknown>];

test("a push needs a recent failure, the player's own click, and works only once", async () => {
  const steps = [
    // Turn 1 (p1): 侦查 fails with 90. Offering a push needs a matching failure; pushing in the same turn is refused.
    () => calls(check("p1", "侦查")),
    () => calls(offer("p1", "push", "潜行"), offer("p1", "push", "Spot Hidden"), check("p1", "侦查", { pushed: true })),
    (req: any) => {
      const [noFailure, offered, again] = lastToolResults(req);
      assert.equal(noFailure.body.code, "PUSH_NOT_ALLOWED");
      assert.match(noFailure.body.message, /可孤注一掷的：侦查/);
      assert.equal(offered.isError, false, "aliases of the failed skill are accepted");
      assert.equal(again.body.code, "ALREADY_ROLLED");
      return reply("你没有发现什么。要孤注一掷吗？");
    },
    // Turn 2 (p1 types it instead of clicking): typed words do not count.
    () => calls(check("p1", "侦查", { pushed: true })),
    (req: any) => {
      assert.equal(lastToolResults(req)[0].body.code, "PUSH_NOT_ALLOWED");
      assert.match(lastToolResults(req)[0].body.message, /明确确认/);
      return reply("请点选按钮确认。");
    },
    // Turn 3 (p1 clicks 孤注一掷): the push goes through; the click covers only that skill.
    (req: any) => {
      const input = JSON.parse((req.history[0] as any).text);
      assert.deepEqual([input.choice.kind, input.choice.picked, input.choice.stat], ["push", "孤注一掷", "侦查"]);
      return calls(check("p1", "侦查", { pushed: true }), check("p1", "潜行", { pushed: true }));
    },
    (req: any) => {
      const [push, other] = lastToolResults(req);
      assert.equal(push.isError, false);
      assert.equal(push.body.outcome, "success");
      assert.equal(other.body.code, "PUSH_NOT_ALLOWED");
      return reply("你在齿轮缝里找到了一枚铜钥匙。");
    },
    // Turn 4: the same check cannot be offered for a push again.
    () => calls(offer("p1", "push", "侦查")),
    (req: any) => {
      assert.equal(lastToolResults(req)[0].body.code, "PUSH_NOT_ALLOWED");
      return reply("没有更多发现了。");
    },
  ];
  const provider = scripted(steps);
  const { platform, store, campaign } = setup({ provider, rng: scriptedRng([9, 0, 5, 5, 5, 5, 1, 0, 5, 5]), sheets: { p1: sheet } });
  const ok = async (body: Record<string, unknown>) => {
    const out = await platform.message(campaign.id, body);
    assert.equal(out.turn.status, "complete", out.turn.error ?? "");
  };
  await ok({ messageId: "m1", playerId: "p1", text: "我再仔细找找" });
  const choice = (platform.playerView(campaign.id, "p1").state as any).choices[0];
  assert.deepEqual([choice.kind, choice.options], ["push", ["孤注一掷", "放弃"]]);
  assert.deepEqual((platform.playerView(campaign.id, "p2").state as any).choices.map((c: any) => c.playerId), ["p1"], "visible to all, answerable by p1 only");

  await ok({ messageId: "m2", playerId: "p1", text: "孤注一掷！" });
  await assert.rejects(platform.message(campaign.id, { messageId: "x1", playerId: "p2", choice: { id: choice.id, option: "孤注一掷" } }), /已经失效/);
  await assert.rejects(platform.message(campaign.id, { messageId: "x2", playerId: "p1", choice: { id: choice.id, option: "再来一次" } }), /没有这个选项/);
  await ok({ messageId: "m3", playerId: "p1", choice: { id: choice.id, option: "孤注一掷" } });
  await assert.rejects(platform.message(campaign.id, { messageId: "x3", playerId: "p1", choice: { id: choice.id, option: "孤注一掷" } }), /已经失效/, "a choice is used once");
  await ok({ messageId: "m4", playerId: "p1", text: "继续" });

  const rolls = store.events(campaign.id).filter((e) => e.type === "roll");
  assert.equal(rolls.length, 2);
  assert.match(rolls[1].text, /孤注一掷/);
  const pick = store.events(campaign.id).find((e) => e.type === "player" && e.data.choice);
  assert.equal(pick!.text, "【选择】孤注一掷");
});

test("custom choices: the player's pick reaches the KP; an unanswered question lapses", async () => {
  const provider = scripted([
    () => calls(offer("p1", "custom", null, ["付出 1 点理智", "放弃追问"]), ["reply", { text: "老秦盯着你。", whispers: null }]),
    (req) => {
      assert.equal(JSON.parse((req.history[0] as any).text).choice.picked, "付出 1 点理智");
      return reply("你咬牙追问下去。");
    },
    () => calls(offer("p1", "custom", null, ["开门", "不开"]), ["reply", { text: "门外有敲门声。", whispers: null }]),
    ...Array.from({ length: 7 }, () => () => reply("……")),
  ]);
  const { platform, campaign } = setup({ provider });
  await platform.message(campaign.id, { messageId: "a", playerId: "p1", text: "我逼问老秦" });
  const c = (platform.playerView(campaign.id, "p1").state as any).choices[0];
  await platform.message(campaign.id, { messageId: "b", playerId: "p1", choice: { id: c.id, option: "付出 1 点理智" } });
  assert.deepEqual((platform.playerView(campaign.id, "p1").state as any).choices, []);

  // A question left unanswered for too long expires.
  await platform.message(campaign.id, { messageId: "c", playerId: "p1", text: "我等着" });
  const door = (platform.playerView(campaign.id, "p1").state as any).choices[0];
  assert.equal(door.prompt, "要付出代价吗？");
  for (let i = 0; i < 7; i++) await platform.message(campaign.id, { messageId: `w${i}`, playerId: "p2", text: "周岚四处看看" });
  assert.deepEqual((platform.playerView(campaign.id, "p1").state as any).choices, [], "expired after the time limit");
  await assert.rejects(platform.message(campaign.id, { messageId: "late", playerId: "p1", choice: { id: door.id, option: "开门" } }), /已经失效/);
});

test("players see that a hidden roll happened, not what it was", async () => {
  const provider = scripted([
    () => calls(check("p1", "心理学", { value: 40, secret: true })),
    () => reply("老秦说他整晚都在钟楼。"),
  ]);
  const { platform, store, campaign } = setup({ provider, rng: scriptedRng([7, 7]), sheets: { p1: sheet } });
  await platform.message(campaign.id, { messageId: "m1", playerId: "p1", text: "我盯着老秦的眼睛，看他是不是在撒谎" });
  const seen = store.events(campaign.id, { forPlayer: "p1" }).filter((e) => e.type === "roll");
  assert.deepEqual(seen.map((e) => e.text), ["KP 进行了一次暗骰（林雾）"]);
  const all = store.events(campaign.id).filter((e) => e.type === "roll");
  assert.equal(all.length, 2);
  assert.match(all.find((e) => e.visibility === "kp")!.text, /心理学\(40\).*D100=77/);
});

test("opposed checks name players, and a player's side counts toward the one-roll rule", async () => {
  const provider = scripted([
    () => calls(opposed({ actor: "p1", stat: "潜行" }, { actor: null, stat: "聆听", value: 50, label: "守卫" })),
    (req) => {
      assert.equal(lastToolResults(req)[0].body.winner, "a");
      return calls(check("p1", "潜行"));
    },
    (req) => {
      assert.equal(lastToolResults(req)[0].body.code, "ALREADY_ROLLED");
      return reply("你贴着墙根溜了过去，守卫毫无察觉。");
    },
  ]);
  const { platform, store, campaign } = setup({ provider, rng: scriptedRng([1, 5, 8, 0, 5, 5]), sheets: { p1: sheet } });
  await platform.message(campaign.id, { messageId: "m1", playerId: "p1", text: "我趁守卫不注意溜进仓库" });
  const [roll] = store.events(campaign.id).filter((e) => e.type === "roll");
  assert.equal(roll.actor, "p1");
  assert.match(roll.text, /^对抗：林雾 潜行\(40\) D100=15 困难成功 vs 守卫 聆听\(50\) D100=80 失败 → 林雾 胜$/);
});

test("players do not pick a message kind; brackets or ooc: mark table talk", async () => {
  const provider = scripted([() => reply("今晚十一点结束。"), () => reply("你推开了门。")]);
  const { platform, store, campaign } = setup({ provider });
  await platform.message(campaign.id, { messageId: "m1", playerId: "p1", text: "（今天大概玩到几点？）" });
  await platform.message(campaign.id, { messageId: "m2", playerId: "p1", text: "我推开钟楼的门" });
  const kinds = store.events(campaign.id).filter((e) => e.type === "player").map((e) => e.data.kind);
  assert.deepEqual(kinds, ["ooc", "auto"]);
  assert.match(provider.requests[0].system, /玩家只描述行动/);
});
