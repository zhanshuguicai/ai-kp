import { Platform } from "../../src/platform/engine.js";
import { Store } from "../../src/platform/storage/store.js";
import type { ModelProvider, StepRequest, StepResult, ToolCall } from "../../src/platform/providers/types.js";
import type { Rng } from "../../src/platform/rules/types.js";

export const SCENARIO = `# 雾港停钟

## 背景
雾港的钟楼已经停摆三天。信使阿澄委托调查员寻找一封遗失的信。

## 场景：钟楼
钟楼底层堆满铜屑，楼梯上有新鲜的泥脚印。顶层的齿轮少了一枚。

## 场景：码头
码头账簿记录着一艘没有船名的货船，每逢钟声停止的夜晚靠岸。

## NPC
守钟人老秦：藏起了齿轮，想阻止走私者利用钟声暗号。
信使阿澄：不知道走私的事，只想找回信。

## 真相
走私者用钟声作为卸货暗号。老秦拆下齿轮让钟停摆。`;

export const BRIEF = "核心真相：走私者用钟声当暗号；守钟人老秦拆下齿轮阻止他们。阿澄不知情。";

/** A provider whose replies are scripted per call. It records every request it receives. */
export function scripted(steps: ((req: StepRequest) => StepResult)[], summaries: string[] = []) {
  const requests: StepRequest[] = [];
  let i = 0;
  let s = 0;
  const provider: ModelProvider & { requests: StepRequest[]; completions: string[] } = {
    id: "fake",
    model: "fake",
    requests,
    completions: [],
    async step(req) {
      requests.push(structuredClone(req));
      const fn = steps[i++];
      if (!fn) throw new Error(`scripted provider ran out of steps (call ${i})`);
      return fn(req);
    },
    async complete(req) {
      provider.completions.push(req.prompt);
      return summaries[s++] ?? JSON.stringify({ public: `公开摘要${s}`, kp: `KP摘要${s}` });
    },
  };
  return provider;
}

let callId = 0;
export const calls = (...cs: [string, Record<string, unknown>][]): StepResult => {
  const list: ToolCall[] = cs.map(([name, args]) => ({ id: `call-${++callId}`, name, args }));
  return { text: "", calls: list, native: list, stop: "tool_use" };
};
export const say = (text: string): StepResult => ({ text, calls: [], native: [{ text }], stop: "end" });
export const reply = (text: string, whispers: unknown = null) => calls(["reply", { text, whispers }]);

export function lastToolResults(req: StepRequest) {
  const last = req.history[req.history.length - 1];
  if (last.role !== "tool") throw new Error("last history item is not tool results");
  return last.results.map((r) => ({ ...r, body: JSON.parse(r.content) }));
}

export function setup(opts: { provider?: ModelProvider; aux?: ModelProvider; compiler?: ModelProvider; campaignProvider?: string; models?: Record<string, unknown>; env?: NodeJS.ProcessEnv; rng?: Rng; systemId?: string; budgets?: Record<string, number>; sheets?: Record<string, unknown>; autoCompress?: boolean; review?: boolean } = {}) {
  const store = new Store(":memory:");
  const platform = new Platform(store, {
    providerFactory: (_id, { role }) =>
      role === "aux" && opts.aux ? opts.aux : role === "compile" && opts.compiler ? opts.compiler : opts.provider!,
    env: opts.env ?? {},
    rng: opts.rng,
    autoCompress: opts.autoCompress ?? false,
  });
  const scenario = platform.addScenario({ title: "雾港停钟", text: SCENARIO, brief: BRIEF });
  const campaign = platform.createCampaign({
    name: "测试团",
    systemId: opts.systemId ?? "coc7",
    scenarioId: scenario.id,
    provider: opts.campaignProvider ?? "demo",
    models: opts.models,
    players: [
      { id: "p1", name: "林雾", sheet: opts.sheets?.p1 ?? null },
      { id: "p2", name: "周岚", sheet: opts.sheets?.p2 ?? null },
    ],
    // Spoiler review is on in real campaigns; tests turn it on where they exercise it.
    settings: { ...(opts.budgets ? { budgets: opts.budgets } : {}), review: { enabled: opts.review ?? false } },
  });
  return { store, platform, campaign, scenarioId: scenario.id };
}
