import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { HostService } from "../src/host.js";
import { runHostProvider, defaults } from "../src/host-providers.js";
import { httpServer } from "../src/server.js";
import { GameService } from "../src/game.js";
import { MemoryStore } from "../src/foundation.js";
import { providers } from "../src/providers.js";
const setup = async (
  provider = "demo",
  fetcher: typeof fetch = fetch,
  directory?: string,
) => {
  const h = new HostService(directory, {}, fetcher);
  await h.init();
  if (provider !== "demo")
    await h.configure({ provider, apiKey: "fake-test-key" });
  const { room } = await h.create({
    name: "测试",
    provider,
    players: [
      { id: "alice", name: "A" },
      { id: "bob", name: "B" },
    ],
  });
  return { h, room };
};
const progress = {
  mainQuest: "修复停钟",
  sideQuests: ["送信"],
  npcs: ["阿澄等待"],
  pace: "等待玩家选择",
};
function fixture(provider: string, fail = false) {
  const requests: any[] = [];
  const fetcher = (async (url: any, options: any) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    assert(
      String(url).endsWith(
        provider === "openai"
          ? "/responses"
          : provider === "anthropic"
            ? "/messages"
            : "/interactions",
      ),
    );
    assert(request.tools.some((t: any) => t.name === "roll_dice"));
    if (requests.length === 1) {
      const call =
        provider === "openai"
          ? {
              type: "function_call",
              call_id: "rd1",
              name: "roll_dice",
              arguments: JSON.stringify({
                expression: "2d6+3",
                reason: "爬进未预设的排水管",
              }),
            }
          : provider === "anthropic"
            ? {
                type: "tool_use",
                id: "rd1",
                name: "roll_dice",
                input: { expression: "2d6+3", reason: "爬进未预设的排水管" },
              }
            : {
                type: "function_call",
                id: "rd1",
                name: "roll_dice",
                arguments: {
                  expression: "2d6+3",
                  reason: "爬进未预设的排水管",
                },
              };
      const blocks = [
        ...(provider === "anthropic"
          ? [
              {
                type: "thinking",
                thinking: "private reasoning",
                signature: "must-preserve",
              },
            ]
          : []),
        call,
      ];
      return Response.json(
        provider === "openai"
          ? { status: "completed", output: blocks }
          : provider === "anthropic"
            ? { stop_reason: "tool_use", content: blocks }
            : { status: "completed", steps: blocks },
      );
    }
    if (fail) return new Response("bad", { status: 503 });
    const history = provider === "anthropic" ? request.messages : request.input;
    if (provider === "anthropic") {
      assert.equal(history[1].content[0].signature, "must-preserve");
      assert.equal(history[2].content[0].tool_use_id, "rd1");
      assert.match(history[2].content[0].content, /total/);
    } else if (provider === "openai") {
      assert(
        history.some(
          (x: any) => x.type === "function_call" && x.call_id === "rd1",
        ),
      );
      assert(
        history.some(
          (x: any) => x.type === "function_call_output" && x.call_id === "rd1",
        ),
      );
    } else {
      assert.equal(request.store, false);
      assert.equal(history[0].type, "user_input");
      assert(
        history.some((x: any) => x.type === "function_call" && x.id === "rd1"),
      );
      const result = history.find((x: any) => x.type === "function_result");
      assert.equal(result.call_id, "rd1");
      assert.equal(result.result[0].type, "text");
    }
    const defs = [
      [
        "mem",
        "remember_campaign",
        { facts: ["玩家发现铜屑"], gmNotes: ["守钟人的私密动机"] },
      ],
      ["prog", "update_progress", progress],
      [
        "end",
        "finish_turn",
        { publicReply: "你从管道入口看见钟楼底座的铜屑。你打算怎么做？" },
      ],
    ];
    const blocks = defs.map(([id, name, args]) =>
      provider === "openai"
        ? {
            type: "function_call",
            call_id: id,
            name,
            arguments: JSON.stringify(args),
          }
        : provider === "anthropic"
          ? { type: "tool_use", id, name, input: args }
          : { type: "function_call", id, name, arguments: args },
    );
    return Response.json(
      provider === "openai"
        ? { status: "completed", output: blocks }
        : provider === "anthropic"
          ? { stop_reason: "tool_use", content: blocks }
          : { status: "completed", steps: blocks },
    );
  }) as typeof fetch;
  return { fetcher, requests };
}
for (const provider of ["openai", "anthropic", "gemini"])
  test(`${provider} native two-round tool protocol: arbitrary action, real dice, memory, public reply`, async () => {
    const { fetcher, requests } = fixture(provider);
    const { h, room } = await setup(provider, fetcher);
    await h.message(room.id, {
      messageId: "new-action",
      playerId: "alice",
      kind: "action",
      text: "我用帽子兜住雨水，爬进排水管",
    });
    const r = h.room(room.id);
    assert.equal(r.receipts["new-action"].status, "complete");
    assert.equal(requests.length, 2);
    assert.equal(r.rolls.length, 1);
    assert(r.rolls[0].values.every((v: number) => v >= 1 && v <= 6));
    assert.equal(r.memory.mainQuest, "修复停钟");
    assert.deepEqual(r.memory.facts, ["玩家发现铜屑"]);
    assert.equal(r.gmNotes[0], "守钟人的私密动机");
    assert(!JSON.stringify(h.publicView(r)).includes("私密动机"));
    assert(!JSON.stringify(r.events).includes("private reasoning"));
  });
test("same-table queue, duplicate IDs and restart persistence do not repeat dice or model requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aikp-host-"));
  try {
    const { h, room } = await setup("demo", fetch, dir);
    await Promise.all([
      h.message(room.id, {
        messageId: "one",
        playerId: "alice",
        kind: "action",
        text: "全新自由行动",
      }),
      h.message(room.id, {
        messageId: "one",
        playerId: "alice",
        kind: "action",
        text: "全新自由行动",
      }),
      h.message(room.id, {
        messageId: "two",
        playerId: "bob",
        kind: "dialogue",
        text: "你好",
      }),
    ]);
    assert.equal(h.room(room.id).rolls.length, 1);
    assert.deepEqual(
      h
        .room(room.id)
        .events.filter((x) => x.type === "player")
        .map((x) => x.messageId),
      ["one", "two"],
    );
    const h2 = new HostService(dir, {});
    await h2.init();
    const duplicate = await h2.message(room.id, {
      messageId: "one",
      playerId: "alice",
      kind: "action",
      text: "不同文本仍去重",
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(h2.room(room.id).rolls.length, 1);
    const state = await readFile(join(dir, "host-state.json"), "utf8");
    assert(!state.includes('"tools"'));
    assert.match(state, /离线协议演示/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("provider failure after a roll stays readable and deduplicated after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aikp-fail-"));
  try {
    const { fetcher, requests } = fixture("openai", true);
    const { h, room } = await setup("openai", fetcher, dir);
    await h.message(room.id, {
      messageId: "failed",
      playerId: "alice",
      kind: "action",
      text: "跳上吊灯",
    });
    assert.equal(h.room(room.id).receipts.failed.status, "failed");
    assert.equal(h.room(room.id).rolls.length, 1);
    const h2 = new HostService(dir, {}, fetcher);
    await h2.init();
    await h2.message(room.id, {
      messageId: "failed",
      playerId: "alice",
      kind: "action",
      text: "重发",
    });
    assert.equal(requests.length, 2);
    assert.equal(h2.room(room.id).rolls.length, 1);
    assert(
      h2
        .room(room.id)
        .events.some((x) => x.type === "error" && x.text.includes("503")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("interrupted receipt becomes failed on recovery; checkpoint dice never replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aikp-crash-"));
  try {
    const { h, room } = await setup("demo", fetch, dir);
    const r = h.room(room.id);
    r.receipts.interrupted = { status: "processing" };
    r.rolls.push({ messageId: "interrupted", total: 12 });
    await h.save();
    const restored = new HostService(dir, {});
    await restored.init();
    assert.equal(restored.room(room.id).receipts.interrupted.status, "failed");
    assert.equal(
      (
        await restored.message(room.id, {
          messageId: "interrupted",
          playerId: "alice",
          kind: "action",
          text: "重发",
        })
      ).duplicate,
      true,
    );
    assert.equal(restored.room(room.id).rolls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("raw text preserved, chunk retrieval, explicit limits, secrets only admin projection", async () => {
  const { h, room } = await setup();
  const source = "秘密甲".repeat(9000) + "END";
  const { material } = await h.addMaterial({
    kind: "scenario",
    title: "原文",
    text: source,
  });
  h.room(room.id).scenarioId = material.id;
  assert.equal(h.material(h.room(room.id), "scenario"), source);
  const chunk = h.tool(h.room(room.id), "q", {
    id: "q",
    name: "query_materials",
    args: { kind: "scenario", offset: 0, keyword: "END" },
  });
  assert.equal(chunk.text, "END");
  assert.equal(chunk.totalCharacters, source.length);
  await assert.rejects(
    h.addMaterial({ kind: "rules", title: "过大", text: "x".repeat(200001) }),
    /200000/,
  );
  await h.message(room.id, {
    messageId: "demo",
    playerId: "alice",
    kind: "ooc",
    text: "hello",
  });
  assert(h.room(room.id).gmNotes.length);
  assert(!JSON.stringify(h.publicView(h.room(room.id))).includes("私密记忆"));
});
test("configuration keys redacted, blank preserves, explicit removal and env support", async () => {
  const h = new HostService(undefined, { OPENAI_API_KEY: "env-secret" });
  await h.init();
  assert.equal(
    h.config().providers.find((x) => x.id === "openai")?.configured,
    true,
  );
  await h.configure({ provider: "openai", apiKey: "saved-secret" });
  await h.configure({ provider: "openai", apiKey: "" });
  assert.equal(h.effective("openai").apiKey, "saved-secret");
  await h.configure({ provider: "openai", deleteApiKey: true });
  assert.equal(h.effective("openai").apiKey, "env-secret");
  await h.configure({ qq: { secret: "qq-secret", accessToken: "qq-token" } });
  assert(!JSON.stringify(h.config()).includes("env-secret"));
  assert(!JSON.stringify(h.config()).includes("qq-secret"));
  await assert.rejects(
    h.testProvider({ provider: "openai" }),
    /confirmBillable/,
  );
});
test("no configured API means explicit failure, never demo fallback", async () => {
  const h = new HostService(undefined, {});
  await h.init();
  const { room } = await h.create({
    name: "真实",
    provider: "anthropic",
    players: [{ id: "a", name: "A" }],
  });
  await h.message(room.id, {
    messageId: "missing",
    playerId: "a",
    text: "行动",
    kind: "action",
  });
  assert.equal(h.room(room.id).receipts.missing.code, "MISSING_CREDENTIALS");
  assert.equal(h.room(room.id).rolls.length, 0);
  assert(!h.room(room.id).events.some((x) => x.type === "kp"));
});
test("provider truncation and tool limit fail before falsely publishing narration", async () => {
  const results: any[] = [];
  await assert.rejects(
    runHostProvider(
      "anthropic",
      { ...defaults.anthropic, apiKey: "fake" },
      {
        system: "s",
        input: "i",
        kind: "action",
        execute: async (c) => {
          results.push(c);
        },
      },
      (async () =>
        Response.json({
          stop_reason: "max_tokens",
          content: [
            {
              type: "tool_use",
              id: "1",
              name: "roll_dice",
              input: { expression: "1d20", reason: "x" },
            },
          ],
        })) as typeof fetch,
    ),
    /未完成/,
  );
  assert.equal(results.length, 0);
  let count = 0;
  await assert.rejects(
    runHostProvider(
      "gemini",
      { ...defaults.gemini, apiKey: "fake" },
      {
        system: "s",
        input: "i",
        kind: "action",
        execute: async () => ({ saved: true }),
      },
      (async () =>
        Response.json({
          steps: [
            {
              type: "function_call",
              id: String(++count),
              name: "remember_campaign",
              arguments: { facts: [], gmNotes: [] },
            },
          ],
        })) as typeof fetch,
    ),
    /8轮/,
  );
  assert.equal(count, 8);
});
test("OneBot signed HTTP ingress and fake send_group_msg end-to-end; duplicate/self/mention filters", async () => {
  const sent: any[] = [];
  const bridge = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    sent.push({
      path: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(raw),
    });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 321 } }),
    );
  });
  bridge.listen(0, "127.0.0.1");
  await once(bridge, "listening");
  const { h, room } = await setup();
  await h.configure({
    qq: {
      enabled: true,
      secret: "independent-secret",
      accessToken: "bridge-token",
      apiBaseUrl: `http://127.0.0.1:${(bridge.address() as any).port}`,
    },
  });
  await h.bind(room.id, { groupId: "123", mode: "mention" });
  const game = new GameService(new MemoryStore(), providers({}));
  await game.init();
  const server = httpServer(game, "admin-secret", undefined, h);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const event = {
    post_type: "message",
    message_type: "group",
    group_id: 123,
    user_id: 777,
    self_id: 999,
    message_id: 42,
    sender: { nickname: "玩家QQ" },
    message: [
      { type: "at", data: { qq: "999" } },
      { type: "text", data: { text: "我把雨伞当作帆" } },
    ],
  };
  const send = async (b: any, secret = "independent-secret") => {
    const raw = JSON.stringify(b, null, 2);
    return fetch(base + "/api/host/qq/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature":
          "sha1=" + createHmac("sha1", secret).update(raw).digest("hex"),
      },
      body: raw,
    });
  };
  try {
    assert.equal((await fetch(base + "/api/host/config")).status, 401);
    assert.equal((await send(event, "admin-secret")).status, 401);
    assert.equal((await send(event)).status, 200);
    assert.equal((await send(event)).status, 200);
    for (let n = 0; n < 100 && !sent.length; n++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, "/send_group_msg");
    assert.equal(sent[0].auth, "Bearer bridge-token");
    assert.equal(sent[0].body.auto_escape, true);
    assert.match(sent[0].body.message, /离线协议演示/);
    assert(!sent[0].body.message.includes("私密记忆"));
    assert.equal(h.room(room.id).rolls.length, 1);
    assert.equal(
      (
        (await (
          await send({ ...event, message_id: 43, user_id: 999 })
        ).json()) as any
      ).ignored,
      true,
    );
    assert.equal(
      (
        (await (
          await send({ ...event, message_id: 44, message: "无提及" })
        ).json()) as any
      ).ignored,
      true,
    );
    for (let n = 0; n < 100 && h.state.inbox.length; n++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.room(room.id).deliveries["qq:123:42"].status, "bridge-ok");
  } finally {
    server.closeAllConnections();
    bridge.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => bridge.close(() => r())),
    ]);
  }
});

test("QQ upstream failure/async status and delivery restart never repeat the hosted turn", async () => {
  for (const [upstream, expected] of [
    [{ status: "failed", retcode: 100 }, "failed"],
    [{ status: "async", retcode: 1 }, "accepted-async"],
  ] as const) {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return Response.json(upstream);
    }) as typeof fetch;
    const { h, room } = await setup("demo", fetcher);
    await h.configure({ qq: { enabled: true, secret: "secret" } });
    await h.bind(room.id, { groupId: "123", mode: "all" });
    const event = {
      post_type: "message",
      message_type: "group",
      group_id: 123,
      user_id: 99,
      self_id: 9,
      message_id: 1,
      message: "新行动",
    };
    await h.acceptEvent(event);
    await h.drainInbox();
    assert.equal(h.room(room.id).deliveries["qq:123:1"].status, expected);
    assert.equal(h.room(room.id).rolls.length, 1);
    assert.equal((await h.acceptEvent(event)).duplicate, true);
    await h.drainInbox();
    assert.equal(calls, 1);
    assert.equal(h.room(room.id).rolls.length, 1);
  }
  const dir = await mkdtemp(join(tmpdir(), "aikp-delivery-"));
  try {
    const { h, room } = await setup("demo", fetch, dir);
    const r = h.room(room.id);
    r.deliveries["qq:123:1"] = { status: "sending" };
    r.receipts["qq:123:1"] = { status: "complete" };
    await h.save();
    let sends = 0;
    const h2 = new HostService(dir, {}, (async () => {
      sends++;
      return Response.json({ status: "ok", retcode: 0 });
    }) as typeof fetch);
    await h2.init();
    assert.equal(
      h2.room(room.id).deliveries["qq:123:1"].status,
      "unknown-after-restart",
    );
    assert.equal(sends, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("message IDs including object prototype names execute once without prototype mutation", async () => {
  const { h, room } = await setup();
  await h.message(room.id, {
    messageId: "__proto__",
    playerId: "alice",
    kind: "action",
    text: "原型键作为正常ID",
  });
  assert.equal(h.room(room.id).receipts["__proto__"].status, "complete");
  assert.equal(h.room(room.id).rolls.length, 1);
  assert.equal(
    (
      await h.message(room.id, {
        messageId: "__proto__",
        playerId: "alice",
        kind: "action",
        text: "重发",
      })
    ).duplicate,
    true,
  );
  assert.equal(h.room(room.id).rolls.length, 1);
});
test("HTTP host API import/create/start/free action/retrieve and explicit oversized input", async () => {
  const h = new HostService(undefined, {});
  await h.init();
  const game = new GameService(new MemoryStore(), providers({}));
  await game.init();
  const server = httpServer(game, "admin", undefined, h);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, b: any) =>
    fetch(base + "/api/host" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify(b),
    });
  try {
    const mat = (await (
      await post("/materials", {
        kind: "scenario",
        title: "原文",
        text: "只有主持知道的秘密。",
      })
    ).json()) as any;
    assert(mat.material.id);
    const created = (await (
      await post("/rooms", {
        name: "HTTP团",
        provider: "demo",
        scenarioId: mat.material.id,
        players: [{ id: "a", name: "A" }],
      })
    ).json()) as any;
    const id = created.room.id;
    assert.equal(
      (
        (await (
          await post(`/rooms/${id}/start`, { messageId: "start" })
        ).json()) as any
      ).room.receipts.start.status,
      "complete",
    );
    const turn = (await (
      await post(`/rooms/${id}/messages`, {
        messageId: "action",
        playerId: "a",
        kind: "action",
        text: "我用手帕折成纸鹤放进风里",
      })
    ).json()) as any;
    assert.equal(turn.room.rolls.length, 1);
    const read = (await (
      await fetch(base + `/api/host/rooms/${id}`, {
        headers: { "x-admin-token": "admin" },
      })
    ).json()) as any;
    assert.equal(read.room.memory.mainQuest, "调查雾港钟楼的停摆");
    assert.equal(
      (
        await post("/materials", {
          kind: "rules",
          title: "大",
          text: "x".repeat(200001),
        })
      ).status,
      400,
    );
    const bad = await fetch(base + "/api/host/config", {
      method: "POST",
      headers: { "x-admin-token": "admin", "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(bad.status, 415);
    assert.equal((await post("/test", { provider: "openai" })).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("maximum accepted player text remains complete in events while demo memory uses a bounded summary", async () => {
  const { h, room } = await setup();
  const input = "新".repeat(6000);
  await h.message(room.id, {
    messageId: "max-input",
    playerId: "alice",
    kind: "action",
    text: input,
  });
  const r = h.room(room.id);
  assert.equal(r.receipts["max-input"].status, "complete");
  assert.equal(r.events.find((x) => x.type === "player")?.text, input);
  assert(r.memory.facts[0].length < 1200);
  await assert.rejects(
    h.message(room.id, {
      messageId: "over-input",
      playerId: "alice",
      kind: "action",
      text: input + "新",
    }),
    /6000/,
  );
});
