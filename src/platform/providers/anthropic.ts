// Anthropic Messages API.
import type { ModelProvider, ProviderConfig, StepResult, HistoryItem, StopReason } from "./types.js";
import { postJson, type Fetcher } from "./http.js";
import { PlatformError } from "../errors.js";

function messages(history: HistoryItem[]) {
  return history.map((h) =>
    h.role === "user"
      ? { role: "user", content: h.text }
      : h.role === "assistant"
        ? { role: "assistant", content: h.native }
        : {
            role: "user",
            content: h.results.map((r) => ({
              type: "tool_result",
              tool_use_id: r.id,
              content: r.content,
              ...(r.isError ? { is_error: true } : {}),
            })),
          },
  );
}

const STOP: Record<string, StopReason> = {
  tool_use: "tool_use",
  end_turn: "end",
  stop_sequence: "end",
  max_tokens: "max_tokens",
  refusal: "refused",
};

export function anthropicProvider(config: ProviderConfig, fetcher: Fetcher = fetch): ModelProvider {
  const call = (body: unknown) =>
    postJson(
      fetcher,
      "anthropic",
      `${config.baseUrl.replace(/\/$/, "")}/messages`,
      { "x-api-key": config.apiKey ?? "", "anthropic-version": "2023-06-01" },
      body,
      config.timeoutMs,
    );
  const read = (data: any): StepResult => {
    if (!Array.isArray(data?.content))
      throw new PlatformError("PROVIDER_PROTOCOL", "anthropic 响应缺少 content", 502);
    return {
      text: data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim(),
      calls: data.content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ id: String(b.id), name: String(b.name), args: b.input ?? {} })),
      native: data.content,
      stop: STOP[data.stop_reason] ?? "other",
      usage: {
        input: (data.usage?.input_tokens ?? 0) + (data.usage?.cache_read_input_tokens ?? 0) + (data.usage?.cache_creation_input_tokens ?? 0),
        output: data.usage?.output_tokens,
        cached: data.usage?.cache_read_input_tokens,
      },
    };
  };
  return {
    id: "anthropic",
    model: config.model,
    async step(req) {
      return read(
        await call({
          model: config.model,
          system: req.systemParts
            ? [req.systemParts.stable, req.systemParts.dynamic]
                .filter((t) => t.trim())
                .map((text) => ({ type: "text", text, cache_control: { type: "ephemeral" } }))
            : req.system,
          messages: messages(req.history),
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
          max_tokens: req.maxTokens ?? config.maxTokens,
        }),
      );
    },
    async complete(req) {
      const r = read(
        await call({
          model: config.model,
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
          max_tokens: req.maxTokens ?? config.maxTokens,
        }),
      );
      if (r.stop === "max_tokens" || r.stop === "refused")
        throw new PlatformError("PROVIDER_INCOMPLETE", "anthropic 输出被截断或拒绝", 502);
      return r.text;
    },
  };
}
