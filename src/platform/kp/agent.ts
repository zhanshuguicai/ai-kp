// The KP tool loop. Differences from the old host loop, on purpose:
// - a bad tool call is returned to the model as an error result, not a failed turn;
// - a text-only answer is accepted as the reply (models often narrate without calling reply);
// - only truncation, refusal, too many errors or too many rounds fail the turn.
import { PlatformError } from "../errors.js";
import type { HistoryItem, ModelProvider, SystemParts, ToolResult, Usage } from "../providers/types.js";
import { toolErrorPayload, type KpTool, type TurnScratch } from "./tools.js";

export interface AgentOptions {
  maxRounds?: number;
  maxToolErrors?: number;
  maxCallsPerRound?: number;
  /**
   * Checked before a reply is accepted. Returns null when fine, or a message for the KP explaining what
   * to fix; the KP then rewrites. Throwing counts as "could not check" and lets the reply through.
   */
  review?: (reply: NonNullable<TurnScratch["reply"]>) => Promise<string | null>;
  /** How many rejected replies before the turn is failed instead of published. */
  maxRejections?: number;
}

export interface AgentTrace {
  rounds: number;
  toolCalls: { name: string; ok: boolean; error?: string }[];
  via: "reply_tool" | "text";
  /** Spoiler review: replies checked, rejected, and checks that could not run. */
  review?: { checked: number; rejected: number; errors: number };
  /** Summed over all model calls of the turn. */
  usage: Required<Pick<Usage, "input" | "output" | "cached">> & { cost: number | null; calls: number };
}

export async function runAgent(
  provider: ModelProvider,
  prompt: { system: string; parts?: SystemParts },
  input: string,
  tools: KpTool[],
  scratch: TurnScratch,
  opts: AgentOptions = {},
): Promise<AgentTrace> {
  const maxRounds = opts.maxRounds ?? 8;
  const maxErrors = opts.maxToolErrors ?? 6;
  const maxCalls = opts.maxCallsPerRound ?? 16;
  const history: HistoryItem[] = [{ role: "user", text: input }];
  const trace: AgentTrace = {
    rounds: 0,
    toolCalls: [],
    via: "reply_tool",
    usage: { input: 0, output: 0, cached: 0, cost: null, calls: 0 },
  };
  let errors = 0;
  const maxRejections = opts.maxRejections ?? 2;
  /** Returns the KP-facing problem, or null when the reply may be published. */
  const check = async (reply: NonNullable<TurnScratch["reply"]>): Promise<string | null> => {
    if (!opts.review) return null;
    trace.review ??= { checked: 0, rejected: 0, errors: 0 };
    trace.review.checked++;
    let problem: string | null;
    try {
      problem = await opts.review(reply);
    } catch {
      trace.review.errors++;
      return null;
    }
    if (!problem) return null;
    trace.review.rejected++;
    if (trace.review.rejected >= maxRejections)
      throw new PlatformError("SPOILER_BLOCKED", "KP 的回复可能提前透露了剧情，已拦截，本轮未发布", 502);
    return problem;
  };
  const rewrite = (problem: string) =>
    `防剧透审核没有通过：${problem}。请用 reply 重写公开回复，去掉这部分内容；不要重复检定或重复记录。`;

  // Failures carry the partial trace so the turn can still be diagnosed.
  try {
    for (let round = 0; round < maxRounds; round++) {
      trace.rounds = round + 1;
      const step = await provider.step({ system: prompt.system, systemParts: prompt.parts, history, tools: tools.map((t) => t.def) });
      const u = step.usage;
      trace.usage.calls++;
      trace.usage.input += u?.input ?? 0;
      trace.usage.output += u?.output ?? 0;
      trace.usage.cached += u?.cached ?? 0;
      if (typeof u?.cost === "number") trace.usage.cost = (trace.usage.cost ?? 0) + u.cost;
      if (step.stop === "max_tokens")
        throw new PlatformError("PROVIDER_INCOMPLETE", "模型输出被截断（max tokens），本轮未发布", 502);
      if (step.stop === "refused")
        throw new PlatformError("PROVIDER_REFUSED", "模型拒绝了本轮请求，本轮未发布", 502);
      history.push({ role: "assistant", native: step.native });

      if (!step.calls.length) {
        if (!step.text) throw new PlatformError("PROVIDER_EMPTY", "模型没有给出任何回复", 502);
        const reply = { text: step.text, whispers: [] };
        const problem = await check(reply);
        if (problem) {
          history.push({ role: "user", text: rewrite(problem) });
          continue;
        }
        scratch.reply = reply;
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

      if (scratch.reply) {
        const problem = await check(scratch.reply);
        if (!problem) return trace;
        // Hand the rejection back as the reply tool's result so the KP can try again.
        scratch.reply = undefined;
        const i = results.findIndex((r) => r.name === "reply" && !r.isError);
        results[i] = { ...results[i], isError: true, content: JSON.stringify({ code: "SPOILER", message: rewrite(problem) }) };
        for (let t = trace.toolCalls.length - 1; t >= 0; t--)
          if (trace.toolCalls[t].name === "reply" && trace.toolCalls[t].ok) {
            trace.toolCalls[t] = { name: "reply", ok: false, error: "SPOILER" };
            break;
          }
      }
      if (errors > maxErrors)
        throw new PlatformError("TOOL_ERRORS", `模型连续给出无效工具参数（${errors} 次），本轮未发布`, 502);
      history.push({ role: "tool", results });
    }
    throw new PlatformError("ROUND_LIMIT", `模型 ${maxRounds} 步内没有给出回复，本轮未发布`, 502);
  } catch (e) {
    if (e instanceof PlatformError) Object.assign(e, { trace });
    throw e;
  }
}
