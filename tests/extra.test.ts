import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GameService } from "../src/game.js";
import {
  FileStore,
  MemoryStore,
  builtinRules,
  Fault,
} from "../src/foundation.js";
import { providers, HttpKP } from "../src/providers.js";
test("concurrent create and import retain all index entries after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aikp-parallel-"));
  try {
    const g = new GameService(new FileStore(dir), providers({}));
    await g.init();
    const rooms = await Promise.all(
      Array.from({ length: 8 }, (_, n) => g.create({ name: "room" + n })),
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        g.importPackage({ ...builtinRules, id: "rule-" + n }),
      ),
    );
    const restored = new GameService(new FileStore(dir), providers({}));
    await restored.init();
    for (const r of rooms)
      assert.equal(restored.get(r.session.id).name, r.session.name);
    assert.equal(restored.catalog().rules.length, 9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("model failure leaves authoritative version and event list untouched", async () => {
  const models = providers({});
  models.set("mock", {
    id: "mock",
    ready: true,
    async narrate() {
      throw new Fault("PROVIDER_FAILURE", "模型暂不可用", 502);
    },
  });
  const g = new GameService(new MemoryStore(), models);
  await g.init();
  const c = await g.create({ name: "room" });
  const p = await g.join(c.session.id, { inviteCode: c.inviteCode, name: "A" });
  const before = structuredClone(g.get(c.session.id));
  await assert.rejects(
    g.mutate(c.session.id, p.playerToken, {
      requestId: "speak",
      expectedVersion: 1,
      kind: "say",
      payload: { text: "hello" },
    }),
  );
  assert.deepEqual(g.get(c.session.id), before);
});
test("provider custom version root, max output and timeout; URL credentials rejected", async () => {
  for (const id of ["openai", "anthropic", "gemini"] as const) {
    let captured: any;
    const body =
      id === "openai"
        ? {
            status: "completed",
            output: [
              {
                content: [{ type: "output_text", text: '{"narration":"ok"}' }],
              },
            ],
          }
        : id === "anthropic"
          ? {
              stop_reason: "end_turn",
              content: [{ type: "text", text: '{"narration":"ok"}' }],
            }
          : {
              status: "completed",
              steps: [
                {
                  type: "model_output",
                  content: [{ type: "text", text: '{"narration":"ok"}' }],
                },
              ],
            };
    const p = new HttpKP(
      id,
      "test",
      "model",
      async (url, init) => {
        captured = { url, body: JSON.parse(init.body as string) };
        return Response.json(body);
      },
      500,
      { baseUrl: "http://127.0.0.1:1234/version", maxOutput: 512 },
    );
    await p.narrate({
      location: "hall",
      actors: [],
      events: [],
      action: "hello",
    });
    assert.equal(
      captured.url,
      `http://127.0.0.1:1234/version/${id === "openai" ? "responses" : id === "anthropic" ? "messages" : "interactions"}`,
    );
    assert.equal(
      id === "openai"
        ? captured.body.max_output_tokens
        : id === "anthropic"
          ? captured.body.max_tokens
          : captured.body.generation_config.max_output_tokens,
      512,
    );
  }
  assert.throws(
    () =>
      new HttpKP("openai", "x", "m", fetch, 500, {
        baseUrl: "https://user:password@example.com/v1",
      }),
  );
});
