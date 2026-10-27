// Generic d20: d20 + modifier vs DC, natural 20/1 are critical. A safe default for homebrew or unknown systems.
import type { Outcome, RuleSystem } from "../types.js";
import {
  baseCheckProps,
  lookup,
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

export interface GenericSheet {
  modifiers: Record<string, number>;
}

export const genericD20: RuleSystem<GenericSheet> = {
  id: "generic-d20",
  name: "通用 d20",
  aliases: ["generic", "d20", "通用", "自定义"],
  summary: "d20 + 调整 对抗 DC，天然 20 大成功 / 天然 1 大失败；适合轻规则与自制规则",
  parseSheet(data) {
    const r = record(data, "sheet");
    return { modifiers: numberMap(r.modifiers, "modifiers", -20, 40) };
  },
  exampleSheet: () => ({ modifiers: { 力量: 2, 敏捷: 1, 感知: 3, 说服: 4 } }),
  checkParameters: objectSchema({
    ...baseCheckProps({
      stat: "要检定的能力或技能名",
      value: "角色卡没有该项时的调整值；没有则 null（按 +0）",
      bonus: "情境加值，无则 null",
    }),
    dc: sch.int("难度：简单 10 / 普通 15 / 困难 20"),
    advantage: sch.nenum([...ADVANTAGE], "优势/劣势，默认 none"),
  }),
  resolveCheck(args, sheet, rng) {
    const statName = str(args.stat, "stat", 60);
    const reason = str(args.reason, "reason", 500);
    const dc = reqInt(args.dc, "dc", 1, 60);
    const bonus = optInt(args.bonus, "bonus", -20, 20) ?? 0;
    const declared = optInt(args.value, "value", -20, 40);
    const adv = optEnum(args.advantage, "advantage", ADVANTAGE) ?? "none";
    const hit = lookup(sheet?.modifiers, statName);
    const modifier = hit?.value ?? declared ?? 0;
    const source = hit ? "sheet" : declared !== undefined ? "declared" : "base";
    const { natural, group } = rollD20(rng, adv);
    const total = natural + modifier + bonus;
    const outcome: Outcome =
      natural === 20 ? "critical_success" : natural === 1 ? "critical_failure" : total >= dc ? "success" : "failure";
    const degree = { critical_success: "大成功", critical_failure: "大失败", success: "成功", failure: "失败", partial: "部分成功" }[outcome];
    return {
      system: "generic-d20",
      actor: (args.actor as string | null) ?? undefined,
      stat: hit?.key ?? statName,
      reason,
      dice: [group],
      total,
      target: dc,
      targetLabel: "DC",
      outcome,
      degree,
      margin: total - dc,
      valueSource: source,
      summary: `${statName} d20=${natural}${signed(modifier + bonus)}=${total} vs DC${dc} ${degree}`,
      notes: source === "base" ? ["角色卡无此项，按 +0"] : source === "declared" ? ["调整值由 KP 声明"] : [],
    };
  },
  promptGuide: () =>
    [
      "规则：通用 d20（或剧本自带的轻规则）。",
      "- 检定用 check：d20+调整对抗 DC（简单10/普通15/困难20），天然20大成功、天然1大失败。",
      "- 如果剧本原文写有自己的规则，以原文为准，用 roll 掷任意骰并自行判定。",
    ].join("\n"),
};
