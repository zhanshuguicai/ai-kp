import { formatRoll, rollDice } from "./dice.js";
import type { Rng, RuleSystem, RuleTool, ToolDef } from "./types.js";
import { RuleError, fail, norm, objectSchema, sch, str } from "./util.js";
import { coc7 } from "./systems/coc7.js";
import { dnd5e } from "./systems/dnd5e.js";
import { pf2e } from "./systems/pf2e.js";
import { pbta } from "./systems/pbta.js";
import { fate } from "./systems/fate.js";
import { storytellerV20 } from "./systems/storyteller.js";
import { genericD20 } from "./systems/generic.js";

const systems = new Map<string, RuleSystem<any>>();

export function registerRuleSystem(system: RuleSystem<any>) {
  for (const key of [system.id, ...system.aliases]) {
    const k = norm(key);
    const existing = systems.get(k);
    if (existing && existing.id !== system.id)
      throw new Error(`rule system alias "${key}" already used by ${existing.id}`);
    systems.set(k, system);
  }
}

export function getRuleSystem(idOrAlias: string): RuleSystem<any> {
  const s = systems.get(norm(idOrAlias));
  if (!s) fail("UNKNOWN_SYSTEM", `未知规则系统「${idOrAlias}」；可用：${listRuleSystems().map((x) => x.id).join("、")}`);
  return s;
}

export function listRuleSystems() {
  return [...new Set(systems.values())].map((s) => ({
    id: s.id,
    name: s.name,
    summary: s.summary,
    aliases: s.aliases,
  }));
}

for (const s of [coc7, dnd5e, pf2e, pbta, fate, storytellerV20, genericD20]) registerRuleSystem(s);

// ---- Tools exposed to the KP model ----

const rollTool: RuleTool<unknown> = {
  def: {
    name: "roll",
    description:
      "掷任意骰子：伤害、随机表、遭遇等。支持 NdM、d%、NdF、NdMkhK/klK 与加减常数，如 2d6+3、4d6kh3、1D3+1D4。",
    parameters: objectSchema({
      expression: sch.str("骰子表达式"),
      reason: sch.str("可公开的掷骰原因"),
    }),
  },
  execute(args, ctx) {
    const reason = str(args.reason, "reason", 500);
    const r = rollDice(str(args.expression, "expression", 100), ctx.rng);
    return { ...r, reason, summary: `${reason}：${formatRoll(r)}` };
  },
};

function checkTool(system: RuleSystem<any>): RuleTool<any> {
  return {
    def: {
      name: "check",
      description: `${system.name} 检定。服务端掷骰并按规则判定成功度；难度必须在掷骰前确定，禁止自编骰点。`,
      parameters: system.checkParameters,
    },
    execute: (args, ctx) =>
      system.resolveCheck(args, ctx.sheetFor(args.actor as string | null), ctx.rng),
  };
}

export function ruleTools(system: RuleSystem<any>): RuleTool<any>[] {
  return [checkTool(system), rollTool, ...(system.extraTools ?? [])];
}

export function ruleToolDefs(system: RuleSystem<any>): ToolDef[] {
  return ruleTools(system).map((t) => t.def);
}

export type RuleToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

/**
 * Run one rule tool. Rule errors come back as `{ ok: false }` so the KP layer can return them to the
 * model as a tool error and let it correct its arguments, instead of failing the whole turn.
 * Any other exception is a bug and is re-thrown.
 */
export function executeRuleTool(
  system: RuleSystem<any>,
  name: string,
  args: unknown,
  ctx: { sheets: Record<string, unknown>; rng: Rng },
): RuleToolOutcome {
  try {
    const tool = ruleTools(system).find((t) => t.def.name === name);
    if (!tool) fail("UNKNOWN_TOOL", `规则层没有工具 ${name}`);
    if (typeof args !== "object" || args === null || Array.isArray(args))
      fail("INVALID_ARGS", "工具参数需要对象");
    const sheetFor = (actor: string | null | undefined) => {
      if (!actor || !Object.hasOwn(ctx.sheets, actor)) return undefined;
      return system.parseSheet(ctx.sheets[actor]);
    };
    return { ok: true, result: tool.execute(args as Record<string, unknown>, { sheetFor, rng: ctx.rng }) };
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: { code: e.code, message: e.message } };
    throw e;
  }
}

/** Text for the KP's fixed context: how to use the tools under this system. */
export function rulesPrompt(system: RuleSystem<any>): string {
  return `${system.promptGuide()}\n- 骰点只能来自 check / roll 等工具结果；工具返回错误时修正参数后重试。`;
}
