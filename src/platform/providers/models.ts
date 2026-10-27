// Model lists for the settings page. Only ids, names and a few numbers are returned to the browser.
import { getJson, type Fetcher } from "./http.js";
import type { ProviderConfig } from "./types.js";
import type { ProviderId } from "./index.js";

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  /** USD per million tokens, when the provider publishes it (OpenRouter). */
  price?: { input: number; output: number };
}

const LIST_TIMEOUT_MS = 20000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v && Number.isFinite(Number(v)) ? Number(v) : undefined);
const perMillion = (v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n * 1e6 * 1000) / 1000;
};

/**
 * Models usable by the KP. OpenRouter lists only models that support tool calling;
 * Gemini lists only models that can generateContent. Sorted by id.
 */
export async function listModels(id: ProviderId, config: ProviderConfig, fetcher: Fetcher = fetch): Promise<ModelInfo[]> {
  const base = config.baseUrl.replace(/\/$/, "");
  const key = config.apiKey ?? "";
  let out: ModelInfo[] = [];
  switch (id) {
    case "openrouter": {
      const j = await getJson(fetcher, id, `${base}/models`, key ? { authorization: `Bearer ${key}` } : {}, LIST_TIMEOUT_MS);
      out = (Array.isArray(j?.data) ? j.data : [])
        .filter((m: any) => typeof m?.id === "string" && (!Array.isArray(m.supported_parameters) || m.supported_parameters.includes("tools")))
        .filter((m: any) => !m.id.endsWith(":batch"))
        .map((m: any) => {
          const input = perMillion(m.pricing?.prompt);
          const output = perMillion(m.pricing?.completion);
          return {
            id: m.id,
            name: typeof m.name === "string" ? m.name.slice(0, 120) : undefined,
            contextLength: num(m.context_length),
            ...(input !== undefined && output !== undefined ? { price: { input, output } } : {}),
          };
        });
      break;
    }
    case "openai":
    case "deepseek": {
      const j = await getJson(fetcher, id, `${base}/models`, { authorization: `Bearer ${key}` }, LIST_TIMEOUT_MS);
      out = (Array.isArray(j?.data) ? j.data : []).filter((m: any) => typeof m?.id === "string").map((m: any) => ({ id: m.id }));
      break;
    }
    case "anthropic": {
      const j = await getJson(fetcher, id, `${base}/models?limit=1000`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, LIST_TIMEOUT_MS);
      out = (Array.isArray(j?.data) ? j.data : [])
        .filter((m: any) => typeof m?.id === "string")
        .map((m: any) => ({ id: m.id, name: typeof m.display_name === "string" ? m.display_name.slice(0, 120) : undefined }));
      break;
    }
    case "gemini": {
      const j = await getJson(fetcher, id, `${base}/models?pageSize=1000`, { "x-goog-api-key": key }, LIST_TIMEOUT_MS);
      out = (Array.isArray(j?.models) ? j.models : [])
        .filter((m: any) => typeof m?.name === "string" && (!Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes("generateContent")))
        .map((m: any) => ({
          id: m.name.replace(/^models\//, ""),
          name: typeof m.displayName === "string" ? m.displayName.slice(0, 120) : undefined,
          contextLength: num(m.inputTokenLimit),
        }));
      break;
    }
  }
  const seen = new Set<string>();
  return out
    .filter((m) => m.id.length <= 200 && !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
