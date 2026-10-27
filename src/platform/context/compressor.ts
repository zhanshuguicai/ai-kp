// Automatic context compression. Runs after a turn, in the background.
// Level 1: when unsummarized recent events exceed ~75% of the recent budget, the oldest whole turns
//          are summarized (public version + KP version).
// Level 2: when level-1 summaries exceed ~80% of the summary budget, older ones fold into one chapter.
// The raw event log is never changed, so summaries can always be rebuilt.
import type { ModelProvider } from "../providers/types.js";
import type { Campaign, GameEvent, Store, Summary } from "../storage/store.js";
import type { WorldState } from "../kp/state.js";
import { formatEvents } from "./assembler.js";
import { estimateTokens } from "./tokens.js";
import { PlatformError } from "../errors.js";

const SYSTEM = `你是跑团记录员。把给定的游戏记录压缩成摘要，输出 JSON：{"public": "...", "kp": "..."}。
- public：玩家视角，只写玩家已经知道的事。不得包含标记为「暗」「KP」「KP笔记」「时钟」的内容，也不得推测未公开的秘密。
- kp：KP 视角，可以包含全部信息，特别保留：未兑现的伏笔、NPC 的隐藏动机、玩家做出的承诺与关键选择、角色状态变化。
- 两者都按时间顺序，保留人名、地名、物品与线索原文中的专有名词。只输出 JSON。`;

export function parseSummary(raw: string): { public: string; kp: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(raw.slice(start, end + 1));
      if (typeof v.public === "string" && typeof v.kp === "string" && v.kp.trim())
        return { public: v.public.trim(), kp: v.kp.trim() };
    } catch {}
  }
  throw new PlatformError("SUMMARY_FORMAT", "摘要模型没有返回有效 JSON", 502);
}

/** Split events into whole turns, keeping order. Events without a turn attach to the previous group. */
function byTurn(events: GameEvent[]): GameEvent[][] {
  const groups: GameEvent[][] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && (e.turnId === null || last[0].turnId === e.turnId)) last.push(e);
    else groups.push([e]);
  }
  return groups;
}

export interface CompressResult {
  level1?: Summary;
  level2?: Summary;
}

export async function compress(
  store: Store,
  campaign: Campaign,
  provider: ModelProvider,
  opts: { force?: boolean } = {},
): Promise<CompressResult> {
  const names = new Map(store.characters(campaign.id).map((c) => [c.playerId, c.name]));
  const { state } = store.getState<WorldState>(campaign.id);
  const clues = state.clues.map((c) => c.text);
  const result: CompressResult = {};

  // ---- level 1 ----
  const through = store.summarizedThrough(campaign.id);
  const pending = store.events(campaign.id, { afterSeq: through }).filter((e) => e.type !== "directive");
  const pendingTokens = estimateTokens(formatEvents(pending, names).join("\n"));
  const groups = byTurn(pending);
  if ((opts.force || pendingTokens > campaign.settings.budgets.recent * 0.75) && groups.length >= 2) {
    // Summarize the oldest turns making up about half the pending text; always keep the newest turn verbatim.
    const take: GameEvent[] = [];
    let used = 0;
    for (const g of groups.slice(0, -1)) {
      if (take.length && used >= pendingTokens / 2) break;
      take.push(...g);
      used += estimateTokens(formatEvents(g, names).join("\n"));
    }
    const prompt = [
      clues.length ? `已发现线索（摘要中必须保留）：\n${clues.map((c) => `- ${c}`).join("\n")}` : "",
      `游戏记录：\n${formatEvents(take, names).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const s = parseSummary(await provider.complete({ system: SYSTEM, prompt, maxTokens: 1500 }));
    result.level1 = store.addSummary({
      campaignId: campaign.id,
      level: 1,
      fromSeq: take[0].seq,
      toSeq: take[take.length - 1].seq,
      publicText: s.public,
      kpText: s.kp,
    });
  }

  // ---- level 2 ----
  const active = store.activeSummaries(campaign.id);
  const level1 = active.filter((s) => s.level === 1);
  const summaryTokens = active.reduce((n, s) => n + estimateTokens(s.kpText), 0);
  if (level1.length >= 3 && summaryTokens > campaign.settings.budgets.summaries * 0.8) {
    // Fold everything except the newest level-1 summary into one chapter.
    const fold = active.slice(0, -1);
    const prompt = `把以下按时间排列的摘要合并为一段章节摘要，删去已不重要的细节，保留仍影响后续剧情的信息。\n\n${fold
      .map((s, i) => `#${i + 1}\n公开版：${s.publicText}\nKP 版：${s.kpText}`)
      .join("\n\n")}`;
    const s = parseSummary(await provider.complete({ system: SYSTEM, prompt, maxTokens: 2000 }));
    result.level2 = store.addSummary(
      {
        campaignId: campaign.id,
        level: 2,
        fromSeq: fold[0].fromSeq,
        toSeq: fold[fold.length - 1].toSeq,
        publicText: s.public,
        kpText: s.kp,
      },
      fold.map((x) => x.id),
    );
  }
  return result;
}
