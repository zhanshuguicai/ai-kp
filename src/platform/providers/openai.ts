// OpenAI Responses API, stateless (store:false). Reasoning items are requested with encrypted
// content so they can be sent back on the next step without server-side storage.
import type { ModelProvider, ProviderConfig, StepResult, HistoryItem } from "./types.js";
import { parseArgs, postJson, type Fetcher } from "./http.js";
import { PlatformError } from "../errors.js";

function input(history: HistoryItem[]) {
  return history.flatMap((h): unknown[] =>
    h.role === "user"
      ? [{ role: "user", content: h.text }]
      : h.role === "assistant"
        ? (h.native as unknown[])
        : h.results.map((r) => ({
            type: "function_call_output",
            call_id: r.id,
            output: r.isError ? JSON.stringify({ error: JSON.parse(r.content) }) : r.content,
          })),
  );
}

export function openaiProvider(config: ProviderConfig, fetcher: Fetcher = fetch): ModelProvider {
  const call = (body: unknown) =>
    postJson(
      fetcher,
      "openai",
      `${config.baseUrl.replace(/\/$/, "")}/responses`,
      { authorization: `Bearer ${config.apiKey ?? ""}` },
      body,
      config.timeoutMs,
    );
  const read = (data: any): StepResult => {
    if (!Array.isArray(data?.output))
      throw new PlatformError("PROVIDER_PROTOCOL", "openai 响应缺少 output", 502);
    const text = data.output
      .filter((o: any) => o.type === "message")
      .flatMap((o: any) => o.content ?? [])
      .filter((c: any) => c.type === "output_text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    const refused = data.output.some((o: any) => o.type === "message" && o.content?.some((c: any) => c.type === "refusal"));
    const calls = data.output
      .filter((o: any) => o.type === "function_call")
      .map((o: any) => ({ id: String(o.call_id), name: String(o.name), args: parseArgs("openai", o.arguments) }));
    return {
      text,
      calls,
      native: data.output,
      stop: refused
        ? "refused"
        : data.status === "incomplete"
          ? "max_tokens"
          : calls.length
            ? "tool_use"
            : data.status === "completed"
              ? "end"
              : "other",
      usage: { input: data.usage?.input_tokens, output: data.usage?.output_tokens },
    };
  };
  const base = {
    model: config.model,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  return {
    id: "openai",
    model: config.model,
    async step(req) {
      return read(
        await call({
          ...base,
          instructions: req.system,
          input: input(req.history),
          tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true })),
          max_output_tokens: req.maxTokens ?? config.maxTokens,
        }),
      );
    },
    async complete(req) {
      const r = read(
        await call({ ...base, instructions: req.system, input: [{ role: "user", content: req.prompt }], max_output_tokens: req.maxTokens ?? config.maxTokens }),
      );
      if (r.stop === "max_tokens" || r.stop === "refused")
        throw new PlatformError("PROVIDER_INCOMPLETE", "openai 输出被截断或拒绝", 502);
      return r.text;
    },
  };
}
