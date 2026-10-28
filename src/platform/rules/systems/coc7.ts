// Call of Cthulhu 7th edition: d100 roll-under with regular / hard / extreme success levels.
import { maxOf, rollDice } from "../dice.js";
import type { CheckResult, OpposedResult, Outcome, Rng, RuleSystem } from "../types.js";
import { asSide, contestSummary, sideName } from "../opposed.js";
import {
  baseCheckProps,
  fail,
  lookup,
  numberMap,
  objectSchema,
  optBool,
  optEnum,
  optInt,
  record,
  sch,
  str,
} from "../util.js";

export interface CocSheet {
  skills: Record<string, number>;
  san?: number;
  hp?: number;
  mp?: number;
  luck?: number;
}

export const COC_ALIASES: string[][] = [
  ["力量", "str", "strength"],
  ["体质", "con", "constitution"],
  ["体型", "siz", "size"],
  ["敏捷", "dex", "dexterity"],
  ["外貌", "app", "appearance"],
  ["智力", "int", "intelligence", "灵感", "idea"],
  ["意志", "pow", "power"],
  ["教育", "edu", "education", "知识", "know"],
  ["幸运", "luck", "运气"],
  ["理智", "san", "sanity"],
  ["侦查", "spot hidden", "侦察"],
  ["聆听", "listen"],
  ["图书馆使用", "library use", "图书馆"],
  ["心理学", "psychology"],
  ["说服", "persuade"],
  ["话术", "fast talk"],
  ["魅惑", "charm"],
  ["恐吓", "intimidate"],
  ["潜行", "stealth"],
  ["闪避", "dodge"],
  ["急救", "first aid"],
  ["医学", "medicine"],
  ["克苏鲁神话", "cthulhu mythos", "神话"],
  ["攀爬", "climb"],
  ["跳跃", "jump"],
  ["游泳", "swim"],
  ["投掷", "throw"],
  ["神秘学", "occult"],
  ["历史", "history"],
  ["估价", "appraise"],
  ["乔装", "disguise"],
  ["汽车驾驶", "drive auto", "驾驶"],
  ["锁匠", "locksmith"],
  ["机械维修", "mechanical repair"],
  ["电气维修", "electrical repair"],
  ["导航", "navigate"],
  ["追踪", "track"],
  ["博物学", "natural world"],
  ["人类学", "anthropology"],
  ["考古学", "archaeology"],
  ["法律", "law"],
  ["会计", "accounting"],
  ["信用评级", "credit rating", "信用"],
  ["斗殴", "fighting (brawl)", "brawl", "格斗"],
  ["手枪", "firearms (handgun)", "handgun"],
  ["步枪/霰弹枪", "firearms (rifle/shotgun)", "rifle", "shotgun", "步枪", "霰弹枪"],
  ["精神分析", "psychoanalysis"],
  ["妙手", "sleight of hand"],
  ["骑术", "ride"],
  ["生存", "survival"],
];

// 7th edition base values for common skills when the sheet does not list them.
const BASE: Record<string, number> = {
  侦查: 25, 聆听: 20, 图书馆使用: 20, 心理学: 10, 说服: 10, 话术: 5,
  魅惑: 15, 恐吓: 15, 潜行: 20, 急救: 30, 医学: 1, 克苏鲁神话: 0,
  攀爬: 20, 跳跃: 20, 游泳: 20, 投掷: 20, 神秘学: 5, 历史: 5, 估价: 5,
  乔装: 5, 汽车驾驶: 20, 锁匠: 1, 机械维修: 10, 电气维修: 10, 导航: 10,
  追踪: 10, 博物学: 10, 人类学: 1, 考古学: 1, 法律: 5, 会计: 5,
  信用评级: 0, 斗殴: 25, 手枪: 20, "步枪/霰弹枪": 25, 精神分析: 1,
  妙手: 10, 骑术: 5, 生存: 10,
};

const DIFFICULTY = ["regular", "hard", "extreme"] as const;
type Difficulty = (typeof DIFFICULTY)[number];
const DIFF_LABEL: Record<Difficulty, string> = {
  regular: "常规",
  hard: "困难",
  extreme: "极难",
};

/** Roll d100 with bonus (>0) or penalty (<0) dice. Tens dice are rolled first, then the units die. */
export function rollD100(rng: Rng, bonusDice = 0) {
  const tens = Array.from({ length: 1 + Math.abs(bonusDice) }, () =>
    rng.int(0, 9),
  );
  const units = rng.int(0, 9);
  const candidates = tens.map((t) => (t * 10 + units === 0 ? 100 : t * 10 + units));
  const roll =
    bonusDice > 0
      ? Math.min(...candidates)
      : bonusDice < 0
        ? Math.max(...candidates)
        : candidates[0];
  return { roll, candidates };
}

type Level = 0 | 1 | 2 | 3; // failure, regular, hard, extreme

function grade(roll: number, value: number) {
  const fumble = value < 50 ? roll >= 96 : roll === 100;
  const critical = roll === 1;
  const level: Level =
    roll <= Math.floor(value / 5) ? 3 : roll <= Math.floor(value / 2) ? 2 : roll <= value ? 1 : 0;
  return { fumble, critical, level };
}

const LEVEL_LABEL = ["失败", "常规成功", "困难成功", "极难成功"];

function skillValue(sheet: CocSheet | undefined, stat: string, declared?: number) {
  const hit = lookup(sheet?.skills, stat, COC_ALIASES);
  if (hit) return { value: hit.value, name: hit.key, source: "sheet" as const };
  if (declared !== undefined) return { value: declared, name: stat, source: "declared" as const };
  if (/^(闪避|dodge)$/i.test(stat.trim())) {
    const dex = lookup(sheet?.skills, "敏捷", COC_ALIASES);
    if (dex) return { value: Math.floor(dex.value / 2), name: "闪避", source: "base" as const };
  }
  const base = lookup(BASE, stat, COC_ALIASES);
  if (base) return { value: base.value, name: base.key, source: "base" as const };
  fail(
    "UNKNOWN_STAT",
    `角色卡没有「${stat}」，也没有规则基础值；请在 value 中给出目标值，或先补充角色卡`,
  );
}

function check(
  args: Record<string, unknown>,
  sheet: CocSheet | undefined,
  rng: Rng,
): CheckResult {
  const stat = str(args.stat, "stat", 60);
  const reason = str(args.reason, "reason", 500);
  const declared = optInt(args.value, "value", 0, 200);
  const difficulty = optEnum(args.difficulty, "difficulty", DIFFICULTY) ?? "regular";
  const bonusDice = optInt(args.bonusDice, "bonusDice", -2, 2) ?? 0;
  const pushed = optBool(args.pushed, "pushed") ?? false;
  const s = skillValue(sheet, stat, declared);
  const { roll, candidates } = rollD100(rng, bonusDice);
  const g = grade(roll, s.value);
  const required: Level = difficulty === "extreme" ? 3 : difficulty === "hard" ? 2 : 1;
  const outcome: Outcome = g.critical
    ? "critical_success"
    : g.fumble
      ? "critical_failure"
      : g.level >= required
        ? "success"
        : "failure";
  const degree = g.critical
    ? "大成功"
    : g.fumble
      ? "大失败"
      : outcome === "success"
        ? LEVEL_LABEL[g.level]
        : g.level > 0
          ? `${LEVEL_LABEL[g.level]}（未达${DIFF_LABEL[difficulty]}）`
          : "失败";
  const bonusText =
    bonusDice > 0 ? ` 奖励骰${bonusDice}` : bonusDice < 0 ? ` 惩罚骰${-bonusDice}` : "";
  const notes: string[] = [];
  if (pushed) notes.push("孤注一掷：失败时 KP 应给出更严重的后果，且不可再次孤注一掷");
  if (s.source === "base") notes.push(`使用规则基础值 ${s.value}`);
  if (s.source === "declared") notes.push("目标值由 KP 声明，非角色卡数据");
  return {
    system: "coc7",
    actor: (args.actor as string | null) ?? undefined,
    stat: s.name,
    reason,
    dice: [{ label: "d100", sides: 100, values: candidates, kept: [roll] }],
    total: roll,
    target: s.value,
    targetLabel: "技能值",
    outcome,
    degree,
    margin: s.value - roll,
    valueSource: s.source,
    summary: `${s.name}(${s.value}) ${DIFF_LABEL[difficulty]}检定${bonusText}${pushed ? " 孤注一掷" : ""} → D100=${roll} ${degree}`,
    notes,
  };
}

/** CoC7 opposed roll: higher success level wins; on a tie the higher skill wins; equal skills tie. */
function opposed(a: Record<string, unknown>, b: Record<string, unknown>, sa: CocSheet | undefined, sb: CocSheet | undefined, rng: Rng): OpposedResult {
  const reason = str(a.reason, "reason", 500);
  const side = (args: Record<string, unknown>, sheet: CocSheet | undefined) => {
    const stat = str(args.stat, "stat", 60);
    const s = skillValue(sheet, stat, optInt(args.value, "value", 0, 200));
    const bonusDice = optInt(args.bonusDice, "bonusDice", -2, 2) ?? 0;
    const { roll, candidates } = rollD100(rng, bonusDice);
    const g = grade(roll, s.value);
    const rank = g.critical ? 4 : g.fumble ? -1 : g.level;
    const degree = g.critical ? "大成功" : g.fumble ? "大失败" : LEVEL_LABEL[g.level];
    const r: CheckResult = {
      system: "coc7",
      actor: (args.actor as string | null) ?? undefined,
      stat: s.name,
      reason,
      dice: [{ label: "d100", sides: 100, values: candidates, kept: [roll] }],
      total: roll,
      target: s.value,
      outcome: "failure",
      degree,
      valueSource: s.source,
      summary: "",
    };
    return { r, rank, value: s.value, bonusDice };
  };
  const x = side(a, sa);
  const y = side(b, sb);
  const winner =
    x.rank !== y.rank ? (x.rank > y.rank ? "a" : "b")
    : x.rank <= 0 ? "tie"
    : x.value !== y.value ? (x.value > y.value ? "a" : "b")
    : "tie";
  const res = (me: "a" | "b") => (winner === "tie" ? "tie" : winner === me ? "win" : "lose");
  const A = asSide(x.r, sideName(a, "甲方"), res("a"));
  const B = asSide(y.r, sideName(b, "乙方"), res("b"));
  const bonusText = (n: number) => (n > 0 ? ` 奖励骰${n}` : n < 0 ? ` 惩罚骰${-n}` : "");
  const show = (s: typeof x) => (r: CheckResult) => `${r.stat}(${s.value})${bonusText(s.bonusDice)} D100=${r.total} ${r.degree}`;
  const summary = contestSummary(A, B, winner, (r) => (r === A ? show(x)(r) : show(y)(r)));
  const notes =
    winner === "tie"
      ? [x.rank <= 0 ? "双方都失败：僵持，局面不变" : "成功等级与技能值都相同：平手，可让双方再次对抗或维持现状"]
      : x.rank === y.rank
        ? ["成功等级相同，技能值较高的一方胜出"]
        : [];
  return { system: "coc7", kind: "opposed", reason, sides: [A, B], winner, summary, notes };
}

export const coc7: RuleSystem<CocSheet> = {
  id: "coc7",
  name: "克苏鲁的呼唤 第七版",
  aliases: ["coc", "coc7th", "克苏鲁", "克苏鲁的呼唤", "call of cthulhu"],
  statAliases: COC_ALIASES,
  summary: "d100 骰低于技能值；常规/困难/极难三级成功，奖励骰与惩罚骰，理智检定",
  parseSheet(data) {
    const r = record(data, "sheet");
    const sheet: CocSheet = { skills: numberMap(r.skills, "skills", 0, 200) };
    for (const k of ["san", "hp", "mp", "luck"] as const)
      if (r[k] !== undefined) {
        const n = optInt(r[k], k, 0, 200);
        if (n !== undefined) sheet[k] = n;
      }
    if (sheet.san === undefined) {
      const san = lookup(sheet.skills, "理智", COC_ALIASES);
      if (san) sheet.san = san.value;
    }
    return sheet;
  },
  exampleSheet: () => ({
    skills: { 力量: 50, 敏捷: 60, 意志: 55, 教育: 70, 侦查: 60, 图书馆使用: 50, 心理学: 40 },
    san: 55,
    hp: 11,
    luck: 50,
  }),
  checkParameters: objectSchema({
    ...baseCheckProps({
      stat: "技能或属性名，如 侦查、图书馆使用、意志、幸运",
      value: "仅在角色卡没有该技能时填写的目标值（0-200），否则 null",
    }),
    difficulty: sch.nenum([...DIFFICULTY], "难度：regular 常规 / hard 困难 / extreme 极难；默认 regular"),
    bonusDice: sch.nint("奖励骰为正（1-2），惩罚骰为负（-1~-2），无则 null"),
    pushed: sch.nbool("是否孤注一掷（重新尝试一次失败的检定）"),
  }),
  resolveCheck: check,
  opposed: { omit: ["difficulty", "pushed"], resolve: opposed },
  extraTools: [
    {
      def: {
        name: "sanity_check",
        description:
          "CoC7 理智检定：d100 对当前理智值，成功按 successLoss 扣除，失败按 failureLoss 扣除，大失败取最大损失。返回建议的理智变化，由状态层应用。",
        parameters: objectSchema({
          actor: sch.nstr("玩家 id；无角色卡时为 null 并填写 value"),
          successLoss: sch.str("成功时损失，如 0、1、1d3"),
          failureLoss: sch.str("失败时损失，如 1d6、1d10"),
          reason: sch.str("可公开的原因，如 目睹深潜者"),
          value: sch.nnum("角色卡没有理智值时使用的当前理智，否则 null"),
        }),
      },
      execute(args, ctx) {
        const reason = str(args.reason, "reason", 500);
        const successLoss = str(args.successLoss, "successLoss", 30);
        const failureLoss = str(args.failureLoss, "failureLoss", 30);
        const actor = (args.actor as string | null) ?? undefined;
        const sheet = ctx.sheetFor(actor);
        const declared = optInt(args.value, "value", 0, 99);
        const san = sheet?.san ?? declared;
        if (san === undefined)
          fail("UNKNOWN_STAT", "没有当前理智值；请在 value 中给出，或补充角色卡");
        const { roll } = rollD100(ctx.rng);
        const g = grade(roll, san);
        const success = !g.fumble && (g.critical || g.level >= 1);
        const lossRoll = g.fumble ? undefined : rollDice(success ? successLoss : failureLoss, ctx.rng);
        const loss = Math.max(0, g.fumble ? maxOf(failureLoss) : lossRoll!.total);
        const notes: string[] = [];
        if (loss >= 5) notes.push("单次损失 ≥5：应进行智力检定，成功则陷入临时性疯狂");
        if (loss > 0 && loss >= Math.floor(san / 5))
          notes.push("损失达到当前理智的 1/5：若一天内累计如此，可能陷入不定性疯狂");
        const degree = g.critical ? "大成功" : g.fumble ? "大失败" : success ? "成功" : "失败";
        const result: CheckResult = {
          system: "coc7",
          actor,
          stat: "理智",
          reason,
          dice: [
            { label: "d100", sides: 100, values: [roll] },
            ...(lossRoll
              ? [{ label: `损失 ${lossRoll.expression}`, sides: 0, values: lossRoll.terms.flatMap((t) => t.values ?? []) }]
              : []),
          ],
          total: roll,
          target: san,
          targetLabel: "理智",
          outcome: g.critical ? "critical_success" : g.fumble ? "critical_failure" : success ? "success" : "failure",
          degree,
          valueSource: sheet?.san !== undefined ? "sheet" : "declared",
          summary: `理智检定(${san}) ${successLoss}/${failureLoss} → D100=${roll} ${degree}，损失 ${loss} 点理智`,
          effects: actor && loss ? [{ actor, field: "san", delta: -loss }] : [],
          notes,
        };
        return result;
      },
    },
  ],
  promptGuide: () =>
    [
      "规则：克苏鲁的呼唤第七版（CoC7）。",
      "- 检定用 check：stat 填技能/属性名；difficulty 由你根据情境决定（对抗性强或条件恶劣用 hard/extreme）；有利/不利情境用 bonusDice（±1~2）。",
      "- 只在失败会带来有意义后果时检定。检定失败后可以用 offer_choice（kind=push）问该玩家要不要孤注一掷，prompt 里说明再失败的后果；只有玩家点选「孤注一掷」的那一轮才能 pushed=true，失败须给更重后果。",
      "- 与 NPC 或其他玩家角色的对抗（潜行对聆听、话术对心理学、力量对力量）用 opposed_check，比较成功等级。",
      "- 遭遇恐怖时用 sanity_check，损失写法如 0/1d6、1/1d10；临时疯狂等由你按返回的 notes 处理。",
      "- 战斗伤害等任意骰用 roll（如 1d3+1d4）。",
    ].join("\n"),
};
