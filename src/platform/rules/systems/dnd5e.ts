// Dungeons & Dragons 5th edition: d20 + modifier vs DC, advantage/disadvantage, proficiency by level.
import type { CheckResult, Outcome, RuleSystem } from "../types.js";
import {
  baseCheckProps,
  canonical,
  fail,
  numberMap,
  objectSchema,
  optEnum,
  optInt,
  record,
  reqInt,
  sch,
  str,
} from "../util.js";
import { ADVANTAGE, rollD20, signed } from "./d20.js";
import { contestByTotal } from "../opposed.js";

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
type Ability = (typeof ABILITIES)[number];

export const DND_ABILITY_ALIASES: string[][] = [
  ["str", "力量", "strength"],
  ["dex", "敏捷", "dexterity"],
  ["con", "体质", "constitution"],
  ["int", "智力", "intelligence"],
  ["wis", "感知", "wisdom"],
  ["cha", "魅力", "charisma"],
];

const SKILLS: Record<string, Ability> = {
  athletics: "str",
  acrobatics: "dex",
  "sleight of hand": "dex",
  stealth: "dex",
  arcana: "int",
  history: "int",
  investigation: "int",
  nature: "int",
  religion: "int",
  "animal handling": "wis",
  insight: "wis",
  medicine: "wis",
  perception: "wis",
  survival: "wis",
  deception: "cha",
  intimidation: "cha",
  performance: "cha",
  persuasion: "cha",
};

export const DND_SKILL_ALIASES: string[][] = [
  ["athletics", "运动"],
  ["acrobatics", "特技", "体操"],
  ["sleight of hand", "巧手"],
  ["stealth", "隐匿", "潜行"],
  ["arcana", "奥秘"],
  ["history", "历史"],
  ["investigation", "调查"],
  ["nature", "自然"],
  ["religion", "宗教"],
  ["animal handling", "驯兽", "驯养动物"],
  ["insight", "洞悉", "察言观色"],
  ["medicine", "医药", "医疗"],
  ["perception", "察觉", "感知检定"],
  ["survival", "求生", "生存"],
  ["deception", "欺瞒", "欺骗"],
  ["intimidation", "威吓", "恐吓"],
  ["performance", "表演"],
  ["persuasion", "游说", "说服"],
];

export interface DndSheet {
  level: number;
  abilities: Record<Ability, number>;
  skills: string[];
  expertise: string[];
  saves: Ability[];
}

const mod = (score: number) => Math.floor((score - 10) / 2);
export const proficiencyBonus = (level: number) => 2 + Math.floor((level - 1) / 4);

function canonList(v: unknown, field: string, groups: string[][]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail("INVALID_SHEET", `${field} 需要字符串数组`);
  return v.map((x) => {
    const c = typeof x === "string" ? canonical(x, groups) : undefined;
    if (!c) fail("INVALID_SHEET", `${field} 中的「${String(x)}」不是已知项`);
    return c;
  });
}

const TYPES = ["check", "save", "attack"] as const;

export const dnd5e: RuleSystem<DndSheet> = {
  id: "dnd5e",
  name: "龙与地下城 第五版",
  aliases: ["dnd", "d&d", "5e", "dnd5", "龙与地下城", "dungeons & dragons"],
  statAliases: [...DND_ABILITY_ALIASES, ...DND_SKILL_ALIASES],
  summary: "d20 + 属性调整 + 熟练加值 对抗 DC；优势/劣势；攻击天然 20 暴击",
  parseSheet(data) {
    const r = record(data, "sheet");
    const level = optInt(r.level, "level", 1, 20) ?? 1;
    const raw = numberMap(r.abilities, "abilities", 1, 30);
    const abilities = {} as Record<Ability, number>;
    for (const a of ABILITIES) abilities[a] = 10;
    for (const [k, v] of Object.entries(raw)) {
      const c = canonical(k, DND_ABILITY_ALIASES) as Ability | undefined;
      if (!c) fail("INVALID_SHEET", `abilities 中的「${k}」不是六项属性之一`);
      abilities[c] = v;
    }
    const skills = canonList(r.skills, "skills", DND_SKILL_ALIASES);
    const expertise = canonList(r.expertise, "expertise", DND_SKILL_ALIASES);
    const saves = canonList(r.saves, "saves", DND_ABILITY_ALIASES) as Ability[];
    return { level, abilities, skills, expertise, saves };
  },
  exampleSheet: () => ({
    level: 3,
    abilities: { str: 10, dex: 16, con: 14, int: 12, wis: 13, cha: 8 },
    skills: ["stealth", "perception", "acrobatics"],
    expertise: ["stealth"],
    saves: ["dex", "int"],
  }),
  checkParameters: objectSchema({
    ...baseCheckProps({
      stat: "技能或属性：如 察觉、隐匿、运动、敏捷；攻击填 str/dex",
      value: "仅在无角色卡时填写的总调整值，否则 null",
      bonus: "情境额外加值（如祝福 1d4 的结果已知时），无则 null",
    }),
    type: sch.nenum([...TYPES], "check 属性/技能检定、save 豁免、attack 攻击；默认 check"),
    dc: sch.int("难度等级 DC（攻击填目标 AC）。必须在掷骰前确定"),
    advantage: sch.nenum([...ADVANTAGE], "优势/劣势，默认 none"),
  }),
  resolveCheck(args, sheet, rng) {
    const statName = str(args.stat, "stat", 60);
    const reason = str(args.reason, "reason", 500);
    const type = optEnum(args.type, "type", TYPES) ?? "check";
    const dc = reqInt(args.dc, "dc", 1, 40);
    const adv = optEnum(args.advantage, "advantage", ADVANTAGE) ?? "none";
    const bonus = optInt(args.bonus, "bonus", -20, 20) ?? 0;
    const declared = optInt(args.value, "value", -10, 30);

    const ability = canonical(statName, DND_ABILITY_ALIASES) as Ability | undefined;
    const skill = ability ? undefined : canonical(statName, DND_SKILL_ALIASES);
    if (!ability && !skill) fail("UNKNOWN_STAT", `「${statName}」不是 5e 的属性或技能`);
    if (type !== "check" && !ability)
      fail("INVALID_ARGS", "豁免和攻击的 stat 需要是属性（如 dex、感知）");

    let modifier: number;
    let source: CheckResult["valueSource"];
    const parts: string[] = [];
    if (sheet) {
      const ab = ability ?? SKILLS[skill!];
      modifier = mod(sheet.abilities[ab]);
      parts.push(`${ab}${signed(modifier)}`);
      const pb = proficiencyBonus(sheet.level);
      const proficient =
        type === "attack" ||
        (type === "save" && sheet.saves.includes(ability!)) ||
        (type === "check" && !!skill && sheet.skills.includes(skill));
      if (proficient) {
        const times = skill && sheet.expertise.includes(skill) ? 2 : 1;
        modifier += pb * times;
        parts.push(`熟练${signed(pb * times)}`);
      }
      source = "sheet";
    } else {
      if (declared === undefined)
        fail("UNKNOWN_STAT", "该角色没有角色卡；请在 value 中给出总调整值");
      modifier = declared;
      source = "declared";
    }
    if (bonus) parts.push(`加值${signed(bonus)}`);
    const { natural, group } = rollD20(rng, adv);
    const total = natural + modifier + bonus;
    let outcome: Outcome;
    let degree: string;
    const notes: string[] = [];
    if (type === "attack" && natural === 20) {
      outcome = "critical_success";
      degree = "暴击";
    } else if (type === "attack" && natural === 1) {
      outcome = "critical_failure";
      degree = "自动失手";
    } else {
      outcome = total >= dc ? "success" : "failure";
      degree = outcome === "success" ? (type === "attack" ? "命中" : "成功") : type === "attack" ? "未命中" : "失败";
      if (natural === 20 || natural === 1)
        notes.push(`天然 ${natural}：按规则，检定与豁免不会因此自动成功或失败`);
    }
    if (source === "declared") notes.push("调整值由 KP 声明，非角色卡数据");
    const name = skill ?? ability!;
    const typeLabel = type === "save" ? "豁免" : type === "attack" ? "攻击" : "检定";
    return {
      system: "dnd5e",
      actor: (args.actor as string | null) ?? undefined,
      stat: name,
      reason,
      dice: [group],
      total,
      target: dc,
      targetLabel: type === "attack" ? "AC" : "DC",
      outcome,
      degree,
      margin: total - dc,
      valueSource: source,
      summary: `${statName}${typeLabel}${adv === "advantage" ? "(优势)" : adv === "disadvantage" ? "(劣势)" : ""} d20=${natural}${signed(modifier + bonus)}=${total} vs ${type === "attack" ? "AC" : "DC"}${dc} ${degree}`,
      notes: parts.length ? [`调整：${parts.join(" ")}`, ...notes] : notes,
    };
  },
  opposed: contestByTotal(() => dnd5e, ["dc", "type"], { dc: 1, type: "check" }, { tieNote: "平手：维持现状，主动方没能达成目的" }),
  promptGuide: () =>
    [
      "规则：龙与地下城第五版（D&D 5e）。",
      "- 双方对抗（擒抱、隐匿对察觉、欺瞒对洞悉）用 opposed_check，比较总值，平手维持现状。",
      "- 检定用 check：先定 DC（简单10/中等15/困难20/极难25），再调用；type 区分检定/豁免/攻击（攻击 dc 填 AC）。",
      "- 有利情境给 advantage，不利给 disadvantage；二者同时存在则 none。",
      "- 被动察觉等不需要掷骰的判断直接按 10+调整值处理。伤害骰用 roll（如 1d8+3，暴击时骰子数翻倍）。",
    ].join("\n"),
};
