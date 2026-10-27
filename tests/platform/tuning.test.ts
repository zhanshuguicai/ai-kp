// Fixes from the first live test: clock warnings that fired every turn, and a per-campaign
// compression threshold with a spoiler-free status for the organizer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { direct } from "../../src/platform/director/director.js";
import { initialState, type WorldState } from "../../src/platform/kp/state.js";
import { DEFAULT_SETTINGS } from "../../src/platform/storage/store.js";
import { calls, reply, scripted, setup } from "./helpers.js";

const clockWarnings = (clocks: WorldState["clocks"]) => {
  const state = initialState();
  state.clocks = clocks;
  state.lastClueTurn = 1;
  return direct({ turn: 2, state, players: [{ id: "a", name: "甲" }], lastSpoke: { a: 2 }, recentOutcomes: [], settings: DEFAULT_SETTINGS.director })
    .filter((d) => d.target)
    .map((d) => `${d.target}:${d.strength}`);
};

test("director: small clocks only warn when full; big clocks warn in their last quarter", () => {
  assert.deepEqual(clockWarnings({ 短: { filled: 1, size: 2, note: "" } }), []);
  assert.deepEqual(clockWarnings({ 短: { filled: 2, size: 2, note: "" } }), ["短:3"]);
  assert.deepEqual(clockWarnings({ 长: { filled: 5, size: 8, note: "" } }), []);
  assert.deepEqual(clockWarnings({ 长: { filled: 6, size: 8, note: "" } }), ["长:2"]);
  assert.deepEqual(clockWarnings({ 中: { filled: 3, size: 4, note: "" } }), ["中:2"]);
});

test("director: a clock level is warned about once, again only after the clock moves", () => {
  assert.deepEqual(clockWarnings({ 中: { filled: 3, size: 4, note: "", warned: 3 } }), []);
  assert.deepEqual(clockWarnings({ 中: { filled: 4, size: 4, note: "", warned: 3 } }), ["中:3"]);
});

test("a clock warning is given on one turn only, and returns when the KP advances the clock", async () => {
  const provider = scripted([
    () => reply("一"),
    () => calls(["advance_clock", { name: "追兵", delta: 1, size: null, note: null }], ["reply", { text: "二", whispers: null }]),
    () => reply("三"),
  ]);
  const { platform, store, campaign } = setup({ provider });
  const { state, version } = store.getState<WorldState>(campaign.id);
  state.clocks = { 追兵: { filled: 3, size: 4, note: "" } };
  store.putState(campaign.id, state, version);
  for (const id of ["a", "b", "c"]) await platform.message(campaign.id, { messageId: id, playerId: "p1", text: "继续" });
  const warned = store.turnDiagnostics(campaign.id).map((d) => d.data.directives.some((x: any) => x.target === "追兵"));
  assert.deepEqual(warned, [true, false, true], "warned at 3/4, quiet while it sits there, warned again when full");
});

// ---------------- compression threshold ----------------

const long = "我在雾中仔细检查每一块石砖和每一道裂缝，".repeat(6);

test("compression threshold is per campaign and validated against the recent budget", () => {
  const { platform, campaign } = setup({ provider: scripted([]) });
  assert.equal(platform.organizerView(campaign.id).compression.threshold, 6000, "default = 75% of the recent budget");
  assert.throws(() => platform.setCompression(campaign.id, { threshold: 400 }), /500-8000/);
  assert.throws(() => platform.setCompression(campaign.id, { threshold: 9000 }), /不能超过/);
  assert.throws(() => platform.setCompression(campaign.id, { threshold: 1200.5 }), /整数/);
  const set = platform.setCompression(campaign.id, { threshold: 1200 });
  assert.deepEqual([set.threshold, set.custom], [1200, true]);
  assert.equal(platform.setCompression(campaign.id, { threshold: null }).threshold, 6000);
});

test("a low threshold compresses early; the organizer sees progress, never summary text", async () => {
  const provider = scripted(
    Array.from({ length: 6 }, (_, i) => () => reply(`第${i + 1}轮：雾气翻涌。`.repeat(4))),
    [JSON.stringify({ public: "公开：调查员搜索了钟楼。", kp: "KP机密：老秦藏起了齿轮。" })],
  );
  const { platform, campaign } = setup({ provider, autoCompress: true });
  platform.setCompression(campaign.id, { threshold: 500 });
  const before = platform.organizerView(campaign.id).compression;
  assert.deepEqual([before.summaries, before.summarizedThroughTurn], [0, null]);
  for (let i = 1; i <= 6 && provider.completions.length === 0; i++) {
    await platform.message(campaign.id, { messageId: `m${i}`, playerId: "p1", text: `第${i}轮行动：${long}` });
    await platform.idle(campaign.id);
  }
  assert.equal(provider.completions.length, 1, "compressed well before the default 6000-token threshold");
  const view = platform.organizerView(campaign.id);
  assert.equal(view.compression.summaries, 1);
  assert(view.compression.summarizedThroughTurn! >= 1);
  assert(view.compression.pendingTokens < view.compression.threshold);
  assert.equal(view.compression.lastError, null);
  assert(!JSON.stringify(view).includes("KP机密"), "organizer view holds no KP summary text");
});

test("a failed compression shows our own error message, not the model's output", async () => {
  const provider = scripted([() => reply("一"), () => reply("二")], ["老秦藏起了齿轮（不是 JSON）", "还是不是 JSON"]);
  const { platform, campaign } = setup({ provider, autoCompress: true });
  platform.setCompression(campaign.id, { threshold: 500 });
  for (const id of ["a", "b"]) {
    await platform.message(campaign.id, { messageId: id, playerId: "p1", text: long.repeat(3) });
    await platform.idle(campaign.id);
  }
  const c = platform.organizerView(campaign.id).compression;
  assert.match(c.lastError!, /有效 JSON/);
  assert(!c.lastError!.includes("齿轮"));
});
