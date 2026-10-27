// The KP tool loop. Differences from the old host loop, on purpose:
// - a bad tool call is returned to the model as an error result, not a failed turn;
// - a text-only answer is accepted as the reply (models often narrate without calling reply);
// - only truncation, refusal, too many errors or too many rounds fail the turn.
import { PlatformError } from "../errors.js";
import type { HistoryItem, ModelProvider, ToolResult } from "../providers/types.js";
import { toolErrorPayload, type KpTool, type TurnScratch } from "./tools.js";

export interface AgentOptions {
  maxRounds?: number;
  maxToolErrors?: number;
  maxCallsPerRound?: number;
}

export interface AgentTrace {
  rounds: number;
  toolCalls: { name: string; ok: boolean; error?: string }[];
  via: "reply_tool" | "text";
}

export async function runAgent(
  provider: ModelProvider,
  system: string,
  input: string,
  tools: KpTool[],
  scratch: TurnScratch,
  opts: AgentOptions = {},
): Promise<AgentTrace> {
  const maxRounds = opts.maxRounds ?? 8;
  const maxErrors = opts.maxToolErrors ?? 6;
  const maxCalls = opts.maxCallsPerRound ?? 16;
  const history: HistoryItem[] = [{ role: "user", text: input }];
  const trace: AgentTrace = { rounds: 0, toolCalls: [], via: "reply_tool" };
  let errors = 0;

  for (let round = 0; round < maxRounds; round++) {
    trace.rounds = round + 1;
    const step = await provider.step({ system, history, tools: tools.map((t) => t.def) });
    if (step.stop === "max_tokens")
      throw new PlatformError("PROVIDER_INCOMPLETE", "模型输出被截断（max tokens），本轮未发布", 502);
    if (step.stop === "refused")
      throw new PlatformError("PROVIDER_REFUSED", "模型拒绝了本轮请求，本轮未发布", 502);
    history.push({ role: "assistant", native: step.native });

    if (!step.calls.length) {
      if (!step.text) throw new PlatformError("PROVIDER_EMPTY", "模型没有给出任何回复", 502);
      scratch.reply = { text: step.text, whispers: [] };
      trace.via = "text";
      return trace;
    }

    const results: ToolResult[] = [];
    for (const [i, call] of step.calls.entries()) {
      const fail = (code: string, message: string) => {
        errors++;
        trace.toolCalls.push({ name: call.name, ok: false, error: code });
        results.push({ id: call.id, name: call.name, isError: true, content: JSON.stringify({ code, message }) });
      };
      if (i >= maxCalls) {
        fail("TOO_MANY_CALLS", `每轮最多 ${maxCalls} 个工具调用`);
        continue;
      }
      if (scratch.reply) {
        fail("AFTER_REPLY", "reply 之后不能再调用工具");
        continue;
      }
      const tool = tools.find((t) => t.def.name === call.name);
      if (!tool) {
        fail("UNKNOWN_TOOL", `没有名为 ${call.name} 的工具`);
        continue;
      }
      const args = call.args as Record<string, unknown>;
      if (typeof args !== "object" || args === null || Array.isArray(args) || "__invalidJson" in args) {
        fail("INVALID_JSON", "工具参数不是合法的 JSON 对象");
        continue;
      }
      try {
        const out = tool.run(args, scratch);
        trace.toolCalls.push({ name: call.name, ok: true });
        results.push({ id: call.id, name: call.name, isError: false, content: JSON.stringify(out ?? { ok: true }) });
      } catch (e) {
        const payload = toolErrorPayload(e);
        if (!payload) throw e; // a bug, not a model mistake
        fail(payload.code, payload.message);
      }
    }

    if (scratch.reply) return trace;
    if (errors > maxErrors)
      throw new PlatformError("TOOL_ERRORS", `模型连续给出无效工具参数（${errors} 次），本轮未发布`, 502);
    history.push({ role: "tool", results });
  }
  throw new PlatformError("ROUND_LIMIT", `模型 ${maxRounds} 步内没有给出回复，本轮未发布`, 502);
}
