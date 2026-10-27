// Settings page backend: API mode for OpenAI (Responses or Chat Completions), model lists per provider,
// and switching a campaign's main provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider, resolveProviderConfig } from "../../src/platform/providers/index.js";
import { listModels } from "../../src/platform/providers/models.js";
import { Platform } from "../../src/platform/engine.js";
import { Store } from "../../src/platform/storage/store.js";
import type { HistoryItem } from "../../src/platform/providers/types.js";
import { scripted, setup } from "./helpers.js";

function fakeFetch(responses: unknown[]) {
  const sent: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}
const ok = { choices: [{ message: { role: "assistant", content: "好" }, finish_reason: "stop" }] };
const user: HistoryItem = { role: "user", text: "我推门" };
const tools = [{ name: "reply", description: "d", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }];

// ---------------- OpenAI API mode ----------------

test("OpenAI chat mode talks Chat Completions to a compatible endpoint", async () => {
  const { fetcher, sent } = fakeFetch([ok]);
  const config = resolveProviderConfig("openai", { apiKey: "k", apiMode: "chat", baseUrl: "https://relay.example/v1", reasoningEffort: "low" }, {});
  const r = await createProvider("openai", config, fetcher).step({ system: "SYS", systemParts: { stable: "A", dynamic: "B" }, history: [user], tools });
  assert.equal(r.text, "好");
  const { url, headers, body } = sent[0];
  assert.equal(url, "https://relay.example/v1/chat/completions");
  assert.equal(headers.authorization, "Bearer k");
  assert.equal(headers["X-Title"], undefined, "no OpenRouter headers");
  assert.equal(body.max_tokens, 4000, "relays expect max_tokens");
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.reasoning, undefined);
  assert.deepEqual(body.messages[0], { role: "system", content: "SYS" }, "plain system string, no cache blocks");
  assert.deepEqual(body.messages[1], { role: "user", content: "我推门" });
});

test("OpenAI chat mode on api.openai.com uses max_completion_tokens; Responses mode sends reasoning effort", async () => {
  const chat = fakeFetch([ok]);
  await createProvider("openai", resolveProviderConfig("openai", { apiKey: "k", apiMode: "chat" }, {}), chat.fetcher).complete({ system: "s", prompt: "p", maxTokens: 900 });
  assert.equal(chat.sent[0].body.max_completion_tokens, 900);
  assert.equal(chat.sent[0].body.max_tokens, undefined);

  const resp = fakeFetch([{ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "好" }] }] }]);
  await createProvider("openai", resolveProviderConfig("openai", { apiKey: "k", reasoningEffort: "high" }, {}), resp.fetcher).complete({ system: "s", prompt: "p" });
  assert.equal(resp.sent[0].url, "https://api.openai.com/v1/responses");
  assert.deepEqual(resp.sent[0].body.reasoning, { effort: "high" });
});

test("API mode: stored beats env beats default, and only OpenAI has one", () => {
  assert.equal(resolveProviderConfig("openai", undefined, {}).apiMode, "responses");
  assert.equal(resolveProviderConfig("openai", undefined, { OPENAI_API_MODE: "chat" }).apiMode, "chat");
  assert.equal(resolveProviderConfig("openai", { apiMode: "responses" }, { OPENAI_API_MODE: "chat" }).apiMode, "responses");
  assert.equal(resolveProviderConfig("openai", undefined, { OPENAI_API_MODE: "nonsense" }).apiMode, "responses");
  assert.equal(resolveProviderConfig("openrouter", undefined, {}).apiMode, undefined);

  const { platform } = setup({ provider: scripted([]) });
  assert.equal((platform.configureProvider("openai", { apiMode: "chat" }) as any).apiMode, "chat");
  assert.throws(() => platform.configureProvider("openai", { apiMode: "grpc" }), /responses.*chat/);
  assert.throws(() => platform.configureProvider("anthropic", { apiMode: "chat" }), /只有 openai/);
});

// ---------------- model lists ----------------

test("model lists: OpenRouter keeps tool-capable models with prices, other providers use their own auth", async () => {
  const or = fakeFetch([
    {
      data: [
        { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", context_length: 1048576, pricing: { prompt: "0.000000825", completion: "0.000004125" }, supported_parameters: ["tools", "reasoning"] },
        { id: "google/gemini-3.8-flash:batch", supported_parameters: ["tools"] },
        { id: "some/no-tools", supported_parameters: ["temperature"] },
        { id: "anthropic/claude-haiku-5.5", pricing: { prompt: "0.0000001", completion: "0.0000005" }, supported_parameters: ["tools"] },
      ],
    },
  ]);
  const models = await listModels("openrouter", resolveProviderConfig("openrouter", undefined, {}), or.fetcher);
  assert.deepEqual(models.map((m) => m.id), ["anthropic/claude-haiku-5.5", "google/gemini-3.8-flash"]);
  assert.deepEqual(models[1].price, { input: 0.825, output: 4.125 });
  assert.equal(models[1].contextLength, 1048576);
  assert.equal(or.sent[0].url, "https://openrouter.ai/api/v1/models");

  const an = fakeFetch([{ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] }]);
  const a = await listModels("anthropic", resolveProviderConfig("anthropic", { apiKey: "ak" }, {}), an.fetcher);
  assert.deepEqual(a, [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }]);
  assert.equal(an.sent[0].headers["x-api-key"], "ak");

  const oa = fakeFetch([{ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6.1-sol" }] }]);
  const o = await listModels("openai", resolveProviderConfig("openai", { apiKey: "ok", baseUrl: "https://relay.example/v1" }, {}), oa.fetcher);
  assert.deepEqual(o, [{ id: "gpt-6.1-sol" }], "deduplicated");
  assert.equal(oa.sent[0].url, "https://relay.example/v1/models");
  assert.equal(oa.sent[0].headers.authorization, "Bearer ok");

  const ge = fakeFetch([{ models: [{ name: "models/gemini-4-argon", displayName: "Gemini 4 Argon", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }]);
  const g = await listModels("gemini", resolveProviderConfig("gemini", { apiKey: "gk" }, {}), ge.fetcher);
  assert.deepEqual(g.map((m) => m.id), ["gemini-4-argon"]);
  assert.equal(ge.sent[0].headers["x-goog-api-key"], "gk");
});

test("platform model lists need a key (except OpenRouter) and are cached until settings change", async () => {
  const { fetcher, sent } = fakeFetch([{ data: [{ id: "a/b", supported_parameters: ["tools"] }] }, { data: [{ id: "a/c", supported_parameters: ["tools"] }] }]);
  const platform = new Platform(new Store(":memory:"), { env: {}, fetcher });
  await assert.rejects(platform.listModels("anthropic"), /未配置 API key/);
  assert.deepEqual((await platform.listModels("openrouter")).map((m) => m.id), ["a/b"]);
  await platform.listModels("openrouter");
  assert.equal(sent.length, 1, "cached");
  platform.configureProvider("openrouter", { apiKey: "new" });
  assert.deepEqual((await platform.listModels("openrouter")).map((m) => m.id), ["a/c"], "refetched after settings change");
  assert.equal(sent[1].headers.authorization, "Bearer new");
});

// ---------------- campaign provider ----------------

test("a campaign can switch its main provider; the old model name is dropped unless a new one is given", () => {
  const { platform, store, campaign } = setup({ provider: scripted([]), campaignProvider: "openrouter", models: { main: "anthropic/claude-opus-5.5" } });
  const switched = platform.setModels(campaign.id, { provider: "anthropic" });
  assert.equal(store.getCampaign(campaign.id).provider, "anthropic");
  assert.equal(store.getCampaign(campaign.id).settings.models.main, null);
  assert.equal(switched.main.model, "claude-opus-5-5", "the new provider's default");
  platform.setModels(campaign.id, { provider: "openrouter", main: "google/gemini-3.8-flash" });
  assert.deepEqual(platform.models(store.getCampaign(campaign.id)).main, { provider: "openrouter", model: "google/gemini-3.8-flash" });
  assert.throws(() => platform.setModels(campaign.id, { provider: "skynet" }), /provider/);
});

// ---------------- DeepSeek ----------------

test("DeepSeek: Chat Completions at api.deepseek.com, thinking controls, reasoning_content replayed with tools", async () => {
  const toolCalls = [{ id: "t1", type: "function", function: { name: "reply", arguments: '{"text":"好"}' } }];
  const { fetcher, sent } = fakeFetch([
    {
      choices: [{ message: { role: "assistant", content: "", reasoning_content: "先想一想", tool_calls: toolCalls }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1000, completion_tokens: 80, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300 },
    },
    ok,
  ]);
  const config = resolveProviderConfig("deepseek", { apiKey: "dk", reasoningEffort: "high" }, {});
  assert.equal(config.model, "deepseek-v4-pro");
  const p = createProvider("deepseek", config, fetcher);
  const r = await p.step({ system: "SYS", systemParts: { stable: "A", dynamic: "B" }, history: [user], tools });
  assert.equal(r.usage!.cached, 700, "cache hits come from prompt_cache_hit_tokens");
  assert.equal(r.usage!.cost, undefined);
  const first = sent[0];
  assert.equal(first.url, "https://api.deepseek.com/chat/completions");
  assert.equal(first.headers.authorization, "Bearer dk");
  assert.deepEqual(first.body.thinking, { type: "enabled" });
  assert.equal(first.body.reasoning_effort, "high");
  assert.equal(first.body.max_tokens, 8000);
  assert.deepEqual(first.body.messages[0], { role: "system", content: "SYS" });

  await p.step({
    system: "SYS",
    history: [user, { role: "assistant", native: r.native }, { role: "tool", results: [{ id: "t1", name: "reply", content: '{"ok":true}', isError: false }] }],
    tools,
  });
  assert.deepEqual(sent[1].body.messages[2], { role: "assistant", content: "", tool_calls: toolCalls, reasoning_content: "先想一想" }, "DeepSeek rejects tool follow-ups without it");

  const off = fakeFetch([ok]);
  await createProvider("deepseek", resolveProviderConfig("deepseek", { apiKey: "dk", reasoningEffort: "none" }, {}), off.fetcher).complete({ system: "s", prompt: "p" });
  assert.deepEqual(off.sent[0].body.thinking, { type: "disabled" });
  assert.equal(off.sent[0].body.reasoning_effort, undefined);
});

test("DeepSeek: default aux model, model list, and a campaign can use it", async () => {
  const { fetcher, sent } = fakeFetch([{ object: "list", data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }] }]);
  const models = await listModels("deepseek", resolveProviderConfig("deepseek", { apiKey: "dk" }, {}), fetcher);
  assert.deepEqual(models.map((m) => m.id), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(sent[0].url, "https://api.deepseek.com/models");

  const { platform, store, campaign } = setup({ provider: scripted([]) });
  platform.setModels(campaign.id, { provider: "deepseek" });
  assert.deepEqual(platform.models(store.getCampaign(campaign.id)), {
    main: { provider: "deepseek", model: "deepseek-v4-pro" },
    aux: { provider: "deepseek", model: "deepseek-flash" },
  });
});

// ---------------- model roles ----------------

test("role defaults: validated, and used by campaigns that did not choose for themselves", () => {
  const { platform, store, campaign } = setup({ provider: scripted([]), campaignProvider: "openrouter" });
  assert.deepEqual(platform.roleDefaults().main, { provider: null, model: null });
  assert.throws(() => platform.setRoleDefaults({ main: { provider: "skynet" } }), /KP 主持的接口/);
  assert.throws(() => platform.setRoleDefaults({ aux: { model: "x" } }), /先选接口/);
  assert.throws(() => platform.setRoleDefaults({ compile: { provider: "openrouter", model: "has space" } }), /模型/);

  platform.setRoleDefaults({
    main: { provider: "openrouter", model: "google/gemini-3.8-flash" },
    aux: { provider: "deepseek", model: "deepseek-flash" },
  });
  // The campaign left main/aux empty, so it follows the roles.
  assert.deepEqual(platform.models(store.getCampaign(campaign.id)), {
    main: { provider: "openrouter", model: "google/gemini-3.8-flash" },
    aux: { provider: "deepseek", model: "deepseek-flash" },
  });
  // Its own choice wins.
  platform.setModels(campaign.id, { main: "anthropic/claude-opus-5.5", auxProvider: "openrouter", auxModel: "anthropic/claude-haiku-5.5" });
  assert.deepEqual(platform.models(store.getCampaign(campaign.id)), {
    main: { provider: "openrouter", model: "anthropic/claude-opus-5.5" },
    aux: { provider: "openrouter", model: "anthropic/claude-haiku-5.5" },
  });
  // A role's model only applies to its own provider.
  platform.setModels(campaign.id, { provider: "anthropic" });
  assert.equal(platform.models(store.getCampaign(campaign.id)).main.model, "claude-opus-5-5");
});

test("role defaults fill in the provider when importing a scenario or opening a campaign", async () => {
  const compiler = scripted([]);
  const { platform, store, scenarioId } = setup({ provider: scripted([]), compiler });
  assert.throws(() => platform.compileScenario(scenarioId, {}), /整理剧本用的接口/);
  assert.throws(() => platform.createCampaign({ name: "x", systemId: "coc7", scenarioId, players: [{ id: "p", name: "P" }] }), /KP 用的接口/);

  platform.setRoleDefaults({ compile: { provider: "demo" }, main: { provider: "deepseek", model: "deepseek-flash" } });
  platform.compileScenario(scenarioId, {});
  await platform.compileIdle(scenarioId);
  assert.equal(platform.scenarioSummary(scenarioId).compileStatus, "done", "compiled with the role's provider (demo here)");

  const c = platform.createCampaign({ name: "x", systemId: "coc7", scenarioId, players: [{ id: "p", name: "P" }] });
  assert.equal(c.provider, "deepseek");
  assert.equal(platform.models(store.getCampaign(c.id)).main.model, "deepseek-flash");
});
