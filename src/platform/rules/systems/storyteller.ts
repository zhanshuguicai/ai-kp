// World of Darkness 20th Anniversary (Storyteller): d10 pool vs difficulty, 1s cancel successes, botches.
import type { Outcome, RuleSystem } from "../types.js";
import {
  baseCheckProps,
  fail,
  lookup,
  numberMap,
  objectSchema,
  optBool,
  optInt,
  record,
  sch,
  str,
} from "../util.js";
import { contestByTotal } from "../opposed.js";

export interface StorytellerSheet {
  traits: Record<string, number>;
}

const DEGREES = ["", "勉强成功", "中等成功", "完全成功", "卓越成功", "非凡成功"];

export const storytellerV20: RuleSystem<StorytellerSheet> = {
  id: "storyteller-v20",
  name: "黑暗世界 V20（讲述者系统）",
  aliases: ["wod", "v20", "storyteller", "黑暗世界", "吸血鬼", "vampire the masquerade", "vtm"],
  summary: "属性+能力 组成 d10 骰池，对抗难度（默认 6）；1 抵消成功，无成功且有 1 为大失败",
  parseSheet(data) {
    const r = record(data, "sheet");
    return { traits: numberMap(r.traits, "traits", 0, 10) };
  },
  exampleSheet: () => ({ traits: { 力量: 2, 敏捷: 3, 机智: 3, 运动: 2, 察觉: 3, 潜行: 1, 意志力: 5 } }),
  checkParameters: objectSchema({
    ...baseCheckProps({
      stat: "骰池组合，用 + 连接，如 敏捷+潜行、机智+察觉",
      value: "无角色卡时的骰池总数，否则 null",
      bonus: "骰池增减的骰子数（如伤害惩罚 -1），无则 null",
    }),
    difficulty: sch.nint("难度 2-10，默认 6（简单 4、困难 8、极难 9）"),
    specialty: sch.nbool("是否适用专长（10 计为两个成功）"),
    willpower: sch.nbool("是否花费 1 点意志力获得 1 个自动成功（不会大失败）"),
  }),
  resolveCheck(args, sheet, rng) {
    const statName = str(args.stat, "stat", 80);
    const reason = str(args.reason, "reason", 500);
    const difficulty = optInt(args.difficulty, "difficulty", 2, 10) ?? 6;
    const specialty = optBool(args.specialty, "specialty") ?? false;
    const willpower = optBool(args.willpower, "willpower") ?? false;
    const bonus = optInt(args.bonus, "bonus", -10, 10) ?? 0;
    const declared = optInt(args.value, "value", 0, 30);

    let pool: number;
    let source: "sheet" | "declared";
    const parts = statName.split(/[+＋]/).map((p) => p.trim()).filter(Boolean);
    const hits = parts.map((p) => lookup(sheet?.traits, p));
    if (sheet && hits.every(Boolean)) {
      pool = hits.reduce((s, h) => s + h!.value, 0);
      source = "sheet";
    } else if (declared !== undefined) {
      pool = declared;
      source = "declared";
    } else {
      const missing = parts.filter((_, i) => !hits[i]);
      fail("UNKNOWN_STAT", `角色卡缺少 ${missing.join("、")}；请在 value 中给出骰池总数`);
    }
    pool += bonus;
    const notes: string[] = [];
    if (source === "declared") notes.push("骰池由 KP 声明，非角色卡数据");
    if (pool <= 0 && !willpower) {
      return {
        system: "storyteller-v20",
        actor: (args.actor as string | null) ?? undefined,
        stat: statName,
        reason,
        dice: [],
        total: 0,
        target: difficulty,
        targetLabel: "难度",
        outcome: "failure",
        degree: "骰池为 0，自动失败",
        valueSource: source,
        summary: `${statName} 骰池 0 → 自动失败`,
        notes,
      };
    }
    const values = Array.from({ length: Math.max(0, pool) }, () => rng.int(1, 10));
    let successes = 0;
    for (const v of values) if (v >= difficulty) successes += specialty && v === 10 ? 2 : 1;
    const ones = values.filter((v) => v === 1).length;
    const net = Math.max(0, successes - ones) + (willpower ? 1 : 0);
    const botch = !willpower && successes === 0 && ones > 0;
    const outcome: Outcome = botch
      ? "critical_failure"
      : net <= 0
        ? "failure"
        : net >= 5
          ? "critical_success"
          : "success";
    const degree = botch ? "大失败" : net <= 0 ? "失败" : DEGREES[Math.min(5, net)];
    if (willpower) notes.push("花费 1 点意志力：+1 自动成功");
    return {
      system: "storyteller-v20",
      actor: (args.actor as string | null) ?? undefined,
      stat: statName,
      reason,
      dice: [{ label: `${values.length}d10`, sides: 10, values }],
      total: net,
      target: difficulty,
      targetLabel: "难度",
      outcome,
      degree,
      valueSource: source,
      summary: `${statName} ${values.length}d10[${values.join(",")}] 难度${difficulty}${specialty ? " 专长" : ""} → ${net} 成功 ${degree}`,
      effects:
        willpower && args.actor
          ? [{ actor: String(args.actor), field: "意志力", delta: -1 }]
          : [],
      notes,
    };
  },
  opposed: contestByTotal(() => storytellerV20, [], {}, {
    tieNote: "成功数相同：平手，局面不变",
    show: (r) => `${r.stat} ${r.dice[0] ? `${r.dice[0].label}[${r.dice[0].values.join(",")}]` : "骰池0"} → ${r.total} 成功`,
  }),
  promptGuide: () =>
    [
      "规则：黑暗世界 V20（讲述者系统）。",
      "- 对抗检定用 opposed_check：双方各掷骰池（难度各自填写，常为对方的相关属性或 6），净成功多者胜。",
      "- check 的 stat 写成 属性+能力（如 敏捷+潜行）；难度默认 6，按情境调整 4-9。",
      "- 每个 1 抵消一个成功；没有成功且出现 1 为大失败。成功数越多效果越好（1 勉强 … 5+ 非凡）。",
      "- 玩家可声明花意志力（willpower=true）获得 1 自动成功；有专长时 specialty=true。",
    ].join("\n"),
};
