// Offline demo model: fixed script, no intelligence. It exercises the real tool loop, dice and storage
// so the platform can be tried without an API key. Replies are clearly labelled as a demo.
import type { ModelProvider, StepResult } from "./types.js";

export function demoProvider(): ModelProvider {
  let counter = 0;
  const id = () => `demo-${++counter}`;
  return {
    id: "demo",
    model: "offline-demo",
    async step(req): Promise<StepResult> {
      const last = req.history[req.history.length - 1];
      const hasTool = (name: string) => req.tools.some((t) => t.name === name);
      if (last.role === "user") {
        let input: { kind?: string; text?: string } = {};
        try {
          input = JSON.parse(last.text);
        } catch {}
        if (input.kind === "action" && hasTool("roll")) {
          const call = { id: id(), name: "roll", args: { expression: "1d20", reason: "离线演示：行动判定" } };
          return { text: "", calls: [call], native: [{ type: "tool_use", ...call }], stop: "tool_use" };
        }
      }
      let rolled = "";
      if (last.role === "tool") {
        try {
          rolled = JSON.parse(last.results[0].content).summary ?? "";
        } catch {}
      }
      const call = {
        id: id(),
        name: "reply",
        args: {
          text: `【离线演示 · 固定脚本，无智能】${rolled ? `${rolled}。` : ""}雾气在你们身边流动，远处传来模糊的钟声。你们打算怎么做？`,
          whispers: null,
        },
      };
      return { text: "", calls: [call], native: [{ type: "tool_use", ...call }], stop: "tool_use" };
    },
    async complete(req) {
      const tail = req.prompt.slice(-200).replace(/\s+/g, " ");
      return JSON.stringify({
        public: `【离线演示摘要】${tail}`,
        kp: `【离线演示摘要】${tail}`,
      });
    },
  };
}
