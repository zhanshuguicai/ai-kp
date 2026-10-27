// FATE Core: 4dF + skill vs opposition on the ladder; tie, success, success with style.
import type { Outcome, RuleSystem } from "../types.js";
import {
  baseCheckProps,
  lookup,
  numberMap,
  objectSchema,
  optInt,
  record,
  reqInt,
  sch,
  str,
} from "../util.js";
import { signed } from "./d20.js";

export interface FateSheet {
  skills: Record<string, number>;
  aspects: string[];
}

const LADDER: Record<number, string> = {
  8: "传奇", 7: "史诗", 6: "惊异", 5: "极佳", 4: "很好", 3: "好",
  2: "尚可", 1: "一般", 0: "平庸", [-1]: "差", [-2]: "糟糕",
};
export const ladder = (n: number) => `${LADDER[n] ?? (n > 8 ? "超越传奇" : "灾难")}(${signed(n)})`;

export const fate: RuleSystem<FateSheet> = {
  id: "fate",
  name: "FATE Core",
  aliases: ["fate core", "fate accelerated", "fae", "命运"],
  summary: "4dF + 技能 对抗 阻力；平手/成功/风格成功；援引面向 +2",
  parseSheet(data) {
    const r = record(data, "sheet");
    const aspects = Array.isArray(r.aspects)
      ? r.aspects.filter((x): x is string => typeof x === "string").slice(0, 20)
      : [];
    return { skills: numberMap(r.skills, "skills", -2, 8), aspects };
  },
  exampleSheet: () => ({
    skills: { 体格: 2, 运动: 3, 察觉: 4, 交涉: 1 },
    aspects: ["退役的港口巡警", "欠了黑帮一大笔钱"],
  }),
  checkParameters: objectSchema({
    ...baseCheckProps({
      stat: "技能名，如 察觉、运动、交涉",
      value: "角色卡没有该技能时的技能等级，否则 null（按平庸 +0）",
      bonus: "其他加值，无则 null",
    }),
    opposition: sch.int("阻力等级：被动阻力一般 +1 到 很好 +4，或对手技能值"),
    invokes: sch.nint("本次援引面向的次数（每次 +2），无则 null"),
  }),
  resolveCheck(args, sheet, rng) {
    const statName = str(args.stat, "stat", 60);
    const reason = str(args.reason, "reason", 500);
    const opposition = reqInt(args.opposition, "opposition", -4, 12);
    const invokes = optInt(args.invokes, "invokes", 0, 5) ?? 0;
    const bonus = optInt(args.bonus, "bonus", -5, 5) ?? 0;
    const declared = optInt(args.value, "value", -2, 8);
    const hit = lookup(sheet?.skills, statName);
    const skill = hit?.value ?? declared ?? 0;
    const values = Array.from({ length: 4 }, () => rng.int(-1, 1));
    const dice = values.reduce((a, b) => a + b, 0);
    const total = dice + skill + bonus + invokes * 2;
    const shifts = total - opposition;
    const outcome: Outcome =
      shifts >= 3 ? "critical_success" : shifts >= 1 ? "success" : shifts === 0 ? "partial" : "failure";
    const degree = { critical_success: "风格成功", success: "成功", partial: "平手", failure: "失败", critical_failure: "失败" }[outcome];
    const shown = values.map((v) => (v > 0 ? "+" : v < 0 ? "-" : "0")).join("");
    return {
      system: "fate",
      actor: (args.actor as string | null) ?? undefined,
      stat: hit?.key ?? statName,
      reason,
      dice: [{ label: "4dF", sides: "F", values }],
      total,
      target: opposition,
      targetLabel: "阻力",
      outcome,
      degree,
      margin: shifts,
      valueSource: hit ? "sheet" : declared !== undefined ? "declared" : "base",
      summary: `${statName}${ladder(skill)} 4dF[${shown}]${invokes ? ` 援引×${invokes}` : ""} → ${ladder(total)} vs ${ladder(opposition)} ${degree}（${signed(shifts)} 转移）`,
      notes:
        outcome === "partial"
          ? ["平手：以较小代价达成，或获得一次增益"]
          : outcome === "failure"
            ? ["失败：可以失败，或付出重大代价后成功"]
            : outcome === "critical_success"
              ? ["风格成功：额外获得一次增益"]
              : [],
    };
  },
  promptGuide: () =>
    [
      "规则：FATE Core。",
      "- check 时先定阻力 opposition（被动阻力按阶梯：一般+1 尚可+2 好+3 很好+4），玩家援引面向时 invokes 记次数（每次 +2，需花命运点，由你在叙述中确认）。",
      "- 平手=有代价的成功；失败也可让玩家选择付出重大代价后成功。四种行动：克服/创造优势/攻击/防御。",
    ].join("\n"),
};
