import { test } from "node:test";
import assert from "node:assert/strict";
import { openrouterProvider } from "../../src/platform/providers/openrouter.js";
import { anthropicProvider } from "../../src/platform/providers/anthropic.js";
import { createProvider, resolveProviderConfig } from "../../src/platform/providers/index.js";
import type { HistoryItem } from "../../src/platform/providers/types.js";
import { setRetryDelay } from "../../src/platform/providers/http.js";

setRetryDelay(0);

const config = {
  model: "anthropic/claude-opus-5.5",
  apiKey: "secret-key",
  baseUrl: "https://openrouter.test/api/v1",
  timeoutMs: 1000,
  maxTokens: 8000,
  reasoningEffort: "medium" as const,
};
const tools = [
  {
    name: "reply",
    description: "d",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
];
const parts = { stable: "STABLE 规则与概要", dynamic: "DYNAMIC 最近经过" };
const user: HistoryItem = { role: "user", text: "我推门" };

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
const ok = (content: string) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });

test("openrouter: chat completions shape, cached system blocks for Claude, reasoning effort", async () => {
  const { fetcher, sent } = fakeFetch([ok("好")]);
  const r = await openrouterProvider(config, fetcher).step({ system: parts.stable + parts.dynamic, systemParts: parts, history: [user], tools });
  assert.equal(r.text, "好");
  assert.equal(r.stop, "end");
  const { url, headers, body } = sent[0];
  assert.equal(url, "https://openrouter.test/api/v1/chat/completions");
  assert.equal(headers.authorization, "Bearer secret-key");
  assert.equal(body.model, "anthropic/claude-opus-5.5");
  assert.equal(body.max_tokens, 8000);
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.deepEqual(body.messages[0], {
    role: "system",
    content: [
      { type: "text", text: parts.stable, cache_control: { type: "ephemeral" } },
      { type: "text", text: parts.dynamic, cache_control: { type: "ephemeral" } },
    ],
  });
  // The newest message carries the third breakpoint, so later tool steps read the history from cache.
  assert.deepEqual(body.messages[1], { role: "user", content: [{ type: "text", text: "我推门", cache_control: { type: "ephemeral" } }] });
  assert.deepEqual(body.tools[0], { type: "function", function: { name: "reply", description: "d", parameters: tools[0].parameters } });
});

test("openrouter: Gemini gets one breakpoint on the stable part; other models a plain system string", async () => {
  const { fetcher, sent } = fakeFetch([ok("好"), ok("好")]);
  await openrouterProvider({ ...config, model: "google/gemini-4-argon" }, fetcher).step({ system: "ALL", systemParts: parts, history: [user], tools });
  assert.deepEqual(sent[0].body.messages[0], {
    role: "system",
    content: [{ type: "text", text: parts.stable, cache_control: { type: "ephemeral" } }, { type: "text", text: parts.dynamic }],
  });
  assert.deepEqual(sent[0].body.messages[1], { role: "user", content: "我推门" }, "Gemini uses only the last breakpoint, so none on messages");
  await openrouterProvider({ ...config, model: "openai/gpt-6.1-sol" }, fetcher).step({ system: "ALL", systemParts: parts, history: [user], tools });
  assert.deepEqual(sent[1].body.messages[0], { role: "system", content: "ALL" });
});

test("openrouter: reasoning_details and tool calls are replayed unmodified; tool results use role tool", async () => {
  const reasoning = [{ type: "reasoning.text", text: "想一想", signature: "SIG", id: "r1", format: "anthropic-claude-v1", index: 0 }];
  const toolCalls = [{ id: "tc1", type: "function", function: { name: "reply", arguments: '{"text":"好"}' } }];
  const { fetcher, sent } = fakeFetch([
    {
      choices: [{ message: { role: "assistant", content: null, tool_calls: toolCalls, reasoning_details: reasoning }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.0123, prompt_tokens_details: { cached_tokens: 800 } },
    },
    ok("完"),
  ]);
  const p = openrouterProvider(config, fetcher);
  const r = await p.step({ system: "S", history: [user], tools });
  assert.deepEqual(r.calls, [{ id: "tc1", name: "reply", args: { text: "好" } }]);
  assert.equal(r.stop, "tool_use");
  assert.deepEqual(r.usage, { input: 1000, output: 50, cached: 800, cost: 0.0123 });

  await p.step({
    system: "S",
    history: [
      user,
      { role: "assistant", native: r.native },
      {
        role: "tool",
        results: [
          { id: "tc1", name: "reply", content: '{"ok":true}', isError: false },
          { id: "tc2", name: "check", content: '{"code":"X","message":"坏"}', isError: true },
        ],
      },
    ],
    tools,
  });
  const msgs = sent[1].body.messages;
  assert.deepEqual(msgs[2], { role: "assistant", content: null, tool_calls: toolCalls, reasoning_details: reasoning });
  assert.deepEqual(msgs[3], { role: "tool", tool_call_id: "tc1", content: '{"ok":true}' });
  // Only the newest message gets a breakpoint (2 system + 1 here stays within Anthropic's limit of 4).
  assert.deepEqual(msgs[4], {
    role: "tool",
    tool_call_id: "tc2",
    content: [{ type: "text", text: '{"error":{"code":"X","message":"坏"}}', cache_control: { type: "ephemeral" } }],
  });
});

test("openrouter: plain-text reasoning is replayed when there are no reasoning_details", async () => {
  const { fetcher } = fakeFetch([{ choices: [{ message: { role: "assistant", content: "嗯", reasoning: "思考" }, finish_reason: "stop" }] }]);
  const r = await openrouterProvider(config, fetcher).step({ system: "S", history: [user], tools });
  assert.deepEqual(r.native, { role: "assistant", content: "嗯", reasoning: "思考" });
});

test("openrouter: length, refusal, in-body errors and 402 are reported clearly", async () => {
  const { fetcher } = fakeFetch([
    { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] },
    { choices: [{ message: { role: "assistant", content: null, refusal: "不行" }, finish_reason: "stop" }] },
    { error: { code: 502, message: "upstream secret-key leaked" } },
    new Response("{}", { status: 402 }),
  ]);
  const p = openrouterProvider(config, fetcher);
  assert.equal((await p.step({ system: "S", history: [user], tools })).stop, "max_tokens");
  assert.equal((await p.step({ system: "S", history: [user], tools })).stop, "refused");
  await assert.rejects(p.step({ system: "S", history: [user], tools }), (e: any) => {
    assert.equal(e.code, "PROVIDER_HTTP");
    assert(!e.message.includes("secret-key"));
    return true;
  });
  await assert.rejects(p.step({ system: "S", history: [user], tools }), /402.*余额不足/);
});

test("openrouter: complete() for summaries sends no tools and returns text", async () => {
  const { fetcher, sent } = fakeFetch([ok('{"public":"p","kp":"k"}')]);
  const text = await openrouterProvider({ ...config, model: "anthropic/claude-haiku-5.5" }, fetcher).complete({ system: "记录员", prompt: "记录", maxTokens: 4000 });
  assert.equal(text, '{"public":"p","kp":"k"}');
  assert.equal(sent[0].body.model, "anthropic/claude-haiku-5.5");
  assert.equal(sent[0].body.max_tokens, 4000);
  assert.equal(sent[0].body.tools, undefined);
});

test("openrouter config: defaults to Opus 5.5 with medium reasoning; env can change effort", () => {
  const d = resolveProviderConfig("openrouter", undefined, { OPENROUTER_API_KEY: "k" });
  assert.equal(d.model, "anthropic/claude-opus-5.5");
  assert.equal(d.reasoningEffort, "medium");
  assert.equal(d.maxTokens, 8000);
  assert.equal(resolveProviderConfig("openrouter", undefined, { OPENROUTER_REASONING_EFFORT: "high" }).reasoningEffort, "high");
  assert.equal(resolveProviderConfig("openrouter", undefined, { OPENROUTER_REASONING_EFFORT: "bogus" }).reasoningEffort, "medium");
  assert.equal(resolveProviderConfig("openrouter", { reasoningEffort: "low" }, {}).reasoningEffort, "low");
  assert.equal(createProvider("openrouter", d).id, "openrouter");
  assert.throws(() => createProvider("openrouter", resolveProviderConfig("openrouter", undefined, {})), /未配置 API key/);
});

test("anthropic direct: system parts become cached blocks; usage counts cache reads", async () => {
  const { fetcher, sent } = fakeFetch([
    { content: [{ type: "text", text: "好" }], stop_reason: "end_turn", usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 10 } },
  ]);
  const r = await anthropicProvider({ ...config, baseUrl: "https://a.test/v1", model: "claude-opus-5-5" }, fetcher).step({
    system: "x",
    systemParts: parts,
    history: [user],
    tools,
  });
  assert.equal(sent[0].body.system[0].cache_control.type, "ephemeral");
  assert.equal(sent[0].body.system[1].text, parts.dynamic);
  assert.deepEqual(r.usage, { input: 1000, output: 10, cached: 900 });
});

test("openrouter: one retry on a gateway error; client errors are not retried", async () => {
  const { fetcher, sent } = fakeFetch([new Response("bad gateway", { status: 504 }), ok("好")]);
  const r = await openrouterProvider(config, fetcher).step({ system: "S", history: [user], tools });
  assert.equal(r.text, "好");
  assert.equal(sent.length, 2);

  const twice = fakeFetch([new Response("x", { status: 503 }), new Response("x", { status: 503 })]);
  await assert.rejects(openrouterProvider(config, twice.fetcher).step({ system: "S", history: [user], tools }), /HTTP 503/);
  assert.equal(twice.sent.length, 2, "gives up after one retry");

  const client = fakeFetch([new Response("x", { status: 400 })]);
  await assert.rejects(openrouterProvider(config, client.fetcher).step({ system: "S", history: [user], tools }), /HTTP 400/);
  assert.equal(client.sent.length, 1);
});
