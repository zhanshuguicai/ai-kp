import test from "node:test";
import assert from "node:assert/strict";
import { GameService } from "../src/game.js";
import { MemoryStore, validatePackage } from "../src/foundation.js";
import { providers, HttpKP, type KPProvider } from "../src/providers.js";
import { adventure } from "../src/adventure.js";
import type { Decision, ProviderId } from "../src/contracts.js";
import { validateDecision } from "../src/director.js";
async function fixture(
  models = providers({}),
  dice = { roll: (n: number) => n },
  scenario: any = undefined,
) {
  const store = new MemoryStore(),
    g = new GameService(store, models, dice);
  await g.init();
  if (scenario) await g.importPackage(scenario);
  const room = await g.create({
    name: "v2",
    ...(scenario ? { scenarioId: scenario.id } : {}),
  });
  const id = room.session.id;
  const p = await g.join(id, { inviteCode: room.inviteCode, name: "旅人" });
  let counter = 0;
  const act = (kind: string, payload: any = {}, token = p.playerToken) =>
    g.mutate(id, token, {
      requestId: "r" + ++counter,
      expectedVersion: g.get(id).version,
      kind,
      payload,
    });
  const say = (text: string) => act("say", { text });
  const view = () => g.view(g.get(id), g.identity(g.get(id), p.playerToken));
  return { g, id, room, p, act, say, view, store };
}
test("v2 peaceful entire natural-language adventure reaches explicit ending, ending protects mutation", async () => {
  const f = await fixture();
  const route = [
    "调查旧箱",
    "进入地窖",
    "摇响铜铃",
    "进入蓝灯室",
    "修复灯芯",
    "点亮蓝灯",
  ];
  for (const text of route) await f.say(text);
  const v = f.view();
  assert.equal(v.status, "won");
  assert.equal(v.ending?.id, "light");
  assert.equal(v.inventory[0].quantity, 1);
  assert(v.objectives.every((x) => x.completed));
  assert.equal(
    f.g.get(f.id).story.fired.filter((x) => x === "open-beacon").length,
    1,
  );
  console.log(
    "PEACE ROUTE",
    JSON.stringify({
      inputs: route,
      status: v.status,
      ending: v.ending,
      events: v.events
        .filter((e) =>
          ["inventory", "move", "reveal", "objective", "ending"].includes(
            e.type,
          ),
        )
        .map((e) => e.text),
    }),
  );
  await assert.rejects(f.act("rest"), (e: any) => e.code === "ENDED");
  await f.say("谢谢");
  assert.equal(f.view().status, "won");
  await assert.rejects(
    f.g.join(f.id, { inviteCode: f.room.inviteCode, name: "late" }),
    (e: any) => e.code === "ENDED",
  );
});
test("v2 combat entire natural-language route and retreat failure ending", async () => {
  const f = await fixture();
  const route = [
    "进入地窖",
    "挑战守卫",
    "攻击齿轮守卫",
    "攻击齿轮守卫",
    "攻击齿轮守卫",
    "进入蓝灯室",
    "修复灯芯",
    "点亮蓝灯",
  ];
  for (const t of route) await f.say(t);
  assert.equal(f.view().status, "won");
  assert.equal(f.g.get(f.id).enemies[0].hp, 0);
  console.log(
    "COMBAT ROUTE",
    JSON.stringify({
      inputs: route,
      status: f.view().status,
      events: f
        .view()
        .events.filter((e) => ["attack", "combat", "ending"].includes(e.type))
        .map((e) => e.text),
    }),
  );
  const retreat = await fixture();
  await retreat.say("撤退");
  assert.equal(retreat.view().status, "lost");
  assert.equal(retreat.view().ending?.id, "retreat");
});
test("questions, quotation, negation, conditionals, multiple actions and ambiguity never spend resources", async () => {
  const f = await fixture();
  for (const text of [
    "如果攻击守卫会怎样",
    "我不攻击守卫",
    "不要调查旧箱",
    "“调查旧箱”",
    "调查旧箱然后进入地窖",
    "调查旧箱，进入地窖",
    "我可以调查旧箱吗",
    "攻击守卫有什么后果",
    "打开那个",
  ]) {
    await f.say(text);
    assert.equal(f.view().inventory.length, 0);
    assert.equal(f.g.get(f.id).actors[0].stamina, 6);
    assert.equal(f.view().sceneId, "entrance");
    assert.equal(
      f
        .view()
        .events.filter(
          (e) => e.version === f.view().version && e.type === "clarification",
        ).length,
      1,
      text,
    );
  }
});
test("public view and director context exclude locked scene, hidden flags, private clues and trigger effects", async () => {
  const f = await fixture();
  const v = JSON.stringify(f.view()),
    c = JSON.stringify(f.g.directorContext(f.g.get(f.id), "hello"));
  const context = f.g.directorContext(f.g.get(f.id), "hello");
  assert(context.opening?.includes("暴风将至"));
  assert.equal(context.scene?.id, "entrance");
  assert(context.scene?.npcs.some((n) => n.name === "码头信使"));
  assert(
    context.objectives?.some((o) => o.id === "light-beacon" && !o.completed),
  );
  for (const raw of [v, c])
    for (const secret of [
      "裂窗后的灯芯",
      "三声铃响，守卫止戈",
      "guard-cleared",
      "guard-victory",
      "第二道门后",
    ])
      assert(!raw.includes(secret), secret);
  assert(!f.view().scenes.some((s) => s.id === "beacon"));
  assert(!c.includes(f.g.get(f.id).personal[f.p.actorId][0]));
  await assert.rejects(
    f.act("interact", { targetId: "ring-bell" }),
    (e: any) => e.code === "INVALID_TARGET",
  );
  await f.say("进入地窖");
  await assert.rejects(
    f.act("interact", { targetId: "ring-bell" }),
    (e: any) => e.code === "INVALID_TARGET",
  );
  await assert.rejects(f.act("move", { sceneId: "beacon" }));
  await assert.rejects(f.act("interact", { targetId: "negotiate", dc: 5 }));
  await f.act("check", { dc: 5 });
  assert(!f.g.get(f.id).story.flags["guard-cleared"]);
});
test("provider may not invent DC, resource, actor or hidden action; malformed decision rejected", async () => {
  const models = providers({});
  models.set("mock", {
    id: "mock",
    ready: true,
    interpret: async () => ({
      type: "action",
      message: "override",
      action: { kind: "interact", payload: { targetId: "search-box", dc: 5 } },
    }),
    narrate: async () => "ok",
  });
  const f = await fixture(models);
  const before = structuredClone(f.g.get(f.id));
  await assert.rejects(
    f.say("调查旧箱"),
    (e: any) => e.code === "INVALID_DECISION",
  );
  assert.deepEqual(f.g.get(f.id), before);
  for (const d of [
    {
      type: "action",
      message: "x",
      action: {
        kind: "interact",
        payload: { targetId: "search-box", flags: { a: true } },
      },
    },
    { type: "dialogue", message: "x", action: { kind: "rest", payload: {} } },
  ])
    assert.throws(() => validateDecision(d));
});
test("proposals bind actor/version/id, can confirm or cancel once, expire on another mutation", async () => {
  const f = await fixture();
  await f.say("建议调查旧箱");
  const pending = f.view().pending!;
  assert(pending);
  assert.equal(f.view().inventory.length, 0);
  const other = await f.g.join(f.id, {
    inviteCode: f.room.inviteCode,
    name: "B",
  });
  assert.equal(f.view().pending, null);
  await assert.rejects(
    f.act("confirm", { proposalId: pending.id }, other.playerToken),
    (e: any) => e.code === "INVALID_PROPOSAL",
  );
  await f.say("建议调查旧箱");
  const p = f.view().pending!;
  assert.equal(
    f.g.view(f.g.get(f.id), f.g.identity(f.g.get(f.id), other.playerToken))
      .pending,
    null,
  );
  await assert.rejects(
    f.act("confirm", { proposalId: p.id }, other.playerToken),
    (e: any) => e.code === "INVALID_PROPOSAL",
  );
  await f.act("cancel", { proposalId: p.id });
  assert.equal(f.view().inventory.length, 0);
  await assert.rejects(
    f.act("confirm", { proposalId: p.id }),
    (e: any) => e.code === "INVALID_PROPOSAL",
  );
  await f.say("建议调查旧箱");
  await f.act("confirm", { proposalId: f.view().pending!.id });
  assert.equal(f.view().inventory[0].quantity, 1);
  await assert.rejects(
    f.act("confirm", { proposalId: p.id }),
    (e: any) => e.code === "INVALID_PROPOSAL",
  );
});
test("narrative failure after action/trigger has no partial item, stamina, scene or ending commit", async () => {
  const models = providers({});
  const mock = models.get("mock")!;
  models.set("mock", {
    ...mock,
    narrate: async () => {
      throw new Error("failure");
    },
  });
  const f = await fixture(models);
  const before = structuredClone(f.g.get(f.id));
  await assert.rejects(f.say("调查旧箱"));
  assert.deepEqual(f.g.get(f.id), before);
});
test("check failure can retry after rest, no single failure softlock; manual and language share authoritative cost", async () => {
  let high = false;
  const f = await fixture(providers({}), { roll: (n) => (high ? n : 1) });
  await f.say("进入地窖");
  for (let n = 0; n < 6; n++) await f.say("请求守卫通行");
  assert.equal(f.g.get(f.id).actors[0].stamina, 0);
  const before = structuredClone(f.g.get(f.id));
  await assert.rejects(
    f.say("请求守卫通行"),
    (e: any) => e.code === "INSUFFICIENT_RESOURCE",
  );
  assert.deepEqual(f.g.get(f.id), before);
  await f.say("休整");
  high = true;
  await f.say("请求守卫通行");
  await f.say("进入蓝灯室");
  high = false;
  await f.say("修复灯芯");
  assert(!f.g.get(f.id).story.flags["wick-fixed"]);
  await f.say("休整");
  high = true;
  await f.act("interact", { targetId: "repair-wick" });
  await f.say("点亮蓝灯");
  assert.equal(f.view().status, "won");
});
test("one-time rewards, repeat triggers bounded per action, cycles terminate and restart/restore retain fired state", async () => {
  const scenario = structuredClone(adventure);
  scenario.id = "repeat-test";
  scenario.story!.triggers.push({
    id: "repeat",
    once: false,
    conditions: [{ type: "scene", id: "entrance" }],
    effects: [{ type: "reveal", text: "repeat marker", audience: "public" }],
  });
  const f = await fixture(providers({}), undefined, scenario);
  await f.say("调查旧箱");
  assert.equal(
    f.view().events.filter((e) => e.text === "repeat marker").length,
    1,
  );
  await f.say("休整");
  assert.equal(
    f.view().events.filter((e) => e.text === "repeat marker").length,
    2,
  );
  assert.equal(f.view().inventory[0].quantity, 1);
  const restarted = new GameService(f.store, providers({}));
  await restarted.init();
  assert.equal(restarted.get(f.id).story.inventory.bell, 1);
  const r = await restarted.restore(restarted.exportSave(restarted.get(f.id)));
  assert.equal(r.session.inventory[0].quantity, 1);
  assert.equal(r.session.version, f.view().version);
  const bad = structuredClone(restarted.exportSave(restarted.get(f.id)));
  bad.state.story.inventory.bogus = 1;
  await assert.rejects(restarted.restore(bad));
});
test("trigger total execution limit rolls back and private reveal stays private", async () => {
  const scenario = structuredClone(adventure);
  scenario.id = "trigger-limit";
  scenario.story!.triggers = Array.from({ length: 65 }, (_, n) => ({
    id: "t-" + n,
    once: true,
    conditions: [{ type: "scene" as const, id: "entrance" }],
    effects: [
      {
        type: "reveal" as const,
        text: "private marker",
        audience: "actor" as const,
      },
    ],
  }));
  const f = await fixture(providers({}), undefined, scenario);
  const before = structuredClone(f.g.get(f.id));
  await assert.rejects(
    f.say("调查旧箱"),
    (e: any) => e.code === "TRIGGER_LIMIT",
  );
  assert.deepEqual(f.g.get(f.id), before);
  scenario.id = "private-test";
  scenario.story!.triggers = scenario.story!.triggers.slice(0, 1);
  const p = await fixture(providers({}), undefined, scenario);
  await p.say("调查旧箱");
  assert(p.view().events.some((e) => e.text === "private marker"));
  assert(
    !JSON.stringify(p.g.publicContext(p.g.get(p.id), "hello")).includes(
      "private marker",
    ),
  );
  assert(
    !JSON.stringify(
      p.g.view(p.g.get(p.id), p.g.get(p.id).identities[0]),
    ).includes("private marker"),
  );
});
test("package references, contradictory flags, duplicate ids and prototype ids are rejected", () => {
  for (const change of [
    (p: any) =>
      p.story.interactions[0].effects.push({
        type: "item",
        id: "missing",
        quantity: 1,
      }),
    (p: any) => p.story.flags.push("constructor"),
    (p: any) => p.story.triggers.push(p.story.triggers[0]),
    (p: any) =>
      p.story.interactions[0].conditions.push({
        type: "flag",
        id: "bell-found",
        value: true,
      }),
  ]) {
    const p = structuredClone(adventure);
    change(p);
    assert.throws(() => validatePackage(p));
  }
});
test("legacy v1 packages and save without story normalize without reset; exact versions selected", async () => {
  const f = await fixture();
  const old = await f.g.create({ name: "old", scenarioVersion: "1.0.0" });
  assert.equal(old.session.scenario.version, "1.0.0");
  const save: any = f.g.exportSave(f.g.get(old.session.id));
  delete save.state.story;
  const r = await f.g.restore(save);
  assert.equal(r.session.version, 0);
  assert.equal(r.session.sceneId, "entrance");
  assert.equal(r.session.scenario.version, "1.0.0");
  await assert.rejects(f.g.create({ name: "bad", scenarioVersion: "8.0.0" }));
});
test("QQ simulator uses natural-language director, idempotency and story entry", async () => {
  const f = await fixture();
  await f.g.bind(f.id, f.room.ownerToken, {
    qqUserId: "qq",
    playerToken: f.p.playerToken,
  });
  const request = {
    sessionId: f.id,
    qqUserId: "qq",
    eventId: "x",
    text: "调查旧箱",
    expectedVersion: 1,
  };
  const a = await f.g.qq(request);
  assert.equal(a.session.inventory[0].quantity, 1);
  assert.deepEqual(await f.g.qq(request), a);
});
const wire = (id: Exclude<ProviderId, "mock">, raw: string) =>
  id === "openai"
    ? {
        status: "completed",
        output: [{ content: [{ type: "output_text", text: raw }] }],
      }
    : id === "anthropic"
      ? { stop_reason: "end_turn", content: [{ type: "text", text: raw }] }
      : {
          status: "completed",
          steps: [
            { type: "model_output", content: [{ type: "text", text: raw }] },
          ],
        };
for (const id of ["openai", "anthropic", "gemini"] as const) {
  test(`${id} structured interpret schema, reversed JSON key order and complete GameService action+narration via injected transport`, async () => {
    let calls = 0;
    const models = providers({});
    const http = new HttpKP(
      id,
      "TEST-ONLY",
      "test-model",
      async (_url, init) => {
        calls++;
        const b = JSON.parse(init.body as string),
          schema =
            id === "openai"
              ? b.text.format.schema
              : id === "anthropic"
                ? b.output_config.format.schema
                : b.response_format.schema;
        const interpret = !!schema.properties.type;
        const input = id === "anthropic" ? b.messages[0].content : b.input;
        assert(!input.includes("guard-cleared"));
        assert(!input.includes("第二道门后"));
        return Response.json(
          wire(
            id,
            JSON.stringify(
              interpret
                ? {
                    type: "action",
                    message: "调查",
                    action: {
                      payload: {
                        targetId: "search-box",
                        sceneId: null,
                        skill: null,
                        dc: null,
                      },
                      kind: "interact",
                    },
                  }
                : { narration: "你拿到了铜铃。" },
            ),
          ),
        );
      },
    );
    models.set("mock", {
      id: "mock",
      ready: true,
      interpret: (c) => http.interpret(c),
      narrate: (c) => http.narrate(c),
    });
    const f = await fixture(models);
    await f.say("调查旧箱");
    assert.equal(calls, 2);
    assert.equal(f.view().inventory[0].quantity, 1);
  });
  test(`${id} interpret errors, malformed payload, refusal, truncation and timeout fail without paid fallback`, async () => {
    const f = await fixture();
    const ctx = f.g.directorContext(f.g.get(f.id), "调查旧箱");
    for (const response of [
      wire(id, "plain"),
      wire(
        id,
        JSON.stringify({
          type: "action",
          message: "bad",
          action: { kind: "set_flag", payload: {} },
        }),
      ),
      id === "anthropic"
        ? { stop_reason: "refusal" }
        : { status: "incomplete" },
      id === "openai"
        ? { status: "completed", output: [{ content: [{ type: "refusal" }] }] }
        : { status: "completed" },
    ])
      await assert.rejects(
        new HttpKP(id, "TEST", "m", async () =>
          Response.json(response),
        ).interpret(ctx),
        (e: any) => e.code === "PROVIDER_FAILURE",
      );
    await assert.rejects(
      new HttpKP(
        id,
        "TEST",
        "m",
        async () => new Promise(() => {}),
        5,
      ).interpret(ctx),
      (e: any) => e.code === "PROVIDER_FAILURE",
    );
  });
}

test("real director still interprets NPC questions, while erroneous question actions are blocked", async () => {
  let count = 0,
    evil = false;
  const models = providers({});
  models.set("mock", {
    id: "mock",
    ready: true,
    interpret: async () => {
      count++;
      return evil
        ? {
            type: "action",
            message: "bad",
            action: { kind: "interact", payload: { targetId: "search-box" } },
          }
        : {
            type: "dialogue",
            message: "信使说：可以调查入口旧箱。",
            action: null,
          };
    },
    narrate: async () => "信使等待你的决定。",
  });
  const f = await fixture(models);
  await f.say("信使为什么在这里？");
  assert.equal(count, 1);
  assert(f.view().events.some((e) => e.type === "dialogue"));
  assert.equal(f.view().inventory.length, 0);
  evil = true;
  await f.say("如果调查旧箱会怎样？");
  assert.equal(count, 2);
  assert.equal(f.view().inventory.length, 0);
  assert(
    f
      .view()
      .events.some(
        (e) => e.version === f.view().version && e.type === "clarification",
      ),
  );
  const local = await fixture();
  for (const text of [
    "我想到过攻击守卫",
    "昨天我攻击了守卫",
    "我在讨论攻击守卫",
  ]) {
    await local.say(text);
    assert.equal(local.view().mode, "exploration");
    assert(
      local
        .view()
        .events.some(
          (e) =>
            e.version === local.view().version && e.type === "clarification",
        ),
    );
  }
});
test("natural-language turn and pause boundaries reject state mutation without partial events", async () => {
  const f = await fixture();
  const b = await f.g.join(f.id, { inviteCode: f.room.inviteCode, name: "B" });
  await f.say("进入地窖");
  await f.say("挑战守卫");
  const before = structuredClone(f.g.get(f.id));
  await assert.rejects(
    f.act("say", { text: "攻击齿轮守卫" }, b.playerToken),
    (e: any) => e.code === "WRONG_TURN",
  );
  assert.deepEqual(f.g.get(f.id), before);
  await f.g.mutate(
    f.id,
    f.room.ownerToken,
    {
      requestId: "pause",
      expectedVersion: f.g.get(f.id).version,
      command: "pause",
    },
    true,
  );
  const paused = structuredClone(f.g.get(f.id));
  await assert.rejects(f.say("攻击齿轮守卫"), (e: any) => e.code === "PAUSED");
  assert.deepEqual(f.g.get(f.id), paused);
});
test("local narration does not recursively embed previous KP output; public history is bounded", async () => {
  const f = await fixture();
  for (let n = 0; n < 40; n++) await f.say("你好");
  const kp = f.view().events.filter((e) => e.type === "kp");
  assert(kp.every((e) => e.text.length < 500));
  assert(
    kp.slice(1).every((e) => e.text.split("【本地演示 KP】").length === 2),
  );
  const c = f.g.publicContext(f.g.get(f.id), "hello");
  assert(c.events.length <= 16);
  assert(c.events.every((e) => e.length <= 600));
  assert(!c.events.some((e) => e.includes("【本地演示 KP】")));
});
test("cyclic repeat triggers execute once each per action and first ending stops later effects", async () => {
  const scenario = structuredClone(adventure);
  scenario.id = "cycle-test";
  scenario.story!.triggers = [
    {
      id: "cycle-a",
      once: false,
      conditions: [{ type: "flag", id: "bell-found", value: true }],
      effects: [{ type: "flag", id: "bell-found", value: false }],
    },
    {
      id: "cycle-b",
      once: false,
      conditions: [{ type: "flag", id: "bell-found", value: false }],
      effects: [{ type: "flag", id: "bell-found", value: true }],
    },
  ];
  const f = await fixture(providers({}), undefined, scenario);
  await f.say("调查旧箱");
  assert.equal(f.view().inventory[0].quantity, 1);
  assert.equal(f.g.get(f.id).story.flags["bell-found"], true);
  scenario.id = "ending-first";
  scenario.story!.interactions[0].effects.push(
    { type: "ending", id: "retreat" },
    { type: "item", id: "bell", quantity: 10 },
    { type: "ending", id: "light" },
  );
  scenario.story!.triggers = [
    {
      id: "late",
      once: true,
      conditions: [{ type: "status", value: "lost" }],
      effects: [{ type: "ending", id: "light" }],
    },
  ];
  const e = await fixture(providers({}), undefined, scenario);
  await e.say("调查旧箱");
  assert.equal(e.view().status, "lost");
  assert.equal(e.view().ending?.id, "retreat");
  assert.equal(e.view().inventory[0].quantity, 1);
});
test("legacy save at a moved scene normalizes position and rejects invalid new story references", async () => {
  const f = await fixture();
  const old = await f.g.create({ name: "old-moved", scenarioVersion: "1.0.0" });
  const p = await f.g.join(old.session.id, {
    inviteCode: old.inviteCode,
    name: "old player",
  });
  await f.g.mutate(old.session.id, p.playerToken, {
    requestId: "move",
    expectedVersion: 1,
    kind: "move",
    payload: { sceneId: "cellar" },
  });
  const save: any = f.g.exportSave(f.g.get(old.session.id));
  delete save.state.story;
  const r = await f.g.restore(save);
  assert.equal(r.session.sceneId, "cellar");
  assert.equal(r.session.version, 2);
  assert.equal(save.state.story, undefined);
});
