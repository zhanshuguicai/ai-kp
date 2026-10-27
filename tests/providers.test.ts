import test from "node:test";
import assert from "node:assert/strict";
import { HttpKP, providers, type PublicContext } from "../src/providers.js";
const context: PublicContext = {
  location: "public hall",
  actors: [{ name: "A", hp: 20 }],
  events: ["public"],
  action: "hello",
};
const okText = JSON.stringify({ narration: "灯光亮起。" });
const success = {
  openai: {
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: okText }] },
    ],
  },
  anthropic: {
    stop_reason: "end_turn",
    content: [{ type: "text", text: okText }],
  },
  gemini: {
    status: "completed",
    steps: [
      { type: "model_output", content: [{ type: "text", text: okText }] },
    ],
  },
};
for (const id of ["openai", "anthropic", "gemini"] as const) {
  test(`${id}: real REST shape and different protocol request`, async () => {
    let called = false;
    const p = new HttpKP(
      id,
      "SECRET",
      "configured-model",
      async (url, init) => {
        called = true;
        const b = JSON.parse(init.body as string);
        assert.equal(b.model, "configured-model");
        assert(!JSON.stringify(b).includes("SECRET"));
        assert(!url.includes("SECRET"));
        if (id === "openai") {
          assert(url.endsWith("/responses"));
          assert.equal(b.text.format.type, "json_schema");
          assert.equal(b.store, false);
        }
        if (id === "anthropic") {
          assert(url.endsWith("/messages"));
          assert.equal(b.output_config.format.type, "json_schema");
          assert(!b.text);
        }
        if (id === "gemini") {
          assert(url.endsWith("/interactions"));
          assert.equal(b.response_format.type, "text");
          assert.equal(b.response_format.mime_type, "application/json");
          assert.equal(b.store, false);
        }
        return Response.json(success[id]);
      },
    );
    assert.equal(await p.narrate(context), "灯光亮起。");
    assert(called);
  });
  test(`${id}: errors, truncation/refusal, malformed structure and timeout sanitize upstream`, async () => {
    const bodies: any[] = [
      { error: { message: "SECRET" } },
      id === "anthropic"
        ? {
            stop_reason: "max_tokens",
            content: [{ type: "text", text: okText }],
          }
        : { ...success[id], status: "incomplete" },
      id === "anthropic"
        ? { stop_reason: "refusal", content: [] }
        : id === "openai"
          ? {
              status: "completed",
              output: [{ content: [{ type: "refusal", refusal: "SECRET" }] }],
            }
          : {
              status: "completed",
              steps: [{ type: "model_output", content: [{ type: "refusal" }] }],
            },
      id === "anthropic"
        ? {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "plain" }],
          }
        : id === "openai"
          ? {
              status: "completed",
              output: [{ content: [{ type: "output_text", text: "plain" }] }],
            }
          : {
              status: "completed",
              steps: [
                {
                  type: "model_output",
                  content: [{ type: "text", text: "plain" }],
                },
              ],
            },
    ];
    for (const b of bodies) {
      await assert.rejects(
        new HttpKP(id, "SECRET", "m", async () => Response.json(b)).narrate(
          context,
        ),
        (e: any) =>
          e.code === "PROVIDER_FAILURE" && !e.message.includes("SECRET"),
      );
    }
    await assert.rejects(
      new HttpKP(
        id,
        "SECRET",
        "m",
        async () => new Response("SECRET", { status: 429 }),
      ).narrate(context),
      (e: any) => e.code === "PROVIDER_FAILURE",
    );
    await assert.rejects(
      new HttpKP(
        id,
        "SECRET",
        "m",
        async () => new Promise(() => {}),
        5,
      ).narrate(context),
      (e: any) => e.code === "PROVIDER_FAILURE",
    );
  });
}
test("unconfigured provider fails before transport, no paid fallback", async () => {
  const models = providers({});
  assert(models.get("mock")!.ready);
  for (const id of ["openai", "anthropic", "gemini"] as const)
    await assert.rejects(
      models.get(id)!.narrate(context),
      (e: any) => e.code === "PROVIDER_UNAVAILABLE",
    );
});
