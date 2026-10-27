// Gemini generateContent API. Model turns are sent back verbatim so thought signatures are preserved.
import { randomUUID } from "node:crypto";
import type { ModelProvider, ProviderConfig, StepResult, HistoryItem, StopReason } from "./types.js";
import { postJson, type Fetcher } from "./http.js";
import { PlatformError } from "../errors.js";

function contents(history: HistoryItem[]) {
  return history.map((h) =>
    h.role === "user"
      ? { role: "user", parts: [{ text: h.text }] }
      : h.role === "assistant"
        ? h.native
        : {
            role: "user",
            parts: h.results.map((r) => ({
              functionResponse: {
                ...(r.id.startsWith("gen-") ? {} : { id: r.id }),
                name: r.name,
                response: r.isError ? { error: JSON.parse(r.content) } : { result: JSON.parse(r.content) },
              },
            })),
          },
  );
}

const STOP: Record<string, StopReason> = {
  STOP: "end",
  MAX_TOKENS: "max_tokens",
  SAFETY: "refused",
  RECITATION: "refused",
  PROHIBITED_CONTENT: "refused",
  BLOCKLIST: "refused",
  SPII: "refused",
};

export function geminiProvider(config: ProviderConfig, fetcher: Fetcher = fetch): ModelProvider {
  const call = (body: unknown) =>
    postJson(
      fetcher,
      "gemini",
      `${config.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(config.model)}:generateContent`,
      { "x-goog-api-key": config.apiKey ?? "" },
      body,
      config.timeoutMs,
    );
  const read = (data: any): StepResult => {
    const candidate = data?.candidates?.[0];
    if (!candidate?.content) {
      if (data?.promptFeedback?.blockReason) return { text: "", calls: [], native: null, stop: "refused" };
      throw new PlatformError("PROVIDER_PROTOCOL", "gemini 响应缺少 candidates", 502);
    }
    const parts: any[] = candidate.content.parts ?? [];
    const calls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({ id: String(p.functionCall.id ?? `gen-${randomUUID()}`), name: String(p.functionCall.name), args: p.functionCall.args ?? {} }));
    return {
      text: parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("\n").trim(),
      calls,
      native: { role: "model", parts },
      stop: calls.length ? "tool_use" : (STOP[candidate.finishReason] ?? "other"),
      usage: {
        input: data.usageMetadata?.promptTokenCount,
        output: data.usageMetadata?.candidatesTokenCount,
        cached: data.usageMetadata?.cachedContentTokenCount,
      },
    };
  };
  return {
    id: "gemini",
    model: config.model,
    async step(req) {
      return read(
        await call({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: contents(req.history),
          tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
          generationConfig: { maxOutputTokens: req.maxTokens ?? config.maxTokens },
        }),
      );
    },
    async complete(req) {
      const r = read(
        await call({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts: [{ text: req.prompt }] }],
          generationConfig: { maxOutputTokens: req.maxTokens ?? config.maxTokens },
        }),
      );
      if (r.stop === "max_tokens" || r.stop === "refused")
        throw new PlatformError("PROVIDER_INCOMPLETE", "gemini 输出被截断或拒绝", 502);
      return r.text;
    },
  };
}
