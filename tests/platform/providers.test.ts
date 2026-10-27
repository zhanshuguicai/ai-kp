import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicProvider } from "../../src/platform/providers/anthropic.js";
import { openaiProvider } from "../../src/platform/providers/openai.js";
import { geminiProvider } from "../../src/platform/providers/gemini.js";
import { createProvider, resolveProviderConfig } from "../../src/platform/providers/index.js";
import type { HistoryItem } from "../../src/platform/providers/types.js";

const config = { model: "m", apiKey: "secret-key", baseUrl: "https://example.test/v1", timeoutMs: 1000, maxTokens: 500 };
const tools = [{ name: "reply", description: "d", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }];

function fakeFetch(responses: unknown[]) {
  const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const r = responses.shift();
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

const history: HistoryItem[] = [
  { role: "user", text: "我推门" },
  { role: "assistant", native: "NATIVE" },
  { role: "tool", results: [{ id: "c1", name: "check", content: JSON.stringify({ code: "INVALID_ARGS", message: "坏参数" }), isError: true }] },
];

test("anthropic: tool errors use is_error, native assistant content is replayed verbatim", async () => {
  const { fetcher, sent } = fakeFetch([
    { content: [{ type: "thinking", thinking: "…", signature: "sig" }, { type: "text", text: "嗯" }, { type: "tool_use", id: "t1", name: "reply", input: { text: "好" } }], stop_reason: "tool_use" },
  ]);
  const p = anthropicProvider(config, fetcher);
  const r = await p.step({ system: "S", history: [history[0], { role: "assistant", native: [{ type: "text", text: "x" }] }, history[2]], tools });
  assert.equal(sent[0].url, "https://example.test/v1/messages");
  assert.equal(sent[0].headers["x-api-key"], "secret-key");
  assert.deepEqual(sent[0].body.messages[2].content[0], { type: "tool_result", tool_use_id: "c1", content: JSON.stringify({ code: "INVALID_ARGS", message: "坏参数" }), is_error: true });
  assert.equal(sent[0].body.tools[0].input_schema.type, "object");
  assert.deepEqual(r.calls, [{ id: "t1", name: "reply", args: { text: "好" } }]);
  assert.equal(r.text, "嗯");
  assert.equal((r.native as any[])[0].signature, "sig");
});

test("openai: stateless reasoning replay, strict tools, function_call_output", async () => {
  const output = [
    { type: "reasoning", id: "rs_1", encrypted_content: "ENC" },
    { type: "function_call", call_id: "fc1", name: "reply", arguments: '{"text":"好"}' },
  ];
  const { fetcher, sent } = fakeFetch([{ status: "completed", output }, { status: "incomplete", output: [] }]);
  const p = openaiProvider(config, fetcher);
  const r = await p.step({ system: "S", history: [history[0], { role: "assistant", native: output }, history[2]], tools });
  const body = sent[0].body;
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.tools[0].strict, true);
  assert.equal(body.input[1].encrypted_content, "ENC");
  assert.deepEqual(body.input[3], { type: "function_call_output", call_id: "c1", output: JSON.stringify({ error: { code: "INVALID_ARGS", message: "坏参数" } }) });
  assert.deepEqual(r.calls, [{ id: "fc1", name: "reply", args: { text: "好" } }]);
  assert.equal((await p.step({ system: "S", history: [history[0]], tools })).stop, "max_tokens");
});

test("openai: malformed tool arguments are passed on for the agent to reject, not thrown", async () => {
  const { fetcher } = fakeFetch([{ status: "completed", output: [{ type: "function_call", call_id: "x", name: "reply", arguments: "{oops" }] }]);
  const r = await openaiProvider(config, fetcher).step({ system: "S", history: [history[0]], tools });
  assert.equal((r.calls[0].args as any).__invalidJson, "{oops");
});

test("gemini: parametersJsonSchema, model turn replayed, functionResponse carries errors", async () => {
  const parts = [{ functionCall: { id: "g1", name: "reply", args: { text: "好" } }, thoughtSignature: "TS" }];
  const { fetcher, sent } = fakeFetch([{ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] }]);
  const p = geminiProvider(config, fetcher);
  const r = await p.step({ system: "S", history: [history[0], { role: "assistant", native: { role: "model", parts } }, history[2]], tools });
  assert.equal(sent[0].url, "https://example.test/v1/models/m:generateContent");
  assert.equal(sent[0].body.tools[0].functionDeclarations[0].parametersJsonSchema.type, "object");
  assert.equal(sent[0].body.contents[1].parts[0].thoughtSignature, "TS");
  assert.deepEqual(sent[0].body.contents[2].parts[0].functionResponse, { id: "c1", name: "check", response: { error: { code: "INVALID_ARGS", message: "坏参数" } } });
  assert.deepEqual(r.calls[0], { id: "g1", name: "reply", args: { text: "好" } });
});

test("HTTP errors are mapped to readable messages without upstream bodies", async () => {
  const { fetcher } = fakeFetch([new Response('{"error":"key secret-key invalid"}', { status: 401 })]);
  await assert.rejects(anthropicProvider(config, fetcher).step({ system: "S", history: [history[0]], tools }), (e: any) => {
    assert.equal(e.code, "PROVIDER_HTTP");
    assert.match(e.message, /401.*API key/);
    assert(!e.message.includes("secret-key"));
    return true;
  });
});

test("config: stored values beat env beat defaults; missing key never falls back to demo", () => {
  const env = { ANTHROPIC_MODEL: "env-model", ANTHROPIC_API_KEY: "env-key" };
  assert.equal(resolveProviderConfig("anthropic", undefined, env).model, "env-model");
  assert.equal(resolveProviderConfig("anthropic", { model: "stored" }, env).model, "stored");
  assert.equal(resolveProviderConfig("openai", undefined, {}).apiKey, undefined);
  assert.throws(() => createProvider("openai", resolveProviderConfig("openai", undefined, {})), /未配置 API key/);
  assert.equal(createProvider("demo", undefined).id, "demo");
});
