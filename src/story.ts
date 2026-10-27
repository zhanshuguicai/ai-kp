import type {
  Condition,
  Effect,
  GameAction,
  ScenarioPackage,
  StoryDefinition,
  StoryState,
} from "./contracts.js";
import type { State } from "./game.js";
import { requireThat, object, str, exact } from "./foundation.js";
export interface TriggerContext {
  action?: GameAction;
  success?: boolean;
  actorId?: string;
}
export function initialStory(p: ScenarioPackage): StoryState {
  return {
    flags: {},
    inventory: {},
    completed: [],
    fired: [],
    paths: structuredClone(
      p.story?.initialPaths ??
        p.scenes.flatMap((s) => s.links.map((to) => ({ from: s.id, to }))),
    ),
    discovered: [p.startSceneId],
    status: "active",
    endingId: null,
    pending: null,
  };
}
export function matches(
  s: State,
  cs: Condition[],
  c: TriggerContext = {},
): boolean {
  const r = s.story;
  return cs.every((x) => {
    switch (x.type) {
      case "scene":
        return s.sceneId === x.id;
      case "target":
        return (
          (c.action?.payload.targetId ?? c.action?.payload.sceneId) === x.id
        );
      case "action":
        return c.action?.kind === x.kind;
      case "flag":
        return !!r.flags[x.id] === x.value;
      case "item":
        return (r.inventory[x.id] ?? 0) >= x.quantity;
      case "check":
        return c.success === x.success;
      case "enemy":
        return s.enemies.some(
          (e) => e.id === x.id && (e.hp === 0) === x.defeated,
        );
      case "status":
        return r.status === x.value;
    }
  });
}
export function available(s: State) {
  return (s.scenario.story?.interactions ?? []).filter(
    (x) => x.sceneId === s.sceneId && matches(s, x.conditions),
  );
}
export function applyEffects(
  s: State,
  effects: Effect[],
  actorId: string | undefined,
  emit: (type: string, text: string, audience?: string) => void,
) {
  const def = s.scenario.story!;
  for (const e of effects) {
    if (s.story.status !== "active") break;
    switch (e.type) {
      case "flag":
        s.story.flags[e.id] = e.value;
        break;
      case "item": {
        const n = (s.story.inventory[e.id] ?? 0) + e.quantity;
        requireThat(
          n >= 0 && n <= 999,
          "INSUFFICIENT_RESOURCE",
          "物品不足或超过上限",
          409,
        );
        s.story.inventory[e.id] = n;
        emit(
          "inventory",
          `${def.items.find((i) => i.id === e.id)!.name} ${e.quantity > 0 ? "+" : ""}${e.quantity}`,
        );
        break;
      }
      case "reveal":
        requireThat(
          e.audience !== "actor" || actorId,
          "TRIGGER_FAILURE",
          "个人揭示缺少角色",
        );
        emit("reveal", e.text, e.audience === "actor" ? actorId : "public");
        break;
      case "path":
        if (!s.story.paths.some((p) => p.from === e.from && p.to === e.to))
          s.story.paths.push({ from: e.from, to: e.to });
        break;
      case "objective":
        if (!s.story.completed.includes(e.id)) {
          s.story.completed.push(e.id);
          emit(
            "objective",
            `目标完成：${def.objectives.find((x) => x.id === e.id)!.text}`,
          );
        }
        break;
      case "encounter":
        requireThat(
          s.mode !== "combat" && s.actors.some((a) => a.hp > 0),
          "TRIGGER_FAILURE",
          "遭遇前置条件不成立",
        );
        s.enemies = [
          structuredClone(def.encounters.find((x) => x.id === e.id)!),
        ];
        s.mode = "combat";
        s.turnActorId = s.actors.find((a) => a.hp > 0)!.id;
        emit("combat", `${s.enemies[0].name} 启动！可攻击、结束回合或撤退。`);
        break;
      case "end_encounter":
        s.mode = "exploration";
        s.turnActorId = null;
        for (const e of s.enemies) e.hp = 0;
        break;
      case "ending": {
        const end = def.endings.find((x) => x.id === e.id)!;
        s.story.status = end.status;
        s.story.endingId = e.id;
        s.mode = "exploration";
        s.turnActorId = null;
        s.story.pending = null;
        emit("ending", `${end.title}：${end.text}`);
        break;
      }
    }
  }
}
export function runTriggers(
  s: State,
  c: TriggerContext,
  emit: (type: string, text: string, audience?: string) => void,
) {
  const ts = s.scenario.story?.triggers ?? [];
  let count = 0;
  const executed = new Set<string>();
  // Fixed definition order and bounded fixed point; each trigger runs at most once per action.
  while (true) {
    let changed = false;
    for (const t of ts) {
      if (executed.has(t.id) || (t.once && s.story.fired.includes(t.id)))
        continue;
      if (!matches(s, t.conditions, c)) continue;
      requireThat(++count <= 64, "TRIGGER_LIMIT", "剧情触发超过执行上限", 409);
      executed.add(t.id);
      if (t.once) s.story.fired.push(t.id);
      applyEffects(s, t.effects, c.actorId, emit);
      if (s.story.status !== "active") return;
      changed = true;
    }
    if (!changed) break;
  }
}
export function validateStory(p: ScenarioPackage) {
  const d = p.story;
  if (!d) return;
  const fail = (ok: unknown, msg = "剧情定义或引用无效") =>
    requireThat(ok, "INVALID_PACKAGE", msg);
  fail(object(d));
  exact(d, [
    "flags",
    "items",
    "objectives",
    "endings",
    "encounters",
    "initialPaths",
    "interactions",
    "triggers",
  ]);
  const ids = (a: any[], name: string) => {
    fail(Array.isArray(a) && a.length <= 100);
    const xs = a.map((x) => (typeof x === "string" ? x : x?.id));
    fail(
      xs.every(
        (x) =>
          str(x, 60) &&
          /^[a-z0-9-]+$/.test(x) &&
          !["constructor", "prototype", "__proto__"].includes(x),
      ) && new Set(xs).size === xs.length,
      `${name}标识重复或无效`,
    );
    return new Set(xs);
  };
  const scenes = new Set(p.scenes.map((s) => s.id));
  const flags = ids(d.flags, "旗标"),
    items = ids(d.items, "物品"),
    objectives = ids(d.objectives, "目标"),
    endings = ids(d.endings, "结局"),
    enemies = ids(d.encounters, "敌人"),
    interactions = ids(d.interactions, "交互");
  ids(d.triggers, "触发器");
  for (const i of d.items) {
    exact(i, ["id", "name"]);
    fail(str(i.name, 100));
  }
  for (const i of d.objectives) {
    exact(i, ["id", "text"]);
    fail(str(i.text, 1000));
  }
  for (const i of d.endings) {
    exact(i, ["id", "title", "text", "status"]);
    fail(
      str(i.title, 100) &&
        str(i.text, 4000) &&
        ["won", "lost"].includes(i.status),
    );
  }
  for (const e of d.encounters) {
    exact(e, ["id", "name", "hp", "maxHp", "ac", "bonus", "stamina"]);
    fail(
      str(e.name, 50) &&
        [e.hp, e.maxHp, e.ac, e.bonus, e.stamina].every(Number.isInteger) &&
        e.hp > 0 &&
        e.hp === e.maxHp &&
        e.hp <= 1000 &&
        e.ac >= 0 &&
        e.ac <= 100 &&
        e.bonus >= -20 &&
        e.bonus <= 100 &&
        e.stamina >= 0 &&
        e.stamina <= 1000,
    );
  }
  const conditions = (xs: Condition[]) => {
    fail(Array.isArray(xs) && xs.length <= 30);
    const flagsSeen = new Map<string, boolean>();
    for (const x of xs) {
      fail(object(x));
      switch (x.type) {
        case "scene":
          exact(x, ["type", "id"]);
          fail(scenes.has(x.id));
          break;
        case "target":
          exact(x, ["type", "id"]);
          fail(interactions.has(x.id) || scenes.has(x.id) || enemies.has(x.id));
          break;
        case "action":
          exact(x, ["type", "kind"]);
          fail(
            [
              "interact",
              "move",
              "attack",
              "check",
              "end_turn",
              "rest",
              "retreat",
            ].includes(x.kind),
          );
          break;
        case "flag":
          exact(x, ["type", "id", "value"]);
          fail(
            flags.has(x.id) &&
              typeof x.value === "boolean" &&
              (!flagsSeen.has(x.id) || flagsSeen.get(x.id) === x.value),
          );
          flagsSeen.set(x.id, x.value);
          break;
        case "item":
          exact(x, ["type", "id", "quantity"]);
          fail(
            items.has(x.id) &&
              Number.isInteger(x.quantity) &&
              x.quantity >= 1 &&
              x.quantity <= 999,
          );
          break;
        case "check":
          exact(x, ["type", "success"]);
          fail(typeof x.success === "boolean");
          break;
        case "enemy":
          exact(x, ["type", "id", "defeated"]);
          fail(enemies.has(x.id) && typeof x.defeated === "boolean");
          break;
        case "status":
          exact(x, ["type", "value"]);
          fail(["active", "won", "lost"].includes(x.value));
          break;
        default:
          fail(false);
      }
    }
  };
  const path = (x: { from: string; to: string }) =>
    fail(
      scenes.has(x.from) &&
        scenes.has(x.to) &&
        p.scenes.find((s) => s.id === x.from)!.links.includes(x.to),
    );
  const effects = (xs: Effect[]) => {
    fail(Array.isArray(xs) && xs.length <= 30);
    for (const x of xs) {
      fail(object(x));
      switch (x.type) {
        case "flag":
          exact(x, ["type", "id", "value"]);
          fail(flags.has(x.id) && typeof x.value === "boolean");
          break;
        case "item":
          exact(x, ["type", "id", "quantity"]);
          fail(
            items.has(x.id) &&
              Number.isInteger(x.quantity) &&
              x.quantity !== 0 &&
              Math.abs(x.quantity) <= 99,
          );
          break;
        case "reveal":
          exact(x, ["type", "text", "audience"]);
          fail(str(x.text, 4000) && ["public", "actor"].includes(x.audience));
          break;
        case "path":
          exact(x, ["type", "from", "to"]);
          path(x);
          break;
        case "objective":
          exact(x, ["type", "id"]);
          fail(objectives.has(x.id));
          break;
        case "encounter":
          exact(x, ["type", "id"]);
          fail(enemies.has(x.id));
          break;
        case "end_encounter":
          exact(x, ["type"]);
          break;
        case "ending":
          exact(x, ["type", "id"]);
          fail(endings.has(x.id));
          break;
        default:
          fail(false);
      }
    }
  };
  fail(Array.isArray(d.initialPaths) && d.initialPaths.length <= 100);
  for (const x of d.initialPaths) {
    exact(x, ["from", "to"]);
    path(x);
  }
  for (const x of d.interactions) {
    exact(x, [
      "id",
      "sceneId",
      "label",
      "description",
      "aliases",
      "conditions",
      "check",
      "effects",
      "failureEffects",
    ]);
    fail(
      scenes.has(x.sceneId) &&
        str(x.label, 100) &&
        str(x.description, 1000) &&
        Array.isArray(x.aliases) &&
        x.aliases.length <= 20 &&
        x.aliases.every((a) => str(a, 60)),
    );
    conditions(x.conditions);
    effects(x.effects);
    effects(x.failureEffects);
    if (x.check) {
      exact(x.check, ["dc", "cost"]);
      fail(
        Number.isInteger(x.check.dc) &&
          x.check.dc >= 5 &&
          x.check.dc <= 25 &&
          Number.isInteger(x.check.cost) &&
          x.check.cost >= 0 &&
          x.check.cost <= 30,
      );
    }
  }
  for (const x of d.triggers) {
    exact(x, ["id", "once", "conditions", "effects"]);
    fail(typeof x.once === "boolean");
    conditions(x.conditions);
    effects(x.effects);
  }
}
