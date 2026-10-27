import type { Actor, RulePackage } from "./contracts.js";
import type { ActionRequest, SessionView } from "./contracts.js";
/** Planned director seam: proposals still need player consent and authoritative validation. */
export interface ActionProposal {
  kind: ActionRequest["kind"];
  payload: ActionRequest["payload"];
  ruleReferences: string[];
  requiresConfirmation: string[];
}
export interface IntentInterpreter {
  id: string;
  propose(intent: string, context: SessionView): Promise<ActionProposal[]>;
}
export class IntentRegistry {
  private interpreters = new Map<string, IntentInterpreter>();
  register(interpreter: IntentInterpreter) {
    requireThat(!this.interpreters.has(interpreter.id));
    this.interpreters.set(interpreter.id, interpreter);
  }
  get(id: string) {
    const interpreter = this.interpreters.get(id);
    requireThat(interpreter, "UNSUPPORTED_DIRECTOR", "自然语言导演尚未注册");
    return interpreter;
  }
}
export const intentInterpreters = new IntentRegistry();
import { requireThat, type Dice } from "./foundation.js";
/** Engines execute authoritative math. Model narration cannot invoke this registry. */
export interface RuleEngine {
  id: string;
  check(
    actor: Actor,
    dc: number,
    dice: Dice,
  ): { roll: number; total: number; success: boolean };
  attack(
    actor: Actor,
    target: Actor,
    parameters: RulePackage["parameters"],
    dice: Dice,
  ): { roll: number; damage: number };
}
export class RuleEngineRegistry {
  private engines = new Map<string, RuleEngine>();
  register(engine: RuleEngine) {
    requireThat(!this.engines.has(engine.id));
    this.engines.set(engine.id, engine);
  }
  get(id: string) {
    const engine = this.engines.get(id);
    requireThat(engine, "UNSUPPORTED_ENGINE", "未注册规则执行器");
    return engine;
  }
}
export const ruleEngines = new RuleEngineRegistry();
ruleEngines.register({
  id: "simple-d20-v1",
  check(actor, dc, dice) {
    const roll = dice.roll(20);
    return {
      roll,
      total: roll + actor.bonus,
      success: roll + actor.bonus >= dc,
    };
  },
  attack(actor, target, p, dice) {
    const roll = dice.roll(20);
    return {
      roll,
      damage:
        roll + actor.bonus >= target.ac
          ? dice.roll(p.damageSides) + p.damageBonus
          : 0,
    };
  },
});
export interface ToolExecutor {
  execute(
    name: string,
    input: unknown,
    context: { actorId: string; expectedVersion: number; requestId: string },
  ): Promise<unknown>;
}
/** Only explicit app-side tools may be registered. No model-selected arbitrary code. */
export class ToolRegistry {
  private tools = new Map<
    string,
    (
      input: unknown,
      context: { actorId: string; expectedVersion: number; requestId: string },
    ) => Promise<unknown>
  >();
  register(
    name: string,
    run: (
      input: unknown,
      context: { actorId: string; expectedVersion: number; requestId: string },
    ) => Promise<unknown>,
  ) {
    requireThat(!this.tools.has(name));
    this.tools.set(name, run);
  }
  async execute(
    name: string,
    input: unknown,
    context: { actorId: string; expectedVersion: number; requestId: string },
  ) {
    const run = this.tools.get(name);
    requireThat(run, "UNSUPPORTED_TOOL", "工具未注册");
    return run(input, context);
  }
}
