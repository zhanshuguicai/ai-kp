// Powered by the Apocalypse: 2d6 + stat; 10+ strong hit, 7-9 weak hit, 6- miss.
import type { Outcome, RuleSystem } from "../types.js";
import {
  baseCheckProps,
  fail,
  lookup,
  numberMap,
  objectSchema,
  optEnum,
  optInt,
  record,
  sch,
  str,
} from "../util.js";
import { signed } from "./d20.js";

export interface PbtaSheet {
  stats: Record<string, number>;
}

const MODES = ["normal", "advantage", "disadvantage"] as const;

export const pbta: RuleSystem<PbtaSheet> = {
  id: "pbta",
  name: "启示录引擎 (PbtA)",
  aliases: ["powered by the apocalypse", "启示录", "apocalypse world", "dungeon world", "地下城世界", "怪物之心"],
  summary: "2d6 + 属性；10+ 强命中，7-9 弱命中（有代价的成功），6- 失手由 MC 出招",
  parseSheet(data) {
    const r = record(data, "sheet");
    return { stats: numberMap(r.stats, "stats", -3, 5) };
  },
  exampleSheet: () => ({ stats: { 冷静: 1, 强硬: 2, 火辣: 0, 敏锐: 1, 怪异: -1 } }),
  checkParameters: objectSchema({
    ...baseCheckProps({
      stat: "属性名（按本剧本/游戏的属性，如 强硬、敏锐）",
      value: "角色卡没有该属性时的属性值，否则 null",
      bonus: "持续/下次加值（forward/ongoing）合计，无则 null",
    }),
    move: sch.nstr("触发的招式名，如 Act Under Pressure / 顶住压力；可为 null"),
    dice: sch.nenum([...MODES], "部分 PbtA 游戏的优势/劣势：掷 3d6 取高/低 2 个；默认 normal"),
  }),
  resolveCheck(args, sheet, rng) {
    const statName = str(args.stat, "stat", 60);
    const reason = str(args.reason, "reason", 500);
    const bonus = optInt(args.bonus, "bonus", -5, 5) ?? 0;
    const declared = optInt(args.value, "value", -3, 5);
    const mode = optEnum(args.dice, "dice", MODES) ?? "normal";
    const move = typeof args.move === "string" && args.move.trim() ? args.move.trim().slice(0, 60) : undefined;
    const hit = lookup(sheet?.stats, statName);
    if (!hit && declared === undefined)
      fail("UNKNOWN_STAT", `角色卡没有属性「${statName}」；请在 value 中给出属性值`);
    const stat = hit?.value ?? declared!;
    const values = Array.from({ length: mode === "normal" ? 2 : 3 }, () => rng.int(1, 6));
    const kept =
      mode === "normal"
        ? values
        : [...values].sort((a, b) => (mode === "advantage" ? b - a : a - b)).slice(0, 2);
    const total = kept[0] + kept[1] + stat + bonus;
    const outcome: Outcome = total >= 10 ? "success" : total >= 7 ? "partial" : "failure";
    const degree = outcome === "success" ? "强命中" : outcome === "partial" ? "弱命中" : "失手";
    return {
      system: "pbta",
      actor: (args.actor as string | null) ?? undefined,
      stat: hit?.key ?? statName,
      reason,
      dice: [{ label: mode === "normal" ? "2d6" : "3d6", sides: 6, values, ...(mode === "normal" ? {} : { kept }) }],
      total,
      outcome,
      degree,
      valueSource: hit ? "sheet" : "declared",
      summary: `${move ? `【${move}】` : ""}${statName}${signed(stat + bonus)} 2d6=${kept[0] + kept[1]} 合计 ${total} ${degree}`,
      notes:
        outcome === "partial"
          ? ["弱命中：成功但要给出代价、艰难抉择或不完全的结果"]
          : outcome === "failure"
            ? ["失手：MC 出招，可以强硬也可以温和，但局势要推进"]
            : [],
    };
  },
  promptGuide: () =>
    [
      "规则：启示录引擎（PbtA）。",
      "- 只有玩家的叙述触发某个招式时才 check；move 填招式名。没有 DC，结果固定为 10+ 强命中 / 7-9 弱命中 / 6- 失手。",
      "- 弱命中要给代价或抉择；失手时由你出招推进局势，不要让玩家原地空转。",
      "- PbtA 没有对抗检定：NPC 不掷骰，由玩家的招式结果决定对抗走向。",
    ].join("\n"),
};
