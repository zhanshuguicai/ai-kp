// Rule-based pacing director. It reads simple signals and gives the KP suggestions for this turn.
// The KP may ignore them; the point is to stop scenes from stalling or players from being left out.
import type { Outcome } from "../rules/types.js";
import type { CampaignSettings } from "../storage/store.js";
import type { WorldState } from "../kp/state.js";

export type DirectiveKind = "hint" | "escalate" | "breathe" | "spotlight" | "wrap_up";

export interface Directive {
  kind: DirectiveKind;
  strength: 1 | 2 | 3;
  target?: string;
  reason: string;
}

export interface DirectorInput {
  turn: number;
  state: WorldState;
  players: { id: string; name: string }[];
  /** Last turn number each player spoke in (missing = never). */
  lastSpoke: Record<string, number>;
  /** Outcomes of recent checks, oldest first. */
  recentOutcomes: Outcome[];
  settings: CampaignSettings["director"];
  /** Compiled clues not found yet, most relevant first. Named in hint directives (KP-only). */
  pendingClues?: { id: string; text: string; sources: string[] }[];
}

const clamp = (n: number) => Math.max(1, Math.min(3, n)) as 1 | 2 | 3;

export function direct(input: DirectorInput): Directive[] {
  const { turn, state, settings } = input;
  const out: Directive[] = [];
  const sceneTurns = turn - state.scene.sinceTurn;

  const drought = turn - state.lastClueTurn;
  if (turn > settings.clueDrought && drought >= settings.clueDrought)
    out.push({
      kind: "hint",
      strength: clamp(1 + Math.floor((drought - settings.clueDrought) / 2)),
      reason:
        `已有 ${drought} 轮没有新线索：换一条途径给出线索（NPC 主动接触、环境细节、检定成功的额外信息），不要让玩家原地打转` +
        (input.pendingClues?.length
          ? `。尚未发现：${input.pendingClues
              .slice(0, 3)
              .map((c) => `${c.id}「${c.text.slice(0, 40)}」${c.sources.length ? `（${c.sources.slice(0, 2).join(" / ")}）` : ""}`)
              .join("；")}`
          : ""),
    });

  let streak = 0;
  for (let i = input.recentOutcomes.length - 1; i >= 0; i--) {
    const o = input.recentOutcomes[i];
    if (o === "failure" || o === "critical_failure") streak++;
    else break;
  }
  if (streak >= settings.failStreak)
    out.push({
      kind: "breathe",
      strength: clamp(streak - settings.failStreak + 1),
      reason: `连续 ${streak} 次检定失败：失败要推动局势，同时给出一个可行的突破口，避免挫败感`,
    });

  for (const [name, c] of Object.entries(state.clocks)) {
    if (c.filled >= c.size)
      out.push({ kind: "escalate", strength: 3, target: name, reason: `威胁时钟「${name}」已满：本轮兑现它${c.note ? `（${c.note}）` : ""}` });
    else if (c.filled >= c.size - 1)
      out.push({ kind: "escalate", strength: 2, target: name, reason: `威胁时钟「${name}」只差一格：让玩家感受到逼近的压力` });
  }

  if (sceneTurns >= settings.sceneLength)
    out.push(
      state.tension <= 2
        ? { kind: "escalate", strength: clamp(1 + Math.floor((sceneTurns - settings.sceneLength) / 3)), reason: `当前场景已持续 ${sceneTurns} 轮且气氛平淡：引入压力事件或新的变化` }
        : { kind: "wrap_up", strength: 1, reason: `当前场景已持续 ${sceneTurns} 轮：准备收束这个场景，引向下一个地点或事件` },
    );
  else if (state.tension >= 4 && sceneTurns >= 3 && streak < settings.failStreak)
    out.push({ kind: "breathe", strength: 1, reason: "紧张度持续偏高：适当给一段喘息、整理线索或角色互动的空间" });

  if (input.players.length > 1)
    for (const p of input.players) {
      const silent = turn - (input.lastSpoke[p.id] ?? 0);
      if (silent >= settings.quietTurns)
        out.push({ kind: "spotlight", strength: 1, target: p.id, reason: `${p.name} 已 ${silent} 轮没有行动：给 TA 的角色一个钩子或直接询问 TA 的打算` });
    }

  const main = state.threads.filter((t) => t.kind === "main");
  if (main.length && main.every((t) => t.status !== "open"))
    out.push({ kind: "wrap_up", strength: 2, reason: "主线已全部结束：引导走向结局与尾声" });

  return out;
}

const LABEL: Record<DirectiveKind, string> = {
  hint: "给线索",
  escalate: "加压",
  breathe: "喘息",
  spotlight: "聚光",
  wrap_up: "收束",
};

export function renderDirectives(ds: Directive[]): string {
  if (!ds.length) return "节奏正常，按剧情自然推进。";
  return ds.map((d) => `- [${LABEL[d.kind]}·${"!".repeat(d.strength)}] ${d.reason}`).join("\n");
}
