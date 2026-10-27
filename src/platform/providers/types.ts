import type { ToolDef } from "../rules/types.js";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  id: string;
  name: string;
  /** JSON text returned to the model. */
  content: string;
  isError: boolean;
}

/** Provider-neutral conversation. Assistant turns keep the provider's native payload untouched
 *  (thinking blocks, signatures, reasoning items) so multi-step tool use continues correctly. */
export type HistoryItem =
  | { role: "user"; text: string }
  | { role: "assistant"; native: unknown }
  | { role: "tool"; results: ToolResult[] };

export type StopReason = "tool_use" | "end" | "max_tokens" | "refused" | "other";

export interface Usage {
  input?: number;
  output?: number;
  /** Prompt tokens served from cache. */
  cached?: number;
  /** Cost in USD when the provider reports it (OpenRouter). */
  cost?: number;
}

export interface StepResult {
  text: string;
  calls: ToolCall[];
  native: unknown;
  stop: StopReason;
  usage?: Usage;
}

/** System prompt split for prompt caching: `stable` rarely changes between turns, `dynamic` does. */
export interface SystemParts {
  stable: string;
  dynamic: string;
}

export interface StepRequest {
  /** Full system prompt (stable + dynamic). */
  system: string;
  /** Same text split for caching; providers that cannot cache ignore it. */
  systemParts?: SystemParts;
  history: HistoryItem[];
  tools: ToolDef[];
  maxTokens?: number;
}

export interface ModelProvider {
  id: string;
  model: string;
  /** One model call: may return text, tool calls, or both. */
  step(req: StepRequest): Promise<StepResult>;
  /** Plain text completion without tools (used for summaries). */
  complete(req: { system: string; prompt: string; maxTokens?: number }): Promise<string>;
}

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ProviderConfig {
  model: string;
  apiKey?: string;
  baseUrl: string;
  timeoutMs: number;
  maxTokens: number;
  /** Used by OpenRouter's unified `reasoning` parameter. */
  reasoningEffort?: ReasoningEffort;
}
