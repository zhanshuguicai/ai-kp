import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptedRng } from "../../src/platform/rules/rng.js";
import { BRIEF, calls, reply, scripted, setup } from "./helpers.js";

const env = { OPENROUTER_API_KEY: "k", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" };

test("summaries use the auxiliary model, KP turns use the main model", async () => {
  const main = scripted(Array.from({ length: 4 }, () => () => reply("雾气翻涌，钟楼静默。".repeat(10))));
  const aux = scripted([]);
  const { platform, store, campaign } = setup({
    provider: main,
    aux,
    autoCompress: true,
    budgets: { recent: 200, summaries: 4000, scenario: 1000, state: 500 },
  });
  for (let i = 1; i <= 4; i++) {
    await platform.message(campaign.id, { messageId: `m${i}`, playerId: "p1", kind: "action", text: `第${i}次搜索钟楼的每一个角落` });
    await platform.idle(campaign.id);
  }
  assert(aux.completions.length > 0, "aux model wrote the summaries");
  assert.equal(main.completions.length, 0, "main model never summarizes");
  assert.equal(aux.requests.length, 0, "aux model never runs KP turns");
  assert(store.activeSummaries(campaign.id).length > 0);
});

test("model defaults: OpenRouter and Anthropic summarize with Haiku 5.5, others reuse the main model", () => {
  const or = setup({ provider: scripted([]), campaignProvider: "openrouter", env });
  assert.deepEqual(or.platform.models(or.campaign), {
    main: { provider: "openrouter", model: "anthropic/claude-opus-5.5" },
    aux: { provider: "openrouter", model: "anthropic/claude-haiku-5.5" },
  });
  const an = setup({ provider: scripted([]), campaignProvider: "anthropic", env });
  assert.equal(an.platform.models(an.campaign).aux.model, "claude-haiku-5-5");
  const oa = setup({ provider: scripted([]), campaignProvider: "openai", env });
  assert.equal(oa.platform.models(oa.campaign).aux.model, oa.platform.models(oa.campaign).main.model);
  const demo = setup({ provider: scripted([]) });
  assert.deepEqual(demo.platform.models(demo.campaign).aux, { provider: "demo", model: "offline-demo" });
});

test("each campaign can override its main and auxiliary model", () => {
  const { platform, store, campaign } = setup({
    provider: scripted([]),
    campaignProvider: "openrouter",
    env,
    models: { main: "google/gemini-4-argon", auxProvider: null, auxModel: null },
  });
  assert.equal(platform.models(store.getCampaign(campaign.id)).main.model, "google/gemini-4-argon");
  const updated = platform.setModels(campaign.id, { auxProvider: "openrouter", auxModel: "google/gemini-3.8-flash" });
  assert.equal(updated.aux.model, "google/gemini-3.8-flash");
  assert.equal(updated.main.model, "google/gemini-4-argon", "untouched fields are kept");
  assert.equal(platform.setModels(campaign.id, { main: null }).main.model, "anthropic/claude-opus-5.5", "null resets to default");
  assert.throws(() => platform.setModels(campaign.id, { auxModel: "has space" }), /模型名/);
  assert.throws(() => platform.setModels(campaign.id, { auxProvider: "nope" }), /auxProvider/);
});

test("campaigns saved before model settings existed still load with defaults", () => {
  const { platform, store, campaign } = setup({ provider: scripted([]) });
  store.db.prepare("UPDATE campaigns SET settings = ? WHERE id = ?").run(JSON.stringify({ budgets: { recent: 999 } }), campaign.id);
  const c = store.getCampaign(campaign.id);
  assert.equal(c.settings.budgets.recent, 999);
  assert.equal(c.settings.budgets.scenario, 6000);
  assert.deepEqual(c.settings.models, { main: null, auxProvider: null, auxModel: null });
  assert.equal(platform.models(c).main.provider, "demo");
});

test("system prompt is split: stable part holds rules and brief, dynamic part holds this turn's play", async () => {
  const provider = scripted([() => reply("好")]);
  const { platform, campaign } = setup({ provider });
  await platform.message(campaign.id, { messageId: "m1", playerId: "p1", kind: "action", text: "我去码头翻看账簿" });
  const { system, systemParts } = provider.requests[0];
  assert(systemParts);
  assert.equal(systemParts.stable + systemParts.dynamic, system);
  assert(systemParts.stable.includes(BRIEF) && systemParts.stable.includes("克苏鲁的呼唤"));
  assert(!systemParts.stable.includes("翻看账簿"), "player input stays out of the cached part");
  assert(systemParts.dynamic.includes("码头账簿记录"), "retrieved chunk is in the dynamic part");
});

test("token usage and cost are summed per turn and per campaign", async () => {
  const withUsage = (r: ReturnType<typeof reply>, input: number, cost: number) => ({ ...r, usage: { input, output: 20, cached: input / 2, cost } });
  const provider = scripted([
    () => withUsage(calls(["roll", { expression: "1d6", reason: "r", secret: null }]), 1000, 0.01),
    () => withUsage(reply("一"), 1200, 0.02),
    () => withUsage(reply("二"), 1500, 0.03),
  ]);
  const { platform, campaign } = setup({ provider, rng: scriptedRng([4]) });
  await platform.message(campaign.id, { messageId: "a", playerId: "p1", kind: "action", text: "掷骰" });
  await platform.message(campaign.id, { messageId: "b", playerId: "p1", kind: "auto", text: "继续" });
  platform.reveal(campaign.id, { confirm: true });
  const kp = platform.kpView(campaign.id);
  const firstTrace = kp.events.find((e) => e.type === "directive")!.data.trace;
  assert.deepEqual(firstTrace.usage, { input: 2200, output: 40, cached: 1100, cost: 0.03, calls: 2 });
  assert.equal(kp.usage.turns, 2);
  assert.equal(kp.usage.input, 3700);
  assert.equal(Math.round(kp.usage.cost! * 1000), 60);
});

test("HTTP-free check: models endpoint logic rejects unknown campaigns", () => {
  const { platform } = setup({ provider: scripted([]) });
  assert.throws(() => platform.setModels("00000000-0000-0000-0000-000000000000", { main: null }), /团不存在/);
});
