import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RuleError,
  coc7,
  dnd5e,
  executeRuleTool,
  fate,
  genericD20,
  getRuleSystem,
  listRuleSystems,
  maxOf,
  minOf,
  pbta,
  pf2e,
  rollDice,
  ruleToolDefs,
  rulesPrompt,
  scriptedRng,
  seededRng,
  storytellerV20,
  type CheckResult,
  type RuleSystem,
} from "../../src/platform/rules/index.js";

/** Run a check through the same path the KP will use, with a scripted RNG that must be fully consumed. */
function check(
  system: RuleSystem<any>,
  args: Record<string, unknown>,
  rolls: number[],
  sheet?: unknown,
): CheckResult {
  const rng = scriptedRng(rolls);
  const out = executeRuleTool(
    system,
    "check",
    { actor: sheet ? "p1" : null, reason: "测试", ...args },
    { sheets: sheet ? { p1: sheet } : {}, rng },
  );
  if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
  assert.equal(rng.remaining(), 0, "all scripted dice should be used");
  return out.result as CheckResult;
}

function checkError(system: RuleSystem<any>, args: Record<string, unknown>, sheet?: unknown) {
  const out = executeRuleTool(
    system,
    "check",
    { actor: sheet ? "p1" : null, reason: "测试", ...args },
    { sheets: sheet ? { p1: sheet } : {}, rng: scriptedRng([]) },
  );
  assert.equal(out.ok, false);
  return (out as { ok: false; error: { code: string; message: string } }).error;
}

// ---------------- dice ----------------

test("dice expressions: sums, keep-highest, fudge, percentile, negatives, bounds", () => {
  assert.equal(rollDice("2d6+3", scriptedRng([4, 5])).total, 12);
  const kh = rollDice("4d6kh3", scriptedRng([1, 5, 3, 6]));
  assert.equal(kh.total, 14);
  assert.deepEqual(kh.terms[0].kept, [6, 5, 3]);
  assert.equal(rollDice("4dF", scriptedRng([1, -1, 0, 1])).total, 1);
  assert.equal(rollDice("d%", scriptedRng([42])).total, 42);
  assert.equal(rollDice("1D3+1D4", scriptedRng([2, 3])).total, 5);
  assert.equal(rollDice("-1d4+10", scriptedRng([3])).total, 7);
  assert.equal(maxOf("1d6+2"), 8);
  assert.equal(maxOf("10-1d4"), 9);
  assert.equal(minOf("4dF"), -4);
  assert.equal(maxOf("4d6kh3"), 18);
  for (const bad of ["2d", "101d6", "1d1", "", "1d6*2", "4d6kh5"])
    assert.throws(() => rollDice(bad, seededRng(1)), RuleError, bad);
});

test("seeded rng stays in range and covers every face", () => {
  const rng = seededRng(42);
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const v = rng.int(1, 20);
    assert(v >= 1 && v <= 20);
    seen.add(v);
  }
  assert.equal(seen.size, 20);
});

// ---------------- CoC 7e ----------------

const cocSheet = { skills: { "Spot Hidden": 50, 敏捷: 60, 图书馆使用: 40 }, san: 50 };

test("coc7: success levels, difficulty, aliases between sheet and request", () => {
  const hard = check(coc7, { stat: "侦查", difficulty: null, bonusDice: null, pushed: null, value: null }, [2, 3], cocSheet);
  assert.equal(hard.total, 23);
  assert.equal(hard.outcome, "success");
  assert.equal(hard.degree, "困难成功");
  assert.equal(hard.valueSource, "sheet");

  const short = check(coc7, { stat: "侦查", difficulty: "hard", value: null }, [3, 0], cocSheet);
  assert.equal(short.total, 30);
  assert.equal(short.outcome, "failure");
  assert.match(short.degree, /未达困难/);

  const extreme = check(coc7, { stat: "spot hidden", difficulty: "extreme" }, [1, 0], cocSheet);
  assert.equal(extreme.outcome, "success");
  assert.equal(extreme.degree, "极难成功");
});

test("coc7: bonus and penalty dice share the units die", () => {
  const penalty = check(coc7, { stat: "侦查", bonusDice: -1 }, [2, 8, 3], cocSheet);
  assert.deepEqual(penalty.dice[0].values, [23, 83]);
  assert.equal(penalty.total, 83);
  assert.equal(penalty.outcome, "failure");
  const bonus = check(coc7, { stat: "侦查", bonusDice: 1 }, [8, 2, 3], cocSheet);
  assert.equal(bonus.total, 23);
});

test("coc7: 00+0 is 100, 01 critical, fumble depends on skill value", () => {
  const hundred = check(coc7, { stat: "敏捷" }, [0, 0], cocSheet);
  assert.equal(hundred.total, 100);
  assert.equal(hundred.outcome, "critical_failure");
  const crit = check(coc7, { stat: "图书馆使用", difficulty: "extreme" }, [0, 1], cocSheet);
  assert.equal(crit.outcome, "critical_success");
  const low = check(coc7, { stat: "图书馆使用" }, [9, 7], cocSheet);
  assert.equal(low.outcome, "critical_failure"); // skill 40 < 50 → 96+ fumbles
  const high = check(coc7, { stat: "敏捷" }, [9, 7], cocSheet);
  assert.equal(high.outcome, "failure"); // skill 60 → only 100 fumbles
});

test("coc7: base values, dodge from DEX, declared values and unknown skills", () => {
  const listen = check(coc7, { stat: "聆听" }, [1, 5]);
  assert.equal(listen.target, 20);
  assert.equal(listen.valueSource, "base");
  const dodge = check(coc7, { stat: "闪避" }, [5, 5], cocSheet);
  assert.equal(dodge.target, 30);
  const declared = check(coc7, { stat: "驾驶飞艇", value: 35 }, [3, 0]);
  assert.equal(declared.valueSource, "declared");
  assert.equal(declared.outcome, "success");
  assert.equal(checkError(coc7, { stat: "驾驶飞艇" }).code, "UNKNOWN_STAT");
  assert.equal(checkError(coc7, { stat: "侦查", difficulty: "insane" }, cocSheet).code, "INVALID_ARGS");
});

test("coc7: sanity check suggests SAN loss; fumble takes maximum loss", () => {
  const ok = executeRuleTool(
    coc7,
    "sanity_check",
    { actor: "p1", successLoss: "1d3", failureLoss: "1d6", reason: "目睹尸体", value: null },
    { sheets: { p1: cocSheet }, rng: scriptedRng([3, 0, 2]) },
  );
  assert(ok.ok);
  const r = ok.result as CheckResult;
  assert.equal(r.outcome, "success");
  assert.deepEqual(r.effects, [{ actor: "p1", field: "san", delta: -2 }]);

  const fumble = executeRuleTool(
    coc7,
    "sanity_check",
    { actor: "p1", successLoss: "1", failureLoss: "1d6", reason: "深潜者", value: null },
    { sheets: { p1: { skills: {}, san: 40 } }, rng: scriptedRng([9, 9]) },
  );
  assert(fumble.ok);
  const f = fumble.result as CheckResult;
  assert.equal(f.outcome, "critical_failure");
  assert.deepEqual(f.effects, [{ actor: "p1", field: "san", delta: -6 }]);
  assert(f.notes!.some((n) => n.includes("临时性疯狂")));
});

// ---------------- D&D 5e ----------------

const dndSheet = {
  level: 5,
  abilities: { 敏捷: 16, wis: 12, str: 10 },
  skills: ["隐匿"],
  saves: ["dex"],
};

test("dnd5e: ability + proficiency by level, expertise, Chinese names", () => {
  const stealth = check(dnd5e, { stat: "隐匿", dc: 15, type: null, advantage: null, bonus: null, value: null }, [9], dndSheet);
  assert.equal(stealth.total, 15);
  assert.equal(stealth.outcome, "success");
  const expert = check(dnd5e, { stat: "stealth", dc: 15 }, [9], { ...dndSheet, expertise: ["stealth"] });
  assert.equal(expert.total, 18);
  const perception = check(dnd5e, { stat: "察觉", dc: 10 }, [8], dndSheet);
  assert.equal(perception.total, 9); // wis 12 → +1, not proficient
  assert.equal(perception.outcome, "failure");
  const save = check(dnd5e, { stat: "敏捷", type: "save", dc: 14 }, [8], dndSheet);
  assert.equal(save.total, 14);
});

test("dnd5e: advantage keeps higher; attacks crit on 20 and auto-miss on 1; checks do not", () => {
  const adv = check(dnd5e, { stat: "隐匿", dc: 15, advantage: "advantage" }, [4, 17], dndSheet);
  assert.deepEqual(adv.dice[0].kept, [17]);
  const dis = check(dnd5e, { stat: "隐匿", dc: 15, advantage: "disadvantage" }, [4, 17], dndSheet);
  assert.deepEqual(dis.dice[0].kept, [4]);
  assert.equal(check(dnd5e, { stat: "dex", type: "attack", dc: 30 }, [20], dndSheet).outcome, "critical_success");
  assert.equal(check(dnd5e, { stat: "dex", type: "attack", dc: 2 }, [1], dndSheet).outcome, "critical_failure");
  const nat20 = check(dnd5e, { stat: "察觉", dc: 30 }, [20], dndSheet);
  assert.equal(nat20.outcome, "failure");
  assert(nat20.notes!.some((n) => n.includes("天然 20")));
});

test("dnd5e: DC required, saves need an ability, no sheet needs declared value", () => {
  assert.equal(checkError(dnd5e, { stat: "隐匿" }, dndSheet).code, "INVALID_ARGS");
  assert.equal(checkError(dnd5e, { stat: "隐匿", type: "save", dc: 10 }, dndSheet).code, "INVALID_ARGS");
  assert.equal(checkError(dnd5e, { stat: "隐匿", dc: 10 }).code, "UNKNOWN_STAT");
  assert.equal(checkError(dnd5e, { stat: "飞行", dc: 10 }, dndSheet).code, "UNKNOWN_STAT");
  assert.equal(check(dnd5e, { stat: "隐匿", dc: 10, value: 5 }, [5]).valueSource, "declared");
  assert.equal(checkError(dnd5e, { stat: "隐匿", dc: 10 }, { abilities: { luck: 10 } }).code, "INVALID_SHEET");
});

// ---------------- PF2e ----------------

const pfSheet = {
  level: 3,
  abilities: { dex: 4, wis: 1 },
  ranks: { 隐匿: "trained" },
  totals: { "Underworld Lore": 7 },
};

test("pf2e: four degrees, ±10 rule, natural 20/1 shift one step", () => {
  assert.equal(check(pf2e, { stat: "隐匿", dc: 20 }, [11], pfSheet).outcome, "success"); // 11+9=20
  assert.equal(check(pf2e, { stat: "隐匿", dc: 20 }, [2], pfSheet).outcome, "failure"); // 11 vs 20
  assert.equal(check(pf2e, { stat: "隐匿", dc: 15 }, [16], pfSheet).outcome, "critical_success"); // 25 vs 15
  assert.equal(check(pf2e, { stat: "隐匿", dc: 20 }, [20], pfSheet).outcome, "critical_success"); // 29 success → nat20 up
  assert.equal(check(pf2e, { stat: "隐匿", dc: 10 }, [1], pfSheet).outcome, "failure"); // 10 success → nat1 down
  assert.equal(check(pf2e, { stat: "隐匿", dc: 20 }, [1], pfSheet).outcome, "critical_failure"); // 10 vs 20
});

test("pf2e: untrained uses ability only, totals override, lores", () => {
  assert.equal(check(pf2e, { stat: "盗术", dc: 10 }, [5], pfSheet).total, 9);
  assert.equal(check(pf2e, { stat: "underworld lore", dc: 10 }, [5], pfSheet).total, 12);
  assert.equal(checkError(pf2e, { stat: "隐匿", dc: 10 }, { ranks: { 隐匿: "godlike" } }).code, "INVALID_SHEET");
});

// ---------------- PbtA ----------------

test("pbta: 10+ / 7-9 / 6- and 3d6 advantage", () => {
  const sheet = { stats: { 强硬: 2 } };
  assert.equal(check(pbta, { stat: "强硬" }, [3, 4], sheet).outcome, "partial");
  assert.equal(check(pbta, { stat: "强硬" }, [6, 5], sheet).outcome, "success");
  assert.equal(check(pbta, { stat: "强硬" }, [1, 2], sheet).outcome, "failure");
  const adv = check(pbta, { stat: "强硬", dice: "advantage", move: "顶住压力" }, [1, 5, 6], sheet);
  assert.equal(adv.total, 13);
  assert.match(adv.summary, /顶住压力/);
  assert.equal(checkError(pbta, { stat: "怪异" }, sheet).code, "UNKNOWN_STAT");
});

// ---------------- FATE ----------------

test("fate: shifts decide fail / tie / success / style; invokes add +2", () => {
  const sheet = { skills: { 察觉: 3 } };
  const s = check(fate, { stat: "察觉", opposition: 2 }, [1, 1, 0, -1], sheet);
  assert.equal(s.total, 4);
  assert.equal(s.outcome, "success");
  assert.equal(check(fate, { stat: "察觉", opposition: 2, invokes: 1 }, [1, 1, 0, -1], sheet).outcome, "critical_success");
  assert.equal(check(fate, { stat: "察觉", opposition: 2 }, [0, 0, 0, -1], sheet).outcome, "partial");
  assert.equal(check(fate, { stat: "察觉", opposition: 2 }, [-1, -1, 0, 0], sheet).outcome, "failure");
  const unlisted = check(fate, { stat: "射击", opposition: 0 }, [0, 0, 0, 0], sheet);
  assert.equal(unlisted.valueSource, "base");
  assert.equal(checkError(fate, { stat: "察觉" }, sheet).code, "INVALID_ARGS");
});

// ---------------- Storyteller V20 ----------------

const stSheet = { traits: { 敏捷: 3, 潜行: 2 } };

test("storyteller-v20: pools, 1s cancel, specialty, botch, willpower", () => {
  const r = check(storytellerV20, { stat: "敏捷+潜行" }, [6, 10, 1, 3, 8], stSheet);
  assert.equal(r.total, 2);
  assert.equal(r.degree, "中等成功");
  assert.equal(check(storytellerV20, { stat: "敏捷+潜行", specialty: true }, [6, 10, 1, 3, 8], stSheet).total, 3);
  assert.equal(check(storytellerV20, { stat: "敏捷+潜行" }, [1, 2, 3, 4, 5], stSheet).outcome, "critical_failure");
  const wp = check(storytellerV20, { stat: "敏捷+潜行", willpower: true }, [1, 2, 3, 4, 5], stSheet);
  assert.equal(wp.outcome, "success");
  assert.deepEqual(wp.effects, [{ actor: "p1", field: "意志力", delta: -1 }]);
  assert.equal(check(storytellerV20, { stat: "敏捷+潜行", difficulty: 8 }, [8, 9, 10, 2, 3], stSheet).total, 3);
});

test("storyteller-v20: missing traits need a declared pool; empty pool fails without rolling", () => {
  assert.equal(checkError(storytellerV20, { stat: "敏捷+枪械" }, stSheet).code, "UNKNOWN_STAT");
  assert.equal(check(storytellerV20, { stat: "敏捷+枪械", value: 2 }, [7, 7], stSheet).total, 2);
  const empty = check(storytellerV20, { stat: "敏捷+潜行", bonus: -5 }, [], stSheet);
  assert.equal(empty.outcome, "failure");
});

// ---------------- generic d20 ----------------

test("generic-d20: modifiers, default +0, natural crits", () => {
  const sheet = { modifiers: { 说服: 4 } };
  assert.equal(check(genericD20, { stat: "说服", dc: 15 }, [11], sheet).outcome, "success");
  assert.equal(check(genericD20, { stat: "攀爬", dc: 15 }, [14], sheet).valueSource, "base");
  assert.equal(check(genericD20, { stat: "说服", dc: 40 }, [20], sheet).outcome, "critical_success");
  assert.equal(check(genericD20, { stat: "说服", dc: 2 }, [1], sheet).outcome, "critical_failure");
});

// ---------------- registry & tool contract ----------------

const ALL = [coc7, dnd5e, pf2e, pbta, fate, storytellerV20, genericD20];

test("registry resolves ids and aliases; unknown systems are a rule error", () => {
  assert.equal(listRuleSystems().length, 7);
  assert.equal(getRuleSystem("CoC").id, "coc7");
  assert.equal(getRuleSystem("5e").id, "dnd5e");
  assert.equal(getRuleSystem("黑暗世界").id, "storyteller-v20");
  assert.equal(getRuleSystem("Dungeon World").id, "pbta");
  assert.throws(() => getRuleSystem("gurps"), RuleError);
});

test("every tool schema is OpenAI-strict compatible and every system has a prompt guide", () => {
  for (const system of ALL) {
    const defs = ruleToolDefs(system);
    assert.deepEqual(defs.slice(0, 2).map((d) => d.name), ["check", "roll"]);
    for (const def of defs) {
      const p = def.parameters as any;
      assert.equal(p.type, "object");
      assert.equal(p.additionalProperties, false, `${system.id}.${def.name}`);
      assert.deepEqual([...p.required].sort(), Object.keys(p.properties).sort(), `${system.id}.${def.name}`);
    }
    assert(rulesPrompt(system).length > 50);
    assert.doesNotThrow(() => system.parseSheet(system.exampleSheet()), system.id);
  }
});

test("tool errors come back as data the model can act on, not exceptions", () => {
  const ctx = { sheets: {}, rng: seededRng(1) };
  assert.deepEqual(executeRuleTool(coc7, "fly", {}, ctx), {
    ok: false,
    error: { code: "UNKNOWN_TOOL", message: "规则层没有工具 fly" },
  });
  assert.equal((executeRuleTool(coc7, "check", "x", ctx) as any).error.code, "INVALID_ARGS");
  const roll = executeRuleTool(coc7, "roll", { expression: "1d3+1d4", reason: "伤害" }, ctx);
  assert(roll.ok);
});

test("randomized checks always produce a valid result for every system", () => {
  const rng = seededRng(7);
  const args: Record<string, Record<string, unknown>> = {
    coc7: { stat: "侦查", value: 55, difficulty: "regular", bonusDice: 1 },
    dnd5e: { stat: "隐匿", dc: 15, value: 4 },
    pf2e: { stat: "隐匿", dc: 18, value: 8 },
    pbta: { stat: "强硬", value: 1 },
    fate: { stat: "察觉", opposition: 2, value: 3 },
    "storyteller-v20": { stat: "敏捷+潜行", value: 6 },
    "generic-d20": { stat: "力量", dc: 12, value: 2 },
  };
  const outcomes = new Set(["critical_success", "success", "partial", "failure", "critical_failure"]);
  for (const system of ALL)
    for (let i = 0; i < 500; i++) {
      const out = executeRuleTool(system, "check", { actor: null, reason: "模拟", ...args[system.id] }, { sheets: {}, rng });
      assert(out.ok, system.id);
      const r = out.result as CheckResult;
      assert(outcomes.has(r.outcome));
      assert(Number.isFinite(r.total));
      assert(r.summary.length > 0);
    }
});
