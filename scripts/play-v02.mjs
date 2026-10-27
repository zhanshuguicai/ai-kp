// Deterministic, in-memory proof. No API keys, external transport, QQ messages or saved credentials.
import { writeFile } from "node:fs/promises";
import { GameService } from "../dist/src/game.js";
import { MemoryStore } from "../dist/src/foundation.js";
import { providers } from "../dist/src/providers.js";
const routes = {
  peaceful: [
    "调查旧箱",
    "进入地窖",
    "摇响铜铃",
    "进入蓝灯室",
    "修复灯芯",
    "点亮蓝灯",
  ],
  combat: [
    "进入地窖",
    "挑战守卫",
    "攻击齿轮守卫",
    "攻击齿轮守卫",
    "攻击齿轮守卫",
    "进入蓝灯室",
    "修复灯芯",
    "点亮蓝灯",
  ],
  retreat: ["撤退"],
};
const result = {
  application: "0.2.0",
  scenario: "lantern-vault@2.0.0",
  provider: "mock/local-demo",
  dice: "always max (injected for deterministic proof)",
  routes: {},
};
for (const [name, inputs] of Object.entries(routes)) {
  const g = new GameService(new MemoryStore(), providers({}), {
    roll: (sides) => sides,
  });
  await g.init();
  const room = await g.create({ name: "repro-" + name });
  const player = await g.join(room.session.id, {
    inviteCode: room.inviteCode,
    name: "旅人",
  });
  const steps = [];
  let session = player.session;
  for (const [index, text] of inputs.entries()) {
    ({ session } = await g.mutate(session.id, player.playerToken, {
      requestId: "step-" + index,
      expectedVersion: session.version,
      kind: "say",
      payload: { text },
    }));
    steps.push({
      input: text,
      version: session.version,
      sceneId: session.sceneId,
      status: session.status,
      mode: session.mode,
      inventory: session.inventory,
      events: session.events
        .filter((e) => e.version === session.version)
        .map(({ type, text }) => ({ type, text })),
    });
  }
  result.routes[name] = {
    inputs,
    status: session.status,
    ending: session.ending,
    objectives: session.objectives,
    steps,
  };
}
await writeFile(
  new URL("../examples/playthrough-v02.json", import.meta.url),
  JSON.stringify(result, null, 2) + "\n",
  "utf8",
);
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(result.routes).map(([name, x]) => [
        name,
        { status: x.status, ending: x.ending.id, steps: x.steps.length },
      ]),
    ),
  ),
);
