import { PlatformError } from "../errors.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import { geminiProvider } from "./gemini.js";
import { openrouterProvider } from "./openrouter.js";
import { demoProvider } from "./demo.js";
import type { Fetcher } from "./http.js";
import { REASONING_EFFORTS, type ModelProvider, type ProviderConfig, type ReasoningEffort } from "./types.js";

export * from "./types.js";

export const PROVIDER_IDS = ["openrouter", "anthropic", "openai", "gemini"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_DEFAULTS: Record<ProviderId, ProviderConfig> = {
  openrouter: {
    model: "anthropic/claude-opus-5.5",
    baseUrl: "https://openrouter.ai/api/v1",
    timeoutMs: 120000,
    // Reasoning tokens count against max_tokens on OpenRouter, so leave room for both.
    maxTokens: 8000,
    reasoningEffort: "medium",
  },
  anthropic: { model: "claude-opus-5-5", baseUrl: "https://api.anthropic.com/v1", timeoutMs: 90000, maxTokens: 4000 },
  openai: { model: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1", timeoutMs: 90000, maxTokens: 4000 },
  gemini: { model: "gemini-4-argon", baseUrl: "https://generativelanguage.googleapis.com/v1beta", timeoutMs: 90000, maxTokens: 4000 },
};

/** Default auxiliary model (summaries, later checks) per provider; missing = use the main model. */
export const AUX_DEFAULTS: Partial<Record<ProviderId, string>> = {
  openrouter: "anthropic/claude-haiku-5.5",
  anthropic: "claude-haiku-5-5",
};

export const isProviderId = (v: unknown): v is ProviderId =>
  typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);

export const isReasoningEffort = (v: unknown): v is ReasoningEffort =>
  typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v);

/** Stored settings win over environment variables, which win over defaults. */
export function resolveProviderConfig(
  id: ProviderId,
  stored: Partial<ProviderConfig> | undefined,
  env: NodeJS.ProcessEnv,
): ProviderConfig {
  const p = id.toUpperCase();
  const d = PROVIDER_DEFAULTS[id];
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const envEffort = env[`${p}_REASONING_EFFORT`];
  return {
    model: stored?.model || env[`${p}_MODEL`] || d.model,
    baseUrl: stored?.baseUrl || env[`${p}_BASE_URL`] || d.baseUrl,
    timeoutMs: stored?.timeoutMs || num(env[`${p}_TIMEOUT_MS`]) || d.timeoutMs,
    maxTokens: stored?.maxTokens || num(env[`${p}_MAX_OUTPUT`]) || d.maxTokens,
    reasoningEffort: stored?.reasoningEffort || (isReasoningEffort(envEffort) ? envEffort : undefined) || d.reasoningEffort,
    apiKey: stored?.apiKey || env[`${p}_API_KEY`] || undefined,
  };
}

export function createProvider(id: string, config: ProviderConfig | undefined, fetcher: Fetcher = fetch): ModelProvider {
  if (id === "demo") return demoProvider();
  if (!isProviderId(id)) throw new PlatformError("INVALID_PROVIDER", `不支持的模型供应商 ${id}`);
  if (!config?.apiKey)
    throw new PlatformError("MISSING_CREDENTIALS", `${id} 未配置 API key；不会自动改用演示模型`, 400);
  switch (id) {
    case "openrouter":
      return openrouterProvider(config, fetcher);
    case "anthropic":
      return anthropicProvider(config, fetcher);
    case "openai":
      return openaiProvider(config, fetcher);
    case "gemini":
      return geminiProvider(config, fetcher);
  }
}
