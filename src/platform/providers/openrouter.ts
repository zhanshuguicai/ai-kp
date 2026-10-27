// Chat Completions API: OpenRouter, and OpenAI-compatible endpoints (OpenAI "chat" mode, relays).
// - The assistant message that made tool calls is sent back with its `reasoning_details` unmodified,
//   which Claude and Gemini need to keep their reasoning across tool steps.
// - For anthropic/* models the system prompt is sent as two cached content blocks (stable + dynamic).
// - Usage, cached tokens and cost come back in every response.
import type { HistoryItem, ModelProvider, ProviderConfig, StepRequest, StepResult, StopReason, Usage } from "./types.js";
import { parseArgs, postJson, type Fetcher } from "./http.js";
import { PlatformError } from "../errors.js";

const CACHE = { type: "ephemeral" } as const;

function systemMessage(req: Pick<StepRequest, "system" | "systemParts">, model: string) {
  if (!req.systemParts) return { role: "system", content: req.system };
  const { stable, dynamic } = req.systemParts;
  // Claude: a breakpoint after each part. Gemini on OpenRouter uses only the last breakpoint, and its
  // implicit cache missed in testing, so mark the stable part (tools + instructions + KP guide) explicitly.
  if (model.startsWith("anthropic/"))
    return { role: "system", content: [stable, dynamic].filter((t) => t.trim()).map((text) => ({ type: "text", text, cache_control: CACHE })) };
  if (model.startsWith("google/"))
    return {
      role: "system",
      content: [{ type: "text", text: stable, cache_control: CACHE }, ...(dynamic.trim() ? [{ type: "text", text: dynamic }] : [])],
    };
  return { role: "system", content: req.system };
}

function messages(history: HistoryItem[]): unknown[] {
  return history.flatMap((h): unknown[] =>
    h.role === "user"
      ? [{ role: "user", content: h.text }]
      : h.role === "assistant"
        ? [h.native]
        : h.results.map((r) => ({
            role: "tool",
            tool_call_id: r.id,
            content: r.isError ? JSON.stringify({ error: JSON.parse(r.content) }) : r.content,
          })),
  );
}

/**
 * Anthropic only: a third cache breakpoint on the newest message, so each tool step of a turn reads
 * the previous steps from cache instead of paying for the whole history again (2 system + 1 here, max 4).
 */
function cacheNewest(msgs: any[], model: string): any[] {
  if (!model.startsWith("anthropic/") || !msgs.length) return msgs;
  const last = msgs[msgs.length - 1];
  if ((last.role !== "tool" && last.role !== "user") || typeof last.content !== "string" || !last.content) return msgs;
  return [...msgs.slice(0, -1), { ...last, content: [{ type: "text", text: last.content, cache_control: CACHE }] }];
}

const STOP: Record<string, StopReason> = {
  tool_calls: "tool_use",
  stop: "end",
  length: "max_tokens",
  content_filter: "refused",
};

function usage(u: any): Usage | undefined {
  if (!u) return undefined;
  return {
    input: u.prompt_tokens,
    output: u.completion_tokens,
    // DeepSeek reports cache hits in its own field.
    cached: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens,
    cost: typeof u.cost === "number" ? u.cost : undefined,
  };
}

export function openrouterProvider(config: ProviderConfig, fetcher: Fetcher = fetch): ModelProvider {
  return chatCompletionsProvider(config, fetcher, "openrouter");
}

/**
 * Plain OpenAI-style Chat Completions. Differences from OpenRouter: no cache breakpoints (OpenAI caches
 * prefixes itself), `reasoning_effort` instead of `reasoning`, and `max_completion_tokens` on api.openai.com
 * (its reasoning models reject `max_tokens`; relays usually expect `max_tokens`).
 */
export function openaiChatProvider(config: ProviderConfig, fetcher: Fetcher = fetch): ModelProvider {
  return chatCompletionsProvider(config, fetcher, "openai");
}

/**
 * DeepSeek (OpenAI-compatible). Thinking is on by default; effort "none" turns it off. With tools, the
 * assistant's `reasoning_content` must be sent back on every later request of the turn (else HTTP 400),
 * which the replayed native message does.
 */
export function deepseekProvider(config: ProviderConfig, fetcher: Fetcher = fetch): ModelProvider {
  return chatCompletionsProvider(config, fetcher, "deepseek");
}

type Flavor = "openrouter" | "openai" | "deepseek";

function reasoningParams(flavor: Flavor, effort: ProviderConfig["reasoningEffort"]): Record<string, unknown> {
  if (!effort) return {};
  if (flavor === "openrouter") return { reasoning: { effort } };
  if (flavor === "deepseek")
    return effort === "none"
      ? { thinking: { type: "disabled" } }
      : { thinking: { type: "enabled" }, reasoning_effort: effort === "minimal" ? "low" : effort === "xhigh" ? "high" : effort };
  return effort === "none" ? {} : { reasoning_effort: effort };
}

function chatCompletionsProvider(config: ProviderConfig, fetcher: Fetcher, flavor: Flavor): ModelProvider {
  const openrouter = flavor === "openrouter";
  const official = /(^|\.)api\.openai\.com$/.test(new URL(config.baseUrl).hostname);
  const limitKey = !openrouter && official ? "max_completion_tokens" : "max_tokens";
  const call = async (body: Record<string, unknown>) => {
    const { max_tokens, ...rest } = body as { max_tokens?: number };
    const data = await postJson(
      fetcher,
      flavor,
      `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      { authorization: `Bearer ${config.apiKey ?? ""}`, ...(openrouter ? { "X-Title": "AI KP" } : {}) },
      {
        model: config.model,
        [limitKey]: max_tokens ?? config.maxTokens,
        ...reasoningParams(flavor, config.reasoningEffort),
        ...rest,
      },
      config.timeoutMs,
    );
    // OpenRouter can answer 200 with an error object (e.g. upstream failure mid-request).
    const err = data?.error ?? data?.choices?.[0]?.error;
    if (err)
      throw new PlatformError(
        "PROVIDER_HTTP",
        `${flavor} 上游错误${err.code ? `（${String(err.code).slice(0, 20)}）` : ""}；请检查模型名、余额或稍后重试`,
        502,
      );
    return data;
  };

  const read = (data: any): StepResult => {
    const choice = data?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new PlatformError("PROVIDER_PROTOCOL", `${flavor} 响应缺少 choices[0].message`, 502);
    const toolCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const text = typeof msg.content === "string" ? msg.content.trim() : "";
    // Rebuild the assistant message to replay: content, tool calls and reasoning exactly as received.
    const native: Record<string, unknown> = { role: "assistant", content: msg.content ?? null };
    if (toolCalls.length) native.tool_calls = toolCalls;
    if (Array.isArray(msg.reasoning_details) && msg.reasoning_details.length) native.reasoning_details = msg.reasoning_details;
    else if (typeof msg.reasoning === "string" && msg.reasoning) native.reasoning = msg.reasoning;
    if (typeof msg.reasoning_content === "string") native.reasoning_content = msg.reasoning_content;
    const calls = toolCalls.map((c) => ({
      id: String(c.id),
      name: String(c.function?.name),
      args: parseArgs(flavor, c.function?.arguments),
    }));
    let stop = STOP[choice.finish_reason] ?? (calls.length ? "tool_use" : "other");
    if (calls.length && stop !== "max_tokens") stop = "tool_use";
    if (msg.refusal) stop = "refused";
    return { text, calls, native, stop, usage: usage(data.usage) };
  };

  return {
    id: flavor,
    model: config.model,
    async step(req) {
      return read(
        await call({
          messages: openrouter
            ? [systemMessage(req, config.model), ...cacheNewest(messages(req.history), config.model)]
            : [{ role: "system", content: req.system }, ...messages(req.history)],
          tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        }),
      );
    },
    async complete(req) {
      const r = read(
        await call({
          messages: [openrouter ? systemMessage({ system: req.system }, config.model) : { role: "system", content: req.system }, { role: "user", content: req.prompt }],
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        }),
      );
      if (r.stop === "max_tokens" || r.stop === "refused")
        throw new PlatformError("PROVIDER_INCOMPLETE", `${flavor} 输出被截断或拒绝`, 502);
      return r.text;
    },
  };
}
