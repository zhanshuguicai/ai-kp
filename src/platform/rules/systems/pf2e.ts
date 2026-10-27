// Pathfinder 2nd edition: d20 + modifier vs DC with four degrees of success; natural 20/1 shift one degree.
import type { Outcome, RuleSystem } from "../types.js";
import {
  baseCheckProps,
  canonical,
  fail,
  lookup,
  norm,
  numberMap,
  objectSchema,
  optInt,
  record,
  reqInt,
  sch,
  str,
} from "../util.js";
import { rollD20, signed } from "./d20.js";

type Ability = "str" | "dex" | "con" | "int" | "wis" | "cha";

const STAT_ABILITY: Record<string, Ability> = {
  acrobatics: "dex", arcana: "int", athletics: "str", crafting: "int",
  deception: "cha", diplomacy: "cha", intimidation: "cha", medicine: "wis",
  nature: "wis", occultism: "int", performance: "cha", religion: "wis",
  society: "int", stealth: "dex", survival: "wis", thievery: "dex",
  perception: "wis", fortitude: "con", reflex: "dex", will: "wis",
};

export const PF2E_ALIASES: string[][] = [
  ["acrobatics", "杂技", "特技"], ["arcana", "奥秘"], ["athletics", "运动"],
  ["crafting", "工艺", "制作"], ["deception", "欺诈", "欺瞒"], ["diplomacy", "交涉", "外交"],
  ["intimidation", "威吓"], ["medicine", "医疗", "医药"], ["nature", "自然"],
  ["occultism", "神秘学", "玄学"], ["performance", "表演"], ["religion", "宗教"],
  ["society", "社会"], ["stealth", "隐匿", "潜行"], ["survival", "生存", "求生"],
  ["thievery", "盗术", "妙手"], ["perception", "察觉", "感知"],
  ["fortitude", "强韧", "强韧豁免"], ["reflex", "反射", "反射豁免"], ["will", "意志", "意志豁免"],
];
const ABILITY_ALIASES: string[][] = [
  ["str", "力量"], ["dex", "敏捷"], ["con", "体质"],
  ["int", "智力"], ["wis", "感知属性", "wisdom"], ["cha", "魅力"],
];

const RANKS: Record<string, number> = {
  untrained: 0, u: 0, 未受训: 0,
  trained: 2, t: 2, 受训: 2,
  expert: 4, e: 4, 专家: 4,
  master: 6, m: 6, 大师: 6,
  legendary: 8, l: 8, 传奇: 8,
};

export interface Pf2eSheet {
  level: number;
  /** Ability modifiers (not scores), e.g. dex: 4. */
  abilities: Record<Ability, number>;
  /** Proficiency rank bonus per stat (0 untrained, 2/4/6/8). */
  ranks: Record<string, number>;
  /** Precomputed total modifiers; win over computed ones. Also where lores live. */
  totals: Record<string, number>;
}

const DEGREE: { outcome: Outcome; label: string }[] = [
  { outcome: "critical_failure", label: "大失败" },
  { outcome: "failure", label: "失败" },
  { outcome: "success", label: "成功" },
  { outcome: "critical_success", label: "大成功" },
];

export const pf2e: RuleSystem<Pf2eSheet> = {
  id: "pf2e",
  name: "开拓者 第二版",
  aliases: ["pf2", "pathfinder", "pathfinder2e", "开拓者", "开拓者2e"],
  summary: "d20 + 调整 对抗 DC；超出/低于 10 为大成功/大失败，天然 20/1 升降一级",
  parseSheet(data) {
    const r = record(data, "sheet");
    const level = optInt(r.level, "level", 0, 25) ?? 1;
    const abilities = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 } as Record<Ability, number>;
    for (const [k, v] of Object.entries(numberMap(r.abilities, "abilities", -5, 10))) {
      const c = canonical(k, ABILITY_ALIASES) as Ability | undefined;
      if (!c) fail("INVALID_SHEET", `abilities 中的「${k}」不是属性`);
      abilities[c] = v;
    }
    const ranks: Record<string, number> = {};
    if (r.ranks !== undefined)
      for (const [k, v] of Object.entries(record(r.ranks, "ranks"))) {
        const c = canonical(k, PF2E_ALIASES);
        // Accept rank names or the already-parsed bonus (0/2/4/6/8), so parsed sheets round-trip.
        const rank =
          typeof v === "string"
            ? RANKS[norm(v)]
            : [0, 2, 4, 6, 8].includes(v as number)
              ? (v as number)
              : undefined;
        if (!c) fail("INVALID_SHEET", `ranks 中的「${k}」不是技能/豁免/察觉`);
        if (rank === undefined) fail("INVALID_SHEET", `ranks.${k} 需要 untrained/trained/expert/master/legendary`);
        ranks[c] = rank;
      }
    return { level, abilities, ranks, totals: numberMap(r.totals, "totals", -10, 60) };
  },
  exampleSheet: () => ({
    level: 3,
    abilities: { str: 0, dex: 4, con: 1, int: 2, wis: 1, cha: 0 },
    ranks: { stealth: 2, thievery: 2, perception: 2, reflex: 4 },
    totals: { "underworld lore": 7 },
  }),
  checkParameters: objectSchema({
    ...baseCheckProps({
      stat: "技能/豁免/察觉，如 隐匿、交涉、反射、察觉，或角色卡上的 Lore",
      value: "仅在无角色卡时填写的总调整值，否则 null",
      bonus: "状态/情境/物品加值合计（可为负），无则 null",
    }),
    dc: sch.int("难度等级 DC，必须在掷骰前确定"),
  }),
  resolveCheck(args, sheet, rng) {
    const statName = str(args.stat, "stat", 60);
    const reason = str(args.reason, "reason", 500);
    const dc = reqInt(args.dc, "dc", 1, 60);
    const bonus = optInt(args.bonus, "bonus", -20, 20) ?? 0;
    const declared = optInt(args.value, "value", -10, 60);
    const stat = canonical(statName, PF2E_ALIASES);
    let modifier: number;
    let source: "sheet" | "declared";
    const total = sheet ? lookup(sheet.totals, statName, PF2E_ALIASES) : undefined;
    if (total) {
      modifier = total.value;
      source = "sheet";
    } else if (sheet && stat) {
      const rank = sheet.ranks[stat] ?? 0;
      modifier = sheet.abilities[STAT_ABILITY[stat]] + (rank ? sheet.level + rank : 0);
      source = "sheet";
    } else if (declared !== undefined) {
      modifier = declared;
      source = "declared";
    } else {
      fail("UNKNOWN_STAT", `角色卡没有「${statName}」；请在 value 中给出总调整值`);
    }
    const { natural, group } = rollD20(rng);
    const sum = natural + modifier + bonus;
    const diff = sum - dc;
    let index = diff >= 10 ? 3 : diff >= 0 ? 2 : diff <= -10 ? 0 : 1;
    if (natural === 20) index = Math.min(3, index + 1);
    if (natural === 1) index = Math.max(0, index - 1);
    const d = DEGREE[index];
    const notes: string[] = [];
    if (natural === 20 || natural === 1) notes.push(`天然 ${natural}：成功度${natural === 20 ? "提升" : "降低"}一级`);
    if (source === "declared") notes.push("调整值由 KP 声明，非角色卡数据");
    return {
      system: "pf2e",
      actor: (args.actor as string | null) ?? undefined,
      stat: stat ?? statName,
      reason,
      dice: [group],
      total: sum,
      target: dc,
      targetLabel: "DC",
      outcome: d.outcome,
      degree: d.label,
      margin: diff,
      valueSource: source,
      summary: `${statName} d20=${natural}${signed(modifier + bonus)}=${sum} vs DC${dc} ${d.label}`,
      notes,
    };
  },
  promptGuide: () =>
    [
      "规则：开拓者第二版（PF2e）。",
      "- 检定用 check：先按等级或简单 DC 定 dc，再调用；结果有四级：大成功/成功/失败/大失败，叙述要体现差别。",
      "- 状态、情境、物品加值合并填 bonus（同类取最高）。伤害骰用 roll。",
    ].join("\n"),
};
