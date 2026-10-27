import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameService } from "../src/game.js";
import {
  builtinScenario,
  builtinRules,
  MemoryStore,
  FileStore,
  validatePackage,
  Fault,
} from "../src/foundation.js";
import { providers } from "../src/providers.js";
const reject = (code: string) => (e: any) =>
  e instanceof Fault && e.code === code;
async function fixture(store = new MemoryStore()) {
  const game = new GameService(store, providers({}), { roll: (s) => s });
  await game.init();
  const room = await game.create({ name: "test" });
  const a = await game.join(room.session.id, {
    inviteCode: room.inviteCode,
    name: "Alice",
  });
  const b = await game.join(room.session.id, {
    inviteCode: room.inviteCode,
    name: "Bob",
  });
  return { game, room, a, b, id: room.session.id };
}
const action = (
  version: number,
  requestId = "a",
  kind = "check",
  payload: any = {},
) => ({ requestId, expectedVersion: version, kind, payload });
test("catalog, owner projection and public model context contain no undisclosed secrets", async () => {
  const { game, room, a, b, id } = await fixture();
  const s = game.get(id);
  const secret = s.scenario.secrets[0];
  assert(!JSON.stringify(game.catalog()).includes(secret));
  assert.deepEqual(game.view(s, s.identities[0]).personal, []);
  assert(!JSON.stringify(game.publicContext(s, "hello")).includes(secret));
  const av = game.view(s, game.identity(s, a.playerToken));
  assert(av.personal.length === 1);
  assert(!av.events.some((e) => e.audience === b.actorId));
  assert(!JSON.stringify(av).includes(s.personal[b.actorId][0]));
  assert(
    !JSON.stringify(game.view(s, s.identities[0])).includes(a.playerToken),
  );
  assert(
    !JSON.stringify(game.view(s, s.identities[0])).includes(room.ownerToken),
  );
});
test("identity forgery and owner/player separation rejected", async () => {
  const { game, room, a, id } = await fixture();
  await assert.rejects(
    game.mutate(id, room.ownerToken, action(2)),
    reject("PLAYER_REQUIRED"),
  );
  await assert.rejects(
    game.mutate(id, a.playerToken, { ...action(2), actorId: "other" }),
    reject("INVALID_INPUT"),
  );
  await assert.rejects(
    game.mutate(
      id,
      a.playerToken,
      { requestId: "c", expectedVersion: 2, command: "pause" },
      true,
    ),
    reject("OWNER_REQUIRED"),
  );
  assert.throws(
    () => game.identity(game.get(id), "wrong"),
    reject("AUTH_REQUIRED"),
  );
});
test("same request id returns result without second die roll or cost; content reuse rejected", async () => {
  const { game, a, id } = await fixture();
  const request = action(2);
  const x = await game.mutate(id, a.playerToken, request);
  assert.deepEqual(await game.mutate(id, a.playerToken, request), x);
  assert.equal(game.get(id).actors[0].stamina, 5);
  assert.equal(game.get(id).version, 3);
  await assert.rejects(
    game.mutate(id, a.playerToken, { ...request, payload: { dc: 5 } }),
    reject("IDEMPOTENCY_CONFLICT"),
  );
});
test("concurrent writes serialize and exactly one stale version fails", async () => {
  const { game, a, b, id } = await fixture();
  const results = await Promise.allSettled([
    game.mutate(id, a.playerToken, action(2, "one")),
    game.mutate(id, b.playerToken, action(2, "two")),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason.code === "VERSION_CONFLICT",
    ).length,
    1,
  );
  assert.equal(game.get(id).version, 3);
});
test("resource exhaustion and paused actions do not commit", async () => {
  const { game, room, a, id } = await fixture();
  for (let n = 0; n < 6; n++)
    await game.mutate(id, a.playerToken, action(2 + n, "check" + n));
  await assert.rejects(
    game.mutate(id, a.playerToken, action(8, "empty")),
    reject("INSUFFICIENT_RESOURCE"),
  );
  assert.equal(game.get(id).version, 8);
  await game.mutate(
    id,
    room.ownerToken,
    { requestId: "pause", expectedVersion: 8, command: "pause" },
    true,
  );
  await assert.rejects(
    game.mutate(id, a.playerToken, action(9, "paused")),
    reject("PAUSED"),
  );
});
test("combat validates turn, target and mode and ends after authoritative damage", async () => {
  const { game, room, a, b, id } = await fixture();
  await assert.rejects(
    game.mutate(
      id,
      a.playerToken,
      action(2, "bad", "attack", { targetId: "gear-guard" }),
    ),
    reject("INVALID_INPUT"),
  );
  await game.mutate(
    id,
    room.ownerToken,
    { requestId: "combat", expectedVersion: 2, command: "start_combat" },
    true,
  );
  await assert.rejects(
    game.mutate(
      id,
      b.playerToken,
      action(3, "bad", "attack", { targetId: "gear-guard" }),
    ),
    reject("WRONG_TURN"),
  );
  await assert.rejects(
    game.mutate(
      id,
      a.playerToken,
      action(3, "bad", "attack", { targetId: b.actorId }),
    ),
    reject("INVALID_INPUT"),
  );
  await game.mutate(
    id,
    a.playerToken,
    action(3, "hit", "attack", { targetId: "gear-guard" }),
  );
  assert.equal(game.get(id).enemies[0].hp, 10);
  await game.mutate(id, a.playerToken, action(4, "end", "end_turn"));
  assert.equal(game.get(id).turnActorId, b.actorId);
  assert.equal(game.get(id).actors[0].hp, 16);
  await game.mutate(
    id,
    b.playerToken,
    action(5, "hit-b", "attack", { targetId: "gear-guard" }),
  );
  await game.mutate(
    id,
    b.playerToken,
    action(6, "finish", "attack", { targetId: "gear-guard" }),
  );
  assert.equal(game.get(id).mode, "exploration");
  assert.equal(game.get(id).turnActorId, null);
  assert.equal(game.get(id).enemies[0].hp, 0);
});
test("graph navigation respects links; free checks never reveal secrets", async () => {
  const { game, a, id } = await fixture();
  await assert.rejects(
    game.mutate(
      id,
      a.playerToken,
      action(2, "jump", "move", { sceneId: "beacon" }),
    ),
    reject("INVALID_INPUT"),
  );
  await game.mutate(
    id,
    a.playerToken,
    action(2, "move", "move", { sceneId: "cellar" }),
  );
  assert.equal(game.get(id).sceneId, "cellar");
  const x = await game.mutate(
    id,
    a.playerToken,
    action(3, "easy", "check", { dc: 5 }),
  );
  assert(!JSON.stringify(x).includes(game.get(id).scenario.secrets[0]));
});
test("malformed packages missing id, wrong type, broken links, unknown engine rejected", () => {
  for (const patch of [
    { id: undefined },
    { id: 23 },
    { version: 5 },
    { scenes: [{ ...(builtinScenario as any).scenes[0], links: ["missing"] }] },
  ])
    assert.throws(() => validatePackage({ ...builtinScenario, ...patch }));
  assert.throws(() =>
    validatePackage({ ...builtinRules, engine: "dnd-complete" }),
  );
  assert.throws(() =>
    validatePackage({ ...builtinRules, parameters: { defaultDc: 1 } }),
  );
});
test("packages import once; active session retains snapshot", async () => {
  const { game, id } = await fixture();
  const next = { ...builtinRules, version: "1.1.0", name: "next" };
  await game.importPackage(next);
  await assert.rejects(game.importPackage(next), reject("PACKAGE_EXISTS"));
  assert.equal(game.get(id).rule.version, "1.0.0");
});
test("export strips credentials; restore rotates identity and validates references and path inputs", async () => {
  const { game, room, a, id } = await fixture();
  const save = game.exportSave(game.get(id));
  const json = JSON.stringify(save);
  assert(!json.includes(room.ownerToken));
  assert(!json.includes(a.playerToken));
  assert(!json.includes(room.inviteCode));
  const restored = await game.restore(save);
  assert.notEqual(restored.session.id, id);
  assert.notEqual(restored.ownerToken, room.ownerToken);
  assert.equal(restored.recoveredPlayers.length, 2);
  assert.throws(() =>
    game.identity(game.get(restored.session.id), room.ownerToken),
  );
  await assert.rejects(game.restore("C:/private.json"), reject("INVALID_SAVE"));
  const bad = structuredClone(save);
  bad.state.events[0].audience = "missing";
  await assert.rejects(game.restore(bad), reject("INVALID_SAVE"));
  const bad2 = structuredClone(save);
  bad2.state.turnActorId = "unknown";
  await assert.rejects(game.restore(bad2), reject("INVALID_SAVE"));
});
test("file restart preserves authoritative state and original tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aikp-"));
  try {
    const store = new FileStore(dir);
    const { game, a, id } = await fixture(store as any);
    await game.mutate(id, a.playerToken, action(2));
    const restart = new GameService(new FileStore(dir), providers({}));
    await restart.init();
    assert.equal(restart.get(id).version, 3);
    assert.equal(
      restart.view(
        restart.get(id),
        restart.identity(restart.get(id), a.playerToken),
      ).actors[0].stamina,
      5,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("QQ bound identity acts once under duplicate event, no unbound access", async () => {
  const { game, room, a, id } = await fixture();
  await assert.rejects(
    game.qq({
      sessionId: id,
      qqUserId: "qq1",
      eventId: "evt",
      text: "hello",
      expectedVersion: 2,
    }),
    reject("FORBIDDEN"),
  );
  await game.bind(id, room.ownerToken, {
    qqUserId: "qq1",
    playerToken: a.playerToken,
  });
  const event = {
    sessionId: id,
    qqUserId: "qq1",
    eventId: "evt",
    text: "hello",
    expectedVersion: 2,
  };
  const first = await game.qq(event);
  assert.deepEqual(await game.qq(event), first);
  assert.equal(game.get(id).version, 3);
  assert.equal(first.channel, "qq-simulated");
});
