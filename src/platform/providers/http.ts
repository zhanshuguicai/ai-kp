import { PlatformError } from "../errors.js";

export type Fetcher = typeof fetch;

const RETRY_STATUS = new Set([500, 502, 503, 504]);
export let RETRY_DELAY_MS = 1500;
/** Tests shorten the retry delay. */
export function setRetryDelay(ms: number) {
  RETRY_DELAY_MS = ms;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST JSON with a timeout. Upstream error bodies are not passed through to users (they may echo keys). */
export async function postJson(
  fetcher: Fetcher,
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<any> {
  let response: Response;
  // One retry for brief upstream failures (gateway errors, dropped connections). Model calls have no
  // side effects, so repeating one is safe. Timeouts are not retried: the player has waited long enough.
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as Error)?.name === "TimeoutError" || Date.now() - started >= timeoutMs;
      if (attempt === 0 && !timedOut) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new PlatformError("PROVIDER_NETWORK", `${provider} 请求超时或网络失败`, 502);
    }
    if (attempt === 0 && RETRY_STATUS.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    break;
  }
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? "请检查 API key"
        : response.status === 402
          ? "账户余额不足"
          : response.status === 404
          ? "请检查模型名和接口地址"
          : response.status === 429
            ? "请求过多或额度不足"
            : "上游服务错误";
    throw new PlatformError("PROVIDER_HTTP", `${provider} 返回 HTTP ${response.status}：${hint}`, 502);
  }
  try {
    return await response.json();
  } catch {
    throw new PlatformError("PROVIDER_PROTOCOL", `${provider} 返回了无法解析的响应`, 502);
  }
}

export function parseArgs(provider: string, raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw || "{}");
  } catch {
    // Returned to the model as a tool error by the agent loop, not a hard failure.
    return { __invalidJson: raw.slice(0, 500), __provider: provider };
  }
}
