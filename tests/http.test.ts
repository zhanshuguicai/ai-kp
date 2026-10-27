import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { GameService } from "../src/game.js";
import { MemoryStore } from "../src/foundation.js";
import { providers } from "../src/providers.js";
import { httpServer } from "../src/server.js";
test("HTTP auth, same-origin boundary, JSON packages, restore and secret projection", async () => {
  const game = new GameService(new MemoryStore(), providers({}));
  await game.init();
  const server = httpServer(game, "admin-test");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, b: any, headers: any = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(b),
    });
  try {
    assert.equal((await fetch(base + "/api/health")).status, 200);
    assert.equal((await post("/api/sessions", { name: "x" })).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/catalog", {
          headers: { origin: "http://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/api/packages/import",
          { kind: "rules" },
          { "x-admin-token": "admin-test" },
        )
      ).status,
      400,
    );
    const created = await post(
      "/api/sessions",
      { name: "room" },
      { "x-admin-token": "admin-test" },
    );
    assert.equal(created.status, 201);
    const c = (await created.json()) as any;
    const joined = await post(`/api/sessions/${c.session.id}/join`, {
      name: "A",
      inviteCode: c.inviteCode,
    });
    const j = (await joined.json()) as any;
    assert.equal(joined.status, 201);
    assert.equal(
      (
        await fetch(base + `/api/sessions/${c.session.id}/export`, {
          headers: { authorization: `Bearer ${j.playerToken}` },
        })
      ).status,
      403,
    );
    const exported = await fetch(
      base + `/api/sessions/${c.session.id}/export`,
      { headers: { authorization: `Bearer ${c.ownerToken}` } },
    );
    const save = (await exported.json()) as any;
    assert(!JSON.stringify(save).includes(c.ownerToken));
    assert.equal(
      (
        await post("/api/sessions/restore", save, {
          "x-admin-token": "admin-test",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await post(
          "/api/sessions/restore",
          { save: "../../secret" },
          { "x-admin-token": "admin-test" },
        )
      ).status,
      400,
    );
    const text = await (
      await fetch(base + "/api/config", {
        headers: { "x-admin-token": "admin-test" },
      })
    ).text();
    assert(!text.includes("admin-test"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
