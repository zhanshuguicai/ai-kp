import { adventure } from "./adventure.js";
import { initialStory, available, applyEffects, runTriggers } from "./story.js";
import {
  localInterpret,
  sameAction,
  needsClarification,
  validateDecision,
  type DirectorContext,
  type Affordance,
} from "./director.js";
import type { StoryState, GameAction, Decision } from "./contracts.js";
import { ruleEngines } from "./rules.js";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  ActionRequest,
  Actor,
  ControlRequest,
  GameEvent,
  GamePackage,
  ProviderId,
  RulePackage,
  ScenarioPackage,
  SessionView,
} from "./contracts.js";
import {
  builtinRules,
  builtinScenario,
  requireThat,
  exact,
  object,
  str,
  validatePackage,
  secureDice,
  extensions,
  type Dice,
  type Store,
} from "./foundation.js";
import { providers, type KPProvider, type PublicContext } from "./providers.js";
export interface Identity {
  token: string;
  actorId: string | null;
  role: "owner" | "player";
}
export interface ScenarioRepository {
  getScenario(id: string): ScenarioPackage;
}
export interface State {
  id: string;
  name: string;
  version: number;
  provider: ProviderId;
  paused: boolean;
  mode: "exploration" | "combat";
  location: string;
  sceneId: string;
  actors: Actor[];
  enemies: Actor[];
  turnActorId: string | null;
  events: GameEvent[];
  rule: RulePackage;
  scenario: ScenarioPackage;
  identities: Identity[];
  inviteCode: string;
  personal: Record<string, string[]>;
  receipts: Record<string, { fingerprint: string; view: SessionView }>;
  qq: Record<string, string>;
  story: StoryState;
}
const token = () => randomBytes(24).toString("hex");
export class GameService implements ScenarioRepository {
  private sessions = new Map<string, State>();
  private packages = new Map<string, GamePackage>();
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    public store: Store,
    public models: Map<ProviderId, KPProvider> = providers(),
    public dice: Dice = secureDice,
  ) {}
  async init() {
    this.packages.set("simple-d20@1.0.0", builtinRules);
    this.packages.set("lantern-vault@1.0.0", builtinScenario);
    this.packages.set("lantern-vault@2.0.0", adventure);
    for (const p of (await this.store.read<GamePackage[]>("packages")) ?? [])
      this.packages.set(`${p.id}@${p.version}`, validatePackage(p));
    for (const id of (await this.store.read<string[]>("index")) ?? []) {
      const s = await this.store.read<State>(id);
      if (s) {
        if (!s.story) {
          s.story = initialStory(s.scenario);
          if (!s.story.discovered.includes(s.sceneId))
            s.story.discovered.push(s.sceneId);
        }
        this.validateSave(this.exportSave(s));
        this.sessions.set(id, s);
      }
    }
  }
  catalog() {
    return {
      rules: [...this.packages.values()]
        .filter((p) => p.kind === "rules")
        .map((p) => {
          const r = p as RulePackage;
          return {
            id: r.id,
            version: r.version,
            name: r.name,
            description: r.description,
            supported: r.supported,
            unsupported: r.unsupported,
          };
        }),
      scenarios: [...this.packages.values()]
        .filter((p) => p.kind === "scenario")
        .map((p) => ({
          id: p.id,
          version: p.version,
          name: p.name,
          description: p.description,
        })),
    };
  }
  async importPackage(p: unknown) {
    return this.serial("package-writes", () => this.importPackageUnlocked(p));
  }
  private async importPackageUnlocked(p: unknown) {
    const v = validatePackage(p);
    let key = `${v.id}@${v.version}`;
    requireThat(
      !this.packages.has(key),
      "PACKAGE_EXISTS",
      "同版本包已存在",
      409,
    );
    await this.store.write("packages", [...this.packages.values(), v]);
    this.packages.set(key, v);
    return { id: v.id, version: v.version, kind: v.kind, name: v.name };
  }
  private findPackage(id: string, kind: GamePackage["kind"], version?: string) {
    const p = [...this.packages.values()]
      .filter(
        (p) =>
          p.id === id && p.kind === kind && (!version || p.version === version),
      )
      .sort((a, b) => {
        const av = a.version.split(".").map(Number),
          bv = b.version.split(".").map(Number);
        return av[0] - bv[0] || av[1] - bv[1] || av[2] - bv[2];
      })
      .at(-1);
    requireThat(p, "INVALID_PACKAGE", "找不到匹配的包");
    return structuredClone(p);
  }
  getScenario(id: string): ScenarioPackage {
    return this.findPackage(id, "scenario") as ScenarioPackage;
  }
  private async persist(s: State) {
    return this.serial("store-writes", () => this.persistUnlocked(s));
  }
  private async persistUnlocked(s: State) {
    await this.store.write(s.id, s);
    if (!this.sessions.has(s.id))
      await this.store.write("index", [...this.sessions.keys(), s.id]);
    this.sessions.set(s.id, s);
  }
  get(id: string) {
    const s = this.sessions.get(id);
    requireThat(s, "NOT_FOUND", "找不到会话", 404);
    return s;
  }
  private validateStoryState(s: State) {
    const r = s.story,
      d = s.scenario.story;
    const valid = (ok: unknown) =>
      requireThat(ok, "INVALID_SAVE", "存档剧情状态或引用无效");
    valid(object(r));
    exact(r, [
      "flags",
      "inventory",
      "completed",
      "fired",
      "paths",
      "discovered",
      "status",
      "endingId",
      "pending",
    ]);
    valid(object(r.flags) && object(r.inventory));
    for (const [id, value] of Object.entries(r.flags))
      valid(d?.flags.includes(id) && typeof value === "boolean");
    for (const [id, value] of Object.entries(r.inventory))
      valid(
        d?.items.some((i) => i.id === id) &&
          Number.isInteger(value) &&
          value >= 0 &&
          value <= 999,
      );
    for (const [xs, allowed] of [
      [r.completed, d?.objectives.map((x) => x.id) ?? []],
      [r.fired, d?.triggers.map((x) => x.id) ?? []],
      [r.discovered, s.scenario.scenes.map((x) => x.id)],
    ] as [string[], string[]][]) {
      valid(
        Array.isArray(xs) &&
          xs.length <= 100 &&
          new Set(xs).size === xs.length &&
          xs.every((x) => allowed.includes(x)),
      );
    }
    valid(r.discovered.includes(s.sceneId));
    valid(Array.isArray(r.paths) && r.paths.length <= 100);
    for (const p of r.paths)
      valid(
        object(p) &&
          s.scenario.scenes.some(
            (x) => x.id === p.from && x.links.includes(p.to),
          ),
      );
    valid(["active", "won", "lost"].includes(r.status));
    valid(
      r.status === "active"
        ? r.endingId === null
        : d?.endings.some((e) => e.id === r.endingId && e.status === r.status),
    );
    if (r.pending !== null) {
      const p = r.pending;
      valid(
        object(p) &&
          str(p.id, 100) &&
          s.actors.some((a) => a.id === p.actorId) &&
          p.version === s.version &&
          str(p.message, 2000) &&
          object(p.action),
      );
      valid(
        this.directorContext(s, "").affordances.some((a) =>
          sameAction(a.action, p.action),
        ),
      );
    }
  }
  identity(s: State, t: string) {
    let i = s.identities.find((i) => i.token === t);
    requireThat(i, "AUTH_REQUIRED", "会话令牌无效", 401);
    return i;
  }
  view(s: State, i: Identity): SessionView {
    return structuredClone({
      id: s.id,
      name: s.name,
      version: s.version,
      provider: s.provider,
      paused: s.paused,
      mode: s.mode,
      location: s.location,
      sceneId: s.sceneId,
      scenes: s.scenario.scenes
        .filter(
          (n) =>
            s.story.discovered.includes(n.id) ||
            s.story.paths.some((p) => p.from === s.sceneId && p.to === n.id),
        )
        .map((n) => ({
          id: n.id,
          name: n.name,
          description: n.description,
          links: s.story.paths
            .filter((p) => p.from === n.id)
            .map((p) => p.to)
            .filter(
              (id) =>
                s.story.discovered.includes(id) ||
                s.story.paths.some((p) => p.from === s.sceneId && p.to === id),
            ),
          npcs: n.npcs,
        })),
      actors: s.actors,
      enemies: s.enemies,
      turnActorId: s.turnActorId,
      events: s.events.filter(
        (e) => e.audience === "public" || e.audience === (i.actorId ?? "owner"),
      ),
      personal: i.actorId ? (s.personal[i.actorId] ?? []) : [],
      role: i.role,
      actorId: i.actorId,
      rule: { id: s.rule.id, version: s.rule.version },
      scenario: { id: s.scenario.id, version: s.scenario.version },
      status: s.story.status,
      inventory: (s.scenario.story?.items ?? [])
        .filter((x) => (s.story.inventory[x.id] ?? 0) > 0)
        .map((x) => ({ ...x, quantity: s.story.inventory[x.id] })),
      objectives: (s.scenario.story?.objectives ?? []).map((x) => ({
        ...x,
        completed: s.story.completed.includes(x.id),
      })),
      interactions:
        s.story.status === "active" && s.mode === "exploration"
          ? available(s).map(({ id, label, description }) => ({
              id,
              label,
              description,
            }))
          : [],
      ending: s.story.endingId
        ? (({ id, title, text }) => ({ id, title, text }))(
            s.scenario.story!.endings.find((x) => x.id === s.story.endingId)!,
          )
        : null,
      pending: s.story.pending?.actorId === i.actorId ? s.story.pending : null,
      director: s.provider === "mock" ? "local-demo" : "provider",
    });
  }
  publicContext(s: State, action: string): PublicContext {
    const current = s.scenario.scenes.find((x) => x.id === s.sceneId)!;
    return {
      location: s.location,
      opening: s.scenario.opening.slice(0, 1800),
      scene: {
        id: current.id,
        name: current.name,
        description: current.description.slice(0, 1800),
        npcs: current.npcs
          .slice(0, 10)
          .map((n) => ({
            name: n.name,
            description: n.description.slice(0, 600),
          })),
      },
      objectives: (s.scenario.story?.objectives ?? [])
        .slice(0, 20)
        .map((o) => ({
          id: o.id,
          text: o.text.slice(0, 200),
          completed: s.story.completed.includes(o.id),
        })),
      actors: s.actors.map((a) => ({ name: a.name, hp: a.hp })),
      events: s.events
        .filter((e) => e.audience === "public" && e.type !== "kp")
        .slice(-16)
        .map((e) => e.text.slice(0, 600)),
      action: action.slice(0, 2000),
      status: s.story.status,
      facts: s.events
        .filter(
          (e) =>
            e.audience === "public" &&
            e.version === s.version &&
            !["kp", "say", "decision"].includes(e.type),
        )
        .map((e) => e.text)
        .join("\n")
        .slice(0, 3200)
        .split("\n"),
    };
  }
  private event(s: State, type: string, text: string, audience = "public") {
    s.events.push({
      id: randomUUID(),
      version: s.version,
      type,
      text,
      audience,
    });
  }
  async create(body: any) {
    requireThat(object(body));
    exact(body, [
      "name",
      "ruleId",
      "scenarioId",
      "provider",
      "ruleVersion",
      "scenarioVersion",
    ]);
    requireThat(
      (body.ruleVersion === undefined || str(body.ruleVersion, 30)) &&
        (body.scenarioVersion === undefined || str(body.scenarioVersion, 30)),
    );
    requireThat(str(body.name, 100));
    const p = body.provider ?? "mock";
    requireThat(this.models.has(p), "INVALID_INPUT", "未知模型");
    requireThat(
      this.models.get(p)!.ready,
      "PROVIDER_UNAVAILABLE",
      "模型未配置",
      503,
    );
    const ownerToken = token();
    const scenario = this.findPackage(
      body.scenarioId ?? "lantern-vault",
      "scenario",
      body.scenarioVersion,
    ) as ScenarioPackage;
    const s: State = {
      id: randomUUID(),
      name: body.name,
      version: 0,
      provider: p,
      paused: false,
      mode: "exploration",
      location: scenario.startLocation,
      sceneId: scenario.startSceneId,
      actors: [],
      enemies: [],
      turnActorId: null,
      events: [],
      rule: this.findPackage(
        body.ruleId ?? "simple-d20",
        "rules",
        body.ruleVersion,
      ) as RulePackage,
      scenario,
      story: initialStory(scenario),
      identities: [{ token: ownerToken, actorId: null, role: "owner" }],
      inviteCode: token(),
      personal: {},
      receipts: {},
      qq: {},
    };
    this.event(s, "kp", scenario.opening);
    await this.persist(s);
    return {
      ownerToken,
      inviteCode: s.inviteCode,
      session: this.view(s, s.identities[0]),
    };
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(fn);
    this.locks.set(id, next);
    next
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      })
      .catch(() => {});
    return next;
  }
  async join(id: string, b: any) {
    return this.serial(id, async () => {
      requireThat(object(b));
      exact(b, ["inviteCode", "name"]);
      let s = structuredClone(this.get(id));
      requireThat(
        b.inviteCode === s.inviteCode,
        "FORBIDDEN",
        "邀请码无效",
        403,
      );
      requireThat(str(b.name, 50) && s.actors.length < 8);
      requireThat(s.story.status === "active", "ENDED", "冒险已经结束", 409);
      s.story.pending = null;
      requireThat(
        s.mode === "exploration",
        "INVALID_INPUT",
        "战斗中暂不可加入",
      );
      const actor: Actor = {
        id: randomUUID(),
        name: b.name,
        hp: 20,
        maxHp: 20,
        ac: 12,
        bonus: 3,
        stamina: s.rule.parameters.maxStamina,
      };
      const playerToken = token();
      const identity: Identity = {
        token: playerToken,
        role: "player",
        actorId: actor.id,
      };
      s.actors.push(actor);
      s.identities.push(identity);
      s.personal[actor.id] = s.scenario.personalSecrets.length
        ? [
            s.scenario.personalSecrets[
              (s.actors.length - 1) % s.scenario.personalSecrets.length
            ],
          ]
        : [];
      s.version++;
      this.event(s, "join", `${actor.name} 加入冒险。`);
      this.event(s, "personal", s.personal[actor.id].join(" "), actor.id);
      await this.persist(s);
      return {
        playerToken,
        actorId: actor.id,
        session: this.view(s, identity),
      };
    });
  }
  async mutate(id: string, t: string, b: any, control = false) {
    return this.serial(id, async () => {
      const original = this.get(id);
      const i = this.identity(original, t);
      requireThat(object(b));
      exact(
        b,
        control
          ? ["requestId", "expectedVersion", "command"]
          : ["requestId", "expectedVersion", "kind", "payload"],
      );
      requireThat(str(b.requestId, 100) && Number.isInteger(b.expectedVersion));
      const key = `${i.actorId ?? "owner"}:${b.requestId}`;
      const fingerprint = JSON.stringify(b);
      const receipt = original.receipts[key];
      if (receipt) {
        requireThat(
          receipt.fingerprint === fingerprint,
          "IDEMPOTENCY_CONFLICT",
          "requestId 已用于其他内容",
          409,
        );
        return { session: receipt.view };
      }
      requireThat(
        b.expectedVersion === original.version,
        "VERSION_CONFLICT",
        "版本已更新，请刷新重试",
        409,
      );
      const s = structuredClone(original);
      s.version++;
      if (control) {
        requireThat(i.role === "owner", "OWNER_REQUIRED", "仅房主可控制", 403);
        requireThat(["pause", "resume", "start_combat"].includes(b.command));
        requireThat(s.story.status === "active", "ENDED", "冒险已经结束", 409);
        s.story.pending = null;
        if (b.command === "pause") s.paused = true;
        if (b.command === "resume") s.paused = false;
        if (b.command === "start_combat") {
          requireThat(
            s.mode === "exploration" && s.actors.some((a) => a.hp > 0),
            "INVALID_INPUT",
            "需要存活玩家且不在战斗中",
          );
          s.mode = "combat";
          s.enemies = [
            {
              id: "gear-guard",
              name: "齿轮守卫",
              hp: 18,
              maxHp: 18,
              ac: 11,
              bonus: 2,
              stamina: 99,
            },
          ];
          s.turnActorId = s.actors.find((a) => a.hp > 0)!.id;
          for (const a of s.actors) a.stamina = s.rule.parameters.maxStamina;
        }
        this.event(
          s,
          "control",
          (
            {
              pause: "房主暂停冒险。",
              resume: "房主恢复冒险。",
              start_combat: "演示战斗开始：齿轮守卫出现。",
            } as any
          )[b.command],
        );
      } else {
        requireThat(
          i.role === "player",
          "PLAYER_REQUIRED",
          "请使用玩家身份行动",
          403,
        );
        requireThat(!s.paused, "PAUSED", "冒险已暂停", 409);
        requireThat(object(b.payload));
        exact(b.payload, [
          "text",
          "skill",
          "dc",
          "targetId",
          "sceneId",
          "proposalId",
        ]);
        if (s.story.status !== "active")
          requireThat(b.kind === "say", "ENDED", "冒险已经结束", 409);
        const a = s.actors.find((a) => a.id === i.actorId)!;
        requireThat(
          a.hp > 0 || (s.story.status !== "active" && b.kind === "say"),
          "FORBIDDEN",
          "角色已倒下",
          403,
        );
        requireThat(
          [
            "say",
            "check",
            "attack",
            "end_turn",
            "move",
            "interact",
            "rest",
            "retreat",
            "confirm",
            "cancel",
          ].includes(b.kind),
        );
        const p = { ...b.payload };
        let description = "";
        let triggerAction: GameAction | undefined;
        let checkSuccess: boolean | undefined;
        const emit = (type: string, text: string, audience?: string) =>
          this.event(s, type, text, audience);
        if (b.kind === "confirm" || b.kind === "cancel") {
          exact(p, ["proposalId"]);
          const pending = s.story.pending;
          requireThat(
            pending &&
              pending.id === p.proposalId &&
              pending.actorId === a.id &&
              pending.version === original.version,
            "INVALID_PROPOSAL",
            "提案无效、已过期或属于其他玩家",
            409,
          );
          s.story.pending = null;
          if (b.kind === "cancel") {
            this.event(s, "cancel", "已取消提案。");
            b = { ...b, kind: "noop", payload: {} };
          } else {
            b = { ...b, ...pending.action };
            delete p.proposalId;
            Object.assign(p, pending.action.payload);
            this.event(s, "confirm", "玩家确认提案。");
          }
        } else s.story.pending = null;
        if (b.kind === "say") {
          requireThat(str(p.text));
          exact(p, ["text"]);
          description = a.name + "：" + p.text;
          this.event(s, "say", description);
          if (s.story.status !== "active")
            this.event(
              s,
              "dialogue",
              "冒险已结束。你可以回顾记录、导出存档，或新建冒险。",
            );
          else {
            const ctx = this.directorContext(s, p.text!);
            const model = this.models.get(s.provider)!;
            let d = model.interpret
              ? validateDecision(await model.interpret(ctx))
              : ({
                  type: "dialogue",
                  message: "你向同伴说话。",
                  action: null,
                } as Decision);
            if (
              (d.type === "action" || d.type === "proposal") &&
              needsClarification(p.text!)
            )
              d = {
                type: "clarification",
                message:
                  "这句话包含提问、引用、条件或非当前行动。请明确本次要执行的单一动作。",
                action: null,
              };
            if (d.type === "action" || d.type === "proposal") {
              requireThat(
                d.action &&
                  ctx.affordances.some((x) => sameAction(x.action, d.action)),
                "INVALID_DECISION",
                "导演动作不属于当前公开能力",
                409,
              );
              if (d.type === "proposal") {
                s.story.pending = {
                  id: randomUUID(),
                  actorId: a.id,
                  version: s.version,
                  action: d.action!,
                  message: d.message,
                };
                this.event(s, "proposal", "待确认：" + d.message);
              } else {
                this.event(
                  s,
                  "decision",
                  "执行：" +
                    ctx.affordances.find((x) => sameAction(x.action, d.action))!
                      .label,
                );
                await this.executeDirected(s, a, d.action!, emit);
              }
            } else this.event(s, d.type, d.message || "你向同伴说话。");
            this.event(
              s,
              "kp",
              await model.narrate(
                this.publicContext(
                  s,
                  d.type === "action"
                    ? "根据本轮已批准事件叙述结果。"
                    : d.message || description,
                ),
              ),
            );
          }
        } else if (
          b.kind === "interact" ||
          b.kind === "rest" ||
          b.kind === "retreat"
        ) {
          await this.executeDirected(s, a, { kind: b.kind, payload: p }, emit);
        } else if (b.kind === "noop") {
        } else if (b.kind === "move") {
          requireThat(
            s.mode === "exploration",
            "INVALID_INPUT",
            "战斗中不能切换场景",
          );
          exact(p, ["sceneId"]);
          const current = s.scenario.scenes.find((n) => n.id === s.sceneId)!;
          const target = s.scenario.scenes.find((n) => n.id === p.sceneId);
          requireThat(
            target &&
              s.story.paths.some(
                (x) => x.from === current.id && x.to === target.id,
              ),
            "INVALID_INPUT",
            "地点不可直接到达",
          );
          s.sceneId = target.id;
          if (!s.story.discovered.includes(target.id))
            s.story.discovered.push(target.id);
          triggerAction = { kind: "move", payload: { sceneId: target.id } };
          s.location = target.name;
          this.event(
            s,
            "move",
            `${a.name} 带领队伍来到${target.name}。${target.description}`,
          );
        } else if (b.kind === "check" || b.kind === "attack") {
          requireThat(
            s.mode !== "combat" || s.turnActorId === a.id,
            "WRONG_TURN",
            "尚未轮到你的角色",
            409,
          );
          requireThat(a.stamina > 0, "INSUFFICIENT_RESOURCE", "体力不足", 409);
          if (b.kind === "check") {
            exact(p, ["skill", "dc"]);
            const dc = p.dc ?? s.rule.parameters.defaultDc;
            requireThat(
              Number.isInteger(dc) &&
                dc >= 5 &&
                dc <= 25 &&
                (!p.skill || str(p.skill, 40)),
            );
            const { roll } = ruleEngines
              .get(s.rule.engine)
              .check(a, dc, this.dice);
            a.stamina--;
            this.event(
              s,
              "check",
              `${a.name} ${p.skill ?? "自由"}检定：d20(${roll})+${a.bonus}=${roll + a.bonus} / DC ${dc}，${roll + a.bonus >= dc ? "成功" : "失败"}。自由检定不揭示剧本秘密。`,
            );
          } else {
            exact(p, ["targetId"]);
            requireThat(
              s.mode === "combat",
              "INVALID_INPUT",
              "攻击需要战斗模式",
            );
            const enemy = s.enemies.find(
              (e) => e.id === p.targetId && e.hp > 0,
            );
            requireThat(enemy, "INVALID_INPUT", "目标无效");
            a.stamina--;
            const { roll, damage } = ruleEngines
              .get(s.rule.engine)
              .attack(a, enemy, s.rule.parameters, this.dice);
            enemy.hp = Math.max(0, enemy.hp - damage);
            triggerAction = { kind: "attack", payload: { targetId: enemy.id } };
            this.event(
              s,
              "attack",
              `${a.name} 攻击 ${enemy.name}：d20(${roll})+${a.bonus}，造成 ${damage} 伤害。`,
            );
            if (s.enemies.every((e) => e.hp === 0)) {
              s.mode = "exploration";
              s.turnActorId = null;
              this.event(s, "combat", "守卫停止运转，战斗结束。");
            }
          }
        } else if (b.kind === "end_turn") {
          exact(p, []);
          requireThat(s.mode === "combat", "INVALID_INPUT", "当前不在战斗");
          requireThat(
            s.turnActorId === a.id,
            "WRONG_TURN",
            "尚未轮到你的角色",
            409,
          );
          const enemy = s.enemies.find((e) => e.hp > 0);
          if (enemy) {
            const roll = this.dice.roll(20);
            const damage = roll + enemy.bonus >= a.ac ? this.dice.roll(4) : 0;
            a.hp = Math.max(0, a.hp - damage);
            this.event(
              s,
              "attack",
              `${enemy.name} 反击 ${a.name}，造成 ${damage} 伤害。`,
            );
          }
          const alive = s.actors.filter((a) => a.hp > 0);
          if (!alive.length) {
            s.mode = "exploration";
            s.turnActorId = null;
            this.event(s, "combat", "队伍倒下。请恢复存档或另开冒险。");
            if (s.scenario.story)
              applyEffects(s, [{ type: "ending", id: "defeat" }], a.id, emit);
          } else {
            s.turnActorId = s.actors
              .slice(s.actors.findIndex((x) => x.id === a.id) + 1)
              .concat(s.actors)
              .find((x) => x.hp > 0)!.id;
            const next = s.actors.find((x) => x.id === s.turnActorId)!;
            next.stamina = Math.min(
              s.rule.parameters.maxStamina,
              next.stamina + 2,
            );
            this.event(s, "turn", `轮到 ${next.name}。`);
          }
        } else requireThat(false, "INVALID_INPUT", "不支持此行动");
        if (triggerAction && s.story.status === "active")
          runTriggers(
            s,
            { action: triggerAction, success: checkSuccess, actorId: a.id },
            emit,
          );
      }
      const view = this.view(s, i);
      s.receipts[key] = { fingerprint, view };
      await this.persist(s);
      return { session: view };
    });
  }
  directorContext(s: State, text: string): DirectorContext {
    const affordances: Affordance[] = [];
    if (s.story.status === "active") {
      if (s.mode === "exploration") {
        for (const x of available(s))
          affordances.push({
            label: x.label,
            aliases: x.aliases,
            action: { kind: "interact", payload: { targetId: x.id } },
          });
        for (const p of s.story.paths.filter((p) => p.from === s.sceneId)) {
          const scene = s.scenario.scenes.find((x) => x.id === p.to)!;
          affordances.push({
            label: `进入${scene.name}`,
            aliases: [
              `去${scene.name}`,
              `前往${scene.name}`,
              `进入${scene.name.replace(/^潮湿/, "")}`,
              `回到${scene.name}`,
            ],
            action: { kind: "move", payload: { sceneId: scene.id } },
          });
        }
        affordances.push({
          label: "休整",
          aliases: ["休息", "恢复体力"],
          action: { kind: "rest", payload: {} },
        });
      } else {
        for (const e of s.enemies.filter((e) => e.hp > 0))
          affordances.push({
            label: `攻击${e.name}`,
            aliases: ["攻击守卫"],
            action: { kind: "attack", payload: { targetId: e.id } },
          });
        affordances.push({
          label: "结束回合",
          aliases: ["防御等待"],
          action: { kind: "end_turn", payload: {} },
        });
      }
      if (s.scenario.story)
        affordances.push({
          label: "撤退",
          aliases: ["返回码头", "放弃任务"],
          action: { kind: "retreat", payload: {} },
        });
      affordances.push({
        label: "自由检定",
        aliases: ["进行检定"],
        action: { kind: "check", payload: {} },
      });
    }
    return {
      ...this.publicContext(s, text),
      affordances,
      status: s.story.status,
      inventory: this.view(s, s.identities[0]).inventory,
    };
  }
  private async executeDirected(
    s: State,
    a: Actor,
    action: GameAction,
    emit: (type: string, text: string, audience?: string) => void,
  ) {
    requireThat(s.story.status === "active", "ENDED", "冒险已经结束", 409);
    requireThat(!s.paused, "PAUSED", "冒险已暂停", 409);
    requireThat(
      s.mode !== "combat" || s.turnActorId === a.id,
      "WRONG_TURN",
      "尚未轮到你的角色",
      409,
    );
    const { kind, payload: p } = action;
    let success: boolean | undefined;
    if (kind === "interact") {
      exact(p, ["targetId"]);
      requireThat(
        s.mode === "exploration",
        "INVALID_INPUT",
        "战斗中不能操作场景",
      );
      const x = available(s).find((x) => x.id === p.targetId);
      requireThat(x, "INVALID_TARGET", "交互目标不可见或前置条件未满足", 409);
      emit("interact", `${a.name}：${x.label}`);
      if (x.check) {
        requireThat(
          a.stamina >= x.check.cost,
          "INSUFFICIENT_RESOURCE",
          "体力不足，请休整",
          409,
        );
        const result = ruleEngines
          .get(s.rule.engine)
          .check(a, x.check.dc, this.dice);
        success = result.success;
        a.stamina -= x.check.cost;
        emit(
          "check",
          `${a.name} ${x.label}：d20(${result.roll})+${a.bonus} / DC ${x.check.dc}，${success ? "成功" : "失败"}。`,
        );
      }
      applyEffects(
        s,
        success === false ? x.failureEffects : x.effects,
        a.id,
        emit,
      );
    } else if (kind === "move") {
      exact(p, ["sceneId"]);
      requireThat(s.mode === "exploration", "INVALID_INPUT", "战斗中不能移动");
      const target = s.scenario.scenes.find((x) => x.id === p.sceneId);
      requireThat(
        target &&
          s.story.paths.some((x) => x.from === s.sceneId && x.to === target.id),
        "INVALID_TARGET",
        "地点不可达",
        409,
      );
      s.sceneId = target.id;
      s.location = target.name;
      if (!s.story.discovered.includes(target.id))
        s.story.discovered.push(target.id);
      emit(
        "move",
        `${a.name} 带领队伍来到${target.name}。${target.description}`,
      );
    } else if (kind === "rest") {
      exact(p, []);
      requireThat(s.mode === "exploration", "INVALID_INPUT", "战斗中不能休整");
      a.stamina = s.rule.parameters.maxStamina;
      emit("rest", `${a.name} 花时间休整，恢复体力。暴风仍在逼近。`);
    } else if (kind === "retreat") {
      exact(p, []);
      requireThat(
        s.scenario.story?.endings.some((e) => e.id === "retreat"),
        "INVALID_INPUT",
        "剧本没有撤退结局",
      );
      applyEffects(s, [{ type: "ending", id: "retreat" }], a.id, emit);
    } else if (kind === "check") {
      exact(p, []);
      requireThat(a.stamina > 0, "INSUFFICIENT_RESOURCE", "体力不足", 409);
      const dc = s.rule.parameters.defaultDc;
      const r = ruleEngines.get(s.rule.engine).check(a, dc, this.dice);
      a.stamina--;
      emit(
        "check",
        `${a.name} 自由检定：d20(${r.roll})+${a.bonus} / DC ${dc}，${r.success ? "成功" : "失败"}。自由检定不触发剧情。`,
      );
      return;
    } else if (kind === "attack") {
      exact(p, ["targetId"]);
      requireThat(s.mode === "combat", "INVALID_INPUT", "攻击需要战斗模式");
      requireThat(
        a.stamina > 0,
        "INSUFFICIENT_RESOURCE",
        "体力不足，请结束回合",
        409,
      );
      const e = s.enemies.find((e) => e.id === p.targetId && e.hp > 0);
      requireThat(e, "INVALID_TARGET", "目标无效");
      const r = ruleEngines
        .get(s.rule.engine)
        .attack(a, e, s.rule.parameters, this.dice);
      a.stamina--;
      e.hp = Math.max(0, e.hp - r.damage);
      emit(
        "attack",
        `${a.name} 攻击 ${e.name}：d20(${r.roll})+${a.bonus}，造成 ${r.damage} 伤害。`,
      );
      if (s.enemies.every((e) => e.hp === 0)) {
        s.mode = "exploration";
        s.turnActorId = null;
        emit("combat", "守卫停止运转，战斗结束。");
      }
    } else if (kind === "end_turn") {
      exact(p, []);
      requireThat(s.mode === "combat", "INVALID_INPUT", "当前不在战斗");
      for (const e of s.enemies.filter((e) => e.hp > 0)) {
        const damage =
          this.dice.roll(20) + e.bonus >= a.ac ? this.dice.roll(4) : 0;
        a.hp = Math.max(0, a.hp - damage);
        emit("attack", `${e.name} 反击 ${a.name}，造成 ${damage} 伤害。`);
      }
      const alive = s.actors.filter((x) => x.hp > 0);
      if (!alive.length) {
        if (s.scenario.story)
          applyEffects(s, [{ type: "ending", id: "defeat" }], a.id, emit);
        else {
          s.mode = "exploration";
          s.turnActorId = null;
        }
      } else {
        const next = s.actors
          .slice(s.actors.indexOf(a) + 1)
          .concat(s.actors)
          .find((x) => x.hp > 0)!;
        s.turnActorId = next.id;
        next.stamina = Math.min(s.rule.parameters.maxStamina, next.stamina + 2);
        emit("turn", `轮到 ${next.name}。`);
      }
    }
    if (s.story.status === "active")
      runTriggers(s, { action, success, actorId: a.id }, emit);
  }
  exportSave(s: State) {
    const { identities, inviteCode, qq, receipts, ...save } =
      structuredClone(s);
    return { format: "ai-kp-save-v1", state: save };
  }
  validateSave(save: any) {
    requireThat(
      object(save) && save.format === "ai-kp-save-v1" && object(save.state),
      "INVALID_SAVE",
      "存档格式无效",
    );
    const s = structuredClone(save.state);
    exact(save, ["format", "state"]);
    exact(s, [
      "id",
      "name",
      "version",
      "provider",
      "paused",
      "mode",
      "location",
      "sceneId",
      "actors",
      "enemies",
      "turnActorId",
      "events",
      "rule",
      "scenario",
      "personal",
      "story",
    ]);
    if (!s.story) {
      s.story = initialStory(s.scenario);
      if (!s.story.discovered.includes(s.sceneId))
        s.story.discovered.push(s.sceneId);
    }
    validatePackage(s.rule);
    validatePackage(s.scenario);
    requireThat(
      s.rule.kind === "rules" &&
        s.scenario.kind === "scenario" &&
        str(s.name, 100) &&
        Number.isInteger(s.version) &&
        s.version >= 0 &&
        this.models.has(s.provider) &&
        typeof s.paused === "boolean" &&
        ["exploration", "combat"].includes(s.mode) &&
        str(s.location, 200) &&
        s.scenario.scenes.some((n: any) => n.id === s.sceneId),
      "INVALID_SAVE",
      "存档字段无效",
    );
    requireThat(
      Array.isArray(s.actors) &&
        s.actors.length <= 8 &&
        Array.isArray(s.enemies) &&
        s.enemies.length <= 20 &&
        Array.isArray(s.events) &&
        s.events.length <= 10000 &&
        object(s.personal),
      "INVALID_SAVE",
      "存档集合无效",
    );
    const ids = new Set<string>();
    for (const a of [...s.actors, ...s.enemies]) {
      requireThat(
        object(a) &&
          str(a.id, 100) &&
          !ids.has(a.id) &&
          str(a.name, 50) &&
          [a.hp, a.maxHp, a.ac, a.bonus, a.stamina].every(Number.isInteger) &&
          a.hp >= 0 &&
          a.hp <= a.maxHp &&
          a.maxHp <= 1000 &&
          a.maxHp > 0 &&
          a.stamina >= 0 &&
          a.stamina <= 1000 &&
          a.ac >= 0 &&
          a.ac <= 100 &&
          a.bonus >= -20 &&
          a.bonus <= 100,
        "INVALID_SAVE",
        "角色数据无效",
      );
      exact(a, ["id", "name", "hp", "maxHp", "ac", "bonus", "stamina"]);
      ids.add(a.id);
    }
    const actorIds = s.actors.map((a: Actor) => a.id);
    requireThat(
      (s.mode === "exploration" && s.turnActorId === null) ||
        (s.mode === "combat" &&
          s.actors.some((a: Actor) => a.id === s.turnActorId && a.hp > 0) &&
          s.enemies.some((a: Actor) => a.hp > 0)),
      "INVALID_SAVE",
      "回合引用无效",
    );
    for (const e of s.events) {
      requireThat(
        object(e) &&
          str(e.id, 100) &&
          Number.isInteger(e.version) &&
          e.version >= 0 &&
          e.version <= s.version &&
          str(e.type, 50) &&
          str(e.text, 10000) &&
          ["public", "owner", ...actorIds].includes(e.audience),
        "INVALID_SAVE",
        "事件引用无效",
      );
      exact(e, ["id", "version", "type", "text", "audience"]);
    }
    for (const [id, secrets] of Object.entries(s.personal))
      requireThat(
        actorIds.includes(id) &&
          Array.isArray(secrets) &&
          secrets.every((v) => str(v, 4000)),
        "INVALID_SAVE",
        "个人秘密引用无效",
      );
    this.validateStoryState(s as State);
    return s;
  }
  async restore(save: any) {
    const raw = this.validateSave(save);
    const s = structuredClone(raw) as State;
    s.id = randomUUID();
    s.inviteCode = token();
    s.identities = [{ token: token(), actorId: null, role: "owner" }];
    s.qq = {};
    s.receipts = {};
    s.story.pending = null;
    for (const a of s.actors)
      s.identities.push({ token: token(), actorId: a.id, role: "player" });
    await this.persist(s);
    return {
      ownerToken: s.identities[0].token,
      inviteCode: s.inviteCode,
      session: this.view(s, s.identities[0]),
      recoveredPlayers: s.identities
        .filter((i) => i.role === "player")
        .map((i) => ({ actorId: i.actorId, playerToken: i.token })),
    };
  }
  async bind(id: string, t: string, b: any) {
    return this.serial(id, async () => {
      const s = structuredClone(this.get(id));
      requireThat(
        this.identity(s, t).role === "owner",
        "OWNER_REQUIRED",
        "仅房主可绑定",
        403,
      );
      requireThat(str(b.qqUserId, 100) && str(b.playerToken, 100));
      const i = this.identity(s, b.playerToken);
      requireThat(i.role === "player");
      s.qq[b.qqUserId] = i.token;
      await this.persist(s);
      return { bound: true };
    });
  }
  async qq(b: any) {
    requireThat(
      object(b) &&
        str(b.sessionId, 100) &&
        str(b.qqUserId, 100) &&
        str(b.eventId, 100) &&
        str(b.text),
    );
    const normalized = extensions.channels.get("qq-simulated")!.normalize(b);
    const s = this.get(b.sessionId);
    const t = Object.hasOwn(s.qq, normalized.externalUserId)
      ? s.qq[normalized.externalUserId]
      : undefined;
    requireThat(t, "FORBIDDEN", "QQ 身份尚未绑定", 403);
    return {
      ...(await this.mutate(s.id, t, {
        requestId: "qq:" + normalized.eventId,
        expectedVersion: b.expectedVersion,
        kind: "say",
        payload: { text: normalized.text },
      })),
      channel: "qq-simulated",
    };
  }
}
