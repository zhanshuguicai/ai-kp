import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scriptedRng } from "../../src/platform/rules/rng.js";
import { Store } from "../../src/platform/storage/store.js";
import { calls, scripted, setup } from "./helpers.js";

// Distinctive strings that must never reach the organizer or the wrong player.
const SECRETS = {
  roll: "心理学(50)", // secret roll summary
  note: "老秦口袋里藏着齿轮",
  clock: "走私船离港",
  clockNote: "证据被运走",
  whisperP1: "只有林雾知道的低语",
  kpSummary: "KP版摘要：老秦是幕后之人",
};

/** A campaign whose history contains every kind of secret, plus a full threat clock (so the director names it). */
async function secretCampaign() {
  const provider = scripted(
    [
      () =>
        calls(
          ["check", { actor: "p1", stat: "心理学", reason: "判断真伪", value: 50, secret: true }],
          ["note_secret", { text: SECRETS.note }],
          ["advance_clock", { name: SECRETS.clock, delta: 4, size: 4, note: SECRETS.clockNote }],
          ["reply", { text: "老秦沉默不语。", whispers: [{ playerId: "p1", text: SECRETS.whisperP1 }] }],
        ),
      () => calls(["reply", { text: "雾更浓了。", whispers: null }]),
    ],
    [JSON.stringify({ public: "调查员们在钟楼盘问了老秦。", kp: SECRETS.kpSummary })],
  );
  const ctx = setup({ provider, rng: scriptedRng([3, 0]) });
  await ctx.platform.message(ctx.campaign.id, { messageId: "m1", playerId: "p1", kind: "action", text: "我观察老秦" });
  // Second turn: the director now sees the full clock and writes its name into a directive.
  await ctx.platform.message(ctx.campaign.id, { messageId: "m2", playerId: "p2", kind: "auto", text: "我们走吧" });
  await ctx.platform.compressNow(ctx.campaign.id);
  return ctx;
}

const leaks = (value: unknown, secrets: string[]) => {
  const s = JSON.stringify(value);
  return secrets.filter((x) => s.includes(x));
};

test("the organizer view contains no secrets, but does show diagnostics", async () => {
  const { platform, store, campaign } = await secretCampaign();
  // Sanity: the secrets really exist in storage and the directive names the clock.
  const all = JSON.stringify(store.events(campaign.id));
  assert(all.includes(SECRETS.note) && all.includes(SECRETS.clock) && all.includes(SECRETS.whisperP1));
  assert(store.activeSummaries(campaign.id).some((s) => s.kpText === SECRETS.kpSummary));

  const view = platform.organizerView(campaign.id);
  assert.deepEqual(leaks(view, Object.values(SECRETS)), []);
  // Still useful: tool names, directive kinds, public log.
  assert.deepEqual(view.diagnostics[0].tools.map((t: any) => t.name), ["check", "note_secret", "advance_clock", "reply"]);
  assert(view.diagnostics[1].directives.includes("escalate"));
  assert(view.public.events.some((e) => e.text === "老秦沉默不语。"));
  assert.equal(view.memory.summaries, 1);
});

test("players see their own whispers only; nobody sees KP-only events", async () => {
  const { platform, campaign } = await secretCampaign();
  const p1 = platform.playerView(campaign.id, "p1");
  const p2 = platform.playerView(campaign.id, "p2");
  const notForPlayers = [SECRETS.roll, SECRETS.note, SECRETS.clock, SECRETS.clockNote, SECRETS.kpSummary];
  assert.deepEqual(leaks(p1, notForPlayers), []);
  assert.deepEqual(leaks(p2, [...notForPlayers, SECRETS.whisperP1]), []);
  assert(p1.events.some((e) => e.type === "whisper" && e.text === SECRETS.whisperP1));
  assert(p1.summaries.some((s) => s.text.includes("盘问了老秦")));
});

test("manual compression returns only whether summaries were written", async () => {
  const provider = scripted([() => calls(["reply", { text: "一", whispers: null }]), () => calls(["reply", { text: "二", whispers: null }])], [
    JSON.stringify({ public: "公开", kp: SECRETS.kpSummary }),
  ]);
  const { platform, campaign } = setup({ provider });
  await platform.message(campaign.id, { messageId: "a", playerId: "p1", kind: "auto", text: "一" });
  await platform.message(campaign.id, { messageId: "b", playerId: "p1", kind: "auto", text: "二" });
  assert.deepEqual(await platform.compressNow(campaign.id), { level1: true, level2: false });
});

test("the KP view stays locked until an explicit, announced, one-way reveal", async () => {
  const { platform, store, campaign } = await secretCampaign();
  assert.throws(() => platform.kpView(campaign.id), /KP 视图已锁定/);
  assert.throws(() => platform.reveal(campaign.id, {}), /confirm/);
  assert.throws(() => platform.reveal(campaign.id, { confirm: "yes" }), /confirm/);

  const { revealedAt } = platform.reveal(campaign.id, { confirm: true });
  assert(revealedAt);
  assert.equal(platform.reveal(campaign.id, { confirm: true }).revealedAt, revealedAt, "revealing twice keeps the first time");
  const announcements = store.events(campaign.id, { publicOnly: true }).filter((e) => e.type === "system" && e.text.includes("解锁了 KP 视图"));
  assert.equal(announcements.length, 1, "players are told exactly once");

  const kp = platform.kpView(campaign.id);
  assert.deepEqual(kp.state.kpNotes, [SECRETS.note]);
  assert.equal(platform.organizerView(campaign.id).campaign.revealedAt, revealedAt);
});

test("invite tokens: shown once, stored only as a hash, reissuing invalidates old links", () => {
  const { platform, store, campaign } = setup({ provider: scripted([]) });
  const [p1, p2] = platform.issueInvites(campaign.id);
  assert.equal(p1.playerId, "p1");
  assert(p1.token.length >= 30 && p1.token !== p2.token);
  assert.deepEqual(platform.authPlayer(p1.token), { campaignId: campaign.id, playerId: "p1" });

  const raw = JSON.stringify(store.db.prepare("SELECT * FROM characters").all());
  assert(!raw.includes(p1.token), "the token itself is not stored");

  const [again] = platform.issueInvites(campaign.id, "p1");
  assert.throws(() => platform.authPlayer(p1.token), /无效/);
  assert.equal(platform.authPlayer(again.token).playerId, "p1");
  assert.equal(platform.authPlayer(p2.token).playerId, "p2", "other players' links are untouched");
  for (const bad of [undefined, "", "short", "x".repeat(200)]) assert.throws(() => platform.authPlayer(bad), /邀请链接/);
});

test("adding a player mid-campaign returns their invite", () => {
  const { platform, campaign } = setup({ provider: scripted([]) });
  const inv = platform.addPlayer(campaign.id, { id: "p3", name: "沈雁" });
  assert.equal(inv.name, "沈雁");
  assert.equal(platform.authPlayer(inv.token).playerId, "p3");
  assert.throws(() => platform.addPlayer(campaign.id, { id: "p3", name: "重复" }), /已存在/);
});

test("players act as themselves and edit only their own sheet", async () => {
  const provider = scripted([(req) => {
    const input = JSON.parse((req.history[0] as any).text);
    assert.equal(input.playerId, "p2");
    return calls(["reply", { text: "好的", whispers: [{ playerId: "p2", text: "给周岚的私聊" }, { playerId: "p1", text: "给林雾的私聊" }] }]);
  }]);
  const { platform, store, campaign } = setup({ provider });
  const out = await platform.playerMessage(campaign.id, "p2", { messageId: "x", playerId: "p1", kind: "auto", text: "你好" });
  assert.equal(out.turn.playerId, "p2", "body playerId is ignored");
  assert(out.events.some((e) => e.text === "给周岚的私聊"));
  assert(!out.events.some((e) => e.text === "给林雾的私聊"));

  platform.setOwnSheet(campaign.id, "p2", { sheet: { skills: { 侦查: 70 } } });
  assert.deepEqual(store.characters(campaign.id).find((c) => c.playerId === "p2")!.sheet, { skills: { 侦查: 70 } });
  assert.throws(() => platform.setOwnSheet(campaign.id, "p2", { sheet: { skills: { 侦查: "高" } } }), /skills/);
});

test("databases created before this change gain the new columns on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "aikp-migrate-"));
  const path = join(dir, "old.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL, system_id TEXT NOT NULL, scenario_id TEXT NOT NULL,
        provider TEXT NOT NULL, settings TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE characters (campaign_id TEXT NOT NULL, player_id TEXT NOT NULL, name TEXT NOT NULL, sheet TEXT NOT NULL,
        PRIMARY KEY (campaign_id, player_id));
      INSERT INTO campaigns VALUES ('c1', '旧团', 'coc7', 's1', 'demo', '{}', '2026-10-01T00:00:00.000Z');
      INSERT INTO characters VALUES ('c1', 'p1', '林雾', 'null');
    `);
    old.close();
    const store = new Store(path);
    const c = store.getCampaign("c1");
    assert.equal(c.revealedAt, null);
    assert.equal(store.characters("c1")[0].invited, false);
    store.setPlayerTokenHash("c1", "p1", "h");
    assert.deepEqual(store.findPlayerByTokenHash("h"), { campaignId: "c1", playerId: "p1" });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
