import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { platformServer } from "../../src/platform/server.js";
import { Platform } from "../../src/platform/engine.js";
import { Store } from "../../src/platform/storage/store.js";
import { scriptedRng } from "../../src/platform/rules/rng.js";
import { SCENARIO } from "./helpers.js";

test("HTTP API: auth, local-only, scenario → campaign → start → message with the demo model", async () => {
  const platform = new Platform(new Store(":memory:"), { rng: scriptedRng([12]), autoCompress: false });
  const server = platformServer(platform, "tok");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method,
      headers: { "x-admin-token": "tok", ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  try {
    assert.equal((await call("GET", "/api/v1/health", undefined, { "x-admin-token": "" })).status, 200);
    assert.equal((await call("GET", "/api/v1/systems", undefined, { "x-admin-token": "wrong" })).status, 401);
    // fetch() ignores a custom Host header, so test DNS-rebinding protection with a raw request.
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/v1/systems`, { headers: { host: "evil.example", "x-admin-token": "tok" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(rebound, 403);
    assert.equal((await call("GET", "/api/v1/systems", undefined, { origin: "http://evil.example" })).status, 403);

    const systems = await call("GET", "/api/v1/systems");
    assert.equal(systems.body.systems.length, 7);

    const sc = await call("POST", "/api/v1/scenarios", { title: "雾港停钟", text: SCENARIO });
    assert.equal(sc.status, 201);
    assert.equal(sc.body.scenario.chunks, 5);

    const tooLong = await call("POST", "/api/v1/scenarios", { title: "x", text: "字".repeat(500_001) });
    assert.equal(tooLong.body.error.code, "INPUT_TOO_LONG");

    const cp = await call("POST", "/api/v1/campaigns", {
      name: "测试", scenarioId: sc.body.scenario.id, systemId: "dnd", provider: "demo",
      players: [{ id: "p1", name: "林雾", sheet: { level: 1, abilities: { dex: 14 } } }],
    });
    assert.equal(cp.status, 201);
    assert.equal(cp.body.campaign.systemId, "dnd5e");
    const id = cp.body.campaign.id;

    const badSheet = await call("PUT", `/api/v1/campaigns/${id}/characters/p1`, { name: "林雾", sheet: { abilities: { luck: 3 } } });
    assert.equal(badSheet.status, 400);
    assert.equal(badSheet.body.error.code, "INVALID_SHEET");

    const start = await call("POST", `/api/v1/campaigns/${id}/start`, { messageId: "s1" });
    assert.equal(start.body.turn.status, "complete");
    const msg = await call("POST", `/api/v1/campaigns/${id}/messages`, { messageId: "m1", playerId: "p1", kind: "action", text: "我推开门" });
    assert.equal(msg.body.turn.status, "complete");
    assert.match(msg.body.reply, /离线演示/);

    const kp = await call("GET", `/api/v1/campaigns/${id}`);
    assert(kp.body.events.some((e: any) => e.type === "directive"));
    const pub = await call("GET", `/api/v1/campaigns/${id}/public`);
    assert(pub.body.events.every((e: any) => e.visibility === "public"));

    const providers = await call("POST", "/api/v1/providers/openai", { apiKey: "sk-test", model: "custom" });
    assert.equal(providers.body.provider.configured, true);
    assert.equal(JSON.stringify(providers.body).includes("sk-test"), false, "keys are never returned");

    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /default-src 'self'/);
  } finally {
    server.close();
  }
});
