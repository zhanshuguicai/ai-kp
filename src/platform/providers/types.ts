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

export interface StepResult {
  text: string;
  calls: ToolCall[];
  native: unknown;
  stop: StopReason;
  usage?: { input?: number; output?: number };
}

export interface StepRequest {
  system: string;
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

export interface ProviderConfig {
  model: string;
  apiKey?: string;
  baseUrl: string;
  timeoutMs: number;
  maxTokens: number;
}
