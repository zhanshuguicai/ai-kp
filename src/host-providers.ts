import { Fault, requireThat, object } from "./foundation.js";

export type HostProviderId = "demo" | "openai" | "anthropic" | "gemini";
export interface HostProviderConfig {
  model: string;
  apiKey?: string;
  baseUrl: string;
  timeoutMs: number;
  maxOutput: number;
}
export const defaults: Record<string, HostProviderConfig> = {
  openai: {
    model: "gpt-6.1-sol",
    baseUrl: "https://api.openai.com/v1",
    timeoutMs: 60000,
    maxOutput: 4000,
  },
  anthropic: {
    model: "claude-opus-5-5",
    baseUrl: "https://api.anthropic.com/v1",
    timeoutMs: 60000,
    maxOutput: 4000,
  },
  gemini: {
    model: "gemini-4-argon",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    timeoutMs: 60000,
    maxOutput: 4000,
  },
};
const schema = (properties: any, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const s = { type: "string" };
const strings = { type: "array", items: s };
export const hostTools = [
  {
    name: "roll_dice",
    description:
      "执行服务端真实随机骰。自行根据原文规则判断是否需要、表达式、难度；不得伪造结果。只在需要公开骰点时调用，reason必须可向玩家公开。支持 NdM+K。",
    parameters: schema({ expression: s, reason: s }),
  },
  {
    name: "remember_campaign",
    description:
      "更新团记忆。facts只能含玩家已知事实；gmNotes只含主持私密事实。数组为本次新增记忆。",
    parameters: schema({ facts: strings, gmNotes: strings }),
  },
  {
    name: "update_progress",
    description:
      "更新主线、支线、NPC公开状态与节奏。所有字段是完整当前公开状态。NPC秘密请写gmNotes。",
    parameters: schema({
      mainQuest: s,
      sideQuests: strings,
      npcs: strings,
      pace: s,
    }),
  },
  {
    name: "query_materials",
    description:
      "读取完整原文的一个分块。offset为字符位置，返回下个offset；也可用keyword定位，不会截断存储。仅供主持，不能原样公开秘密。",
    parameters: schema({
      kind: { type: "string", enum: ["rules", "scenario"] },
      offset: { type: "integer", minimum: 0 },
      keyword: s,
    }),
  },
  {
    name: "finish_turn",
    description:
      "完成本轮。仅publicReply会发给玩家；不得泄露GM秘密或内部工具参数。调用前先更新需要保存的事实与进度。",
    parameters: schema({ publicReply: s }),
  },
];
export interface ToolCall {
  id: string;
  name: string;
  args: any;
}
export type ToolExecutor = (call: ToolCall) => Promise<any>;
export interface RunContext {
  system: string;
  input: string;
  kind: string;
  execute: ToolExecutor;
}
export async function runHostProvider(
  id: HostProviderId,
  config: HostProviderConfig | undefined,
  ctx: RunContext,
  fetcher: typeof fetch = fetch,
) {
  if (id === "demo") {
    // Fixed protocol fixture, not an intelligent narrator. Dice still use the production server executor.
    let roll: any;
    if (ctx.kind === "action" || ctx.kind === "auto")
      roll = await ctx.execute({
        id: "demo-dice",
        name: "roll_dice",
        args: { expression: "1d20", reason: "离线协议演示检定" },
      });
    await ctx.execute({
      id: "demo-memory",
      name: "remember_campaign",
      args: {
        facts: [
          `离线协议演示：当前输入摘要（最多1000字符；完整输入保留公开事件）：${ctx.input.slice(0, 1000)}`,
        ],
        gmNotes: ["离线协议演示私密记忆：守钟人的秘密仍未公开。"],
      },
    });
    await ctx.execute({
      id: "demo-progress",
      name: "update_progress",
      args: {
        mainQuest: "调查雾港钟楼的停摆",
        sideQuests: ["帮助码头信使寻找遗失的信"],
        npcs: ["信使阿澄：等待玩家回应"],
        pace: "离线演示：等待玩家自主选择",
      },
    });
    return ctx.execute({
      id: "demo-finish",
      name: "finish_turn",
      args: {
        publicReply: `【离线协议演示 · 固定脚本，无智能承诺】${roll ? `服务端骰点 ${roll.expression} = ${roll.total}。` : ""}钟楼的回声穿过雾气，信使停下脚步，等待你说明下一步打算。此固定示例只验证工具与记忆闭环。`,
      },
    });
  }
  requireThat(
    config?.apiKey,
    "MISSING_CREDENTIALS",
    `${id} 未配置 API key；没有自动回落到演示`,
    400,
  );
  const c = config!;
  const toolDefs =
    id === "anthropic"
      ? hostTools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }))
      : hostTools.map((t) => ({
          type: "function",
          ...t,
          ...(id === "openai" ? { strict: true } : {}),
        }));
  const history: any[] =
    id === "gemini"
      ? [{ type: "user_input", content: [{ type: "text", text: ctx.input }] }]
      : [{ role: "user", content: ctx.input }];
  for (let round = 0; round < 8; round++) {
    const payload: any =
      id === "openai"
        ? {
            model: c.model,
            instructions: ctx.system,
            input: history,
            tools: toolDefs,
            store: false,
            max_output_tokens: c.maxOutput,
            reasoning: { effort: "medium" },
          }
        : id === "anthropic"
          ? {
              model: c.model,
              system: ctx.system,
              messages: history,
              tools: toolDefs,
              max_tokens: c.maxOutput,
            }
          : {
              model: c.model,
              system_instruction: ctx.system,
              input: history,
              tools: toolDefs,
              store: false,
              generation_config: { max_output_tokens: c.maxOutput },
            };
    let response: Response;
    try {
      response = await fetcher(
        `${c.baseUrl.replace(/\/$/, "")}/${id === "openai" ? "responses" : id === "anthropic" ? "messages" : "interactions"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(id === "anthropic"
              ? { "x-api-key": c.apiKey!, "anthropic-version": "2023-06-01" }
              : id === "gemini"
                ? { "x-goog-api-key": c.apiKey! }
                : { authorization: `Bearer ${c.apiKey}` }),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(c.timeoutMs),
        },
      );
    } catch {
      throw new Fault(
        "PROVIDER_NETWORK",
        `${id} 请求超时或网络失败；已完成骰点保留，重发相同messageId不会重新执行`,
        502,
      );
    }
    if (!response.ok)
      throw new Fault(
        "PROVIDER_HTTP",
        `${id} 返回 HTTP ${response.status}；请检查密钥、模型、额度和接口地址`,
        502,
      );
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Fault("PROVIDER_PROTOCOL", `${id} 返回非JSON响应`, 502);
    }
    requireThat(
      !data.error &&
        !["failed", "cancelled", "incomplete"].includes(data.status) &&
        (id !== "openai" || data.status !== "in_progress") &&
        (id !== "anthropic" ||
          !["max_tokens", "refusal", "pause_turn"].includes(data.stop_reason)),
      "PROVIDER_INCOMPLETE",
      `${id} 响应被截断、拒绝或未完成；未执行本轮工具`,
      502,
    );
    const blocks =
      id === "openai"
        ? data.output
        : id === "anthropic"
          ? data.content
          : data.steps;
    requireThat(
      Array.isArray(blocks),
      "PROVIDER_PROTOCOL",
      `${id} 缺少原生工具响应数组`,
      502,
    );
    const calls: ToolCall[] = blocks
      .filter(
        (b: any) =>
          b.type === (id === "anthropic" ? "tool_use" : "function_call"),
      )
      .map((b: any) => {
        let args = b.arguments ?? b.input;
        try {
          if (typeof args === "string") args = JSON.parse(args);
        } catch {
          throw new Fault("PROVIDER_PROTOCOL", "模型工具参数不是JSON", 502);
        }
        return { id: id === "openai" ? b.call_id : b.id, name: b.name, args };
      });
    requireThat(
      calls.length > 0 && calls.length <= 12,
      "PROVIDER_PROTOCOL",
      "模型未调用 finish_turn 或返回过多工具；未公开其原始文本",
      502,
    );
    // Keep reasoning/thinking/signature and other native blocks intact for provider continuation.
    if (id === "anthropic")
      history.push({ role: "assistant", content: blocks });
    else history.push(...blocks);
    const results: any[] = [];
    let finished: any;
    for (const call of calls) {
      requireThat(
        typeof call.id === "string" &&
          typeof call.name === "string" &&
          object(call.args),
        "PROVIDER_PROTOCOL",
        "工具调用格式无效",
        502,
      );
      requireThat(
        finished === undefined,
        "PROVIDER_PROTOCOL",
        "finish_turn 必须为本轮最后一个工具",
        502,
      );
      const result = await ctx.execute(call);
      if (call.name === "finish_turn") finished = result;
      results.push(
        id === "openai"
          ? {
              type: "function_call_output",
              call_id: call.id,
              output: JSON.stringify(result),
            }
          : id === "anthropic"
            ? {
                type: "tool_result",
                tool_use_id: call.id,
                content: JSON.stringify(result),
              }
            : {
                type: "function_result",
                name: call.name,
                call_id: call.id,
                result: [{ type: "text", text: JSON.stringify(result) }],
              },
      );
    }
    if (finished !== undefined) return finished;
    if (id === "anthropic") history.push({ role: "user", content: results });
    else history.push(...results);
  }
  throw new Fault(
    "TOOL_LIMIT",
    "主持工具轮次达到8轮上限；已完成骰点和记忆保留",
    502,
  );
}
