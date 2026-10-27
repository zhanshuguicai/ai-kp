// Structured world state. The KP changes it only through tools; every change is also logged as an event.
import { clipToTokens } from "../context/tokens.js";

export type ThreadStatus = "open" | "done" | "failed";

export interface WorldState {
  scene: { name: string; description: string; sinceTurn: number };
  threads: { title: string; kind: "main" | "side"; status: ThreadStatus }[];
  clues: { id: string; text: string; foundBy: string[]; turn: number }[];
  npcs: Record<string, { status: string; attitude: string; lastSeenTurn: number }>;
  /** Threat clocks; KP only. */
  clocks: Record<string, { filled: number; size: number; note: string }>;
  /** 0 calm … 5 climax, maintained by the KP. */
  tension: number;
  lastClueTurn: number;
  /** Private KP notes; the oldest drop off (they stay in the event log and summaries). */
  kpNotes: string[];
}

export const MAX_KP_NOTES = 60;

export function initialState(): WorldState {
  return {
    scene: { name: "开场", description: "", sinceTurn: 0 },
    threads: [],
    clues: [],
    npcs: {},
    clocks: {},
    tension: 1,
    lastClueTurn: 0,
    kpNotes: [],
  };
}

/** KP view of the state for the context window. */
export function renderState(s: WorldState, budget: number): string {
  const lines = [
    `当前场景：${s.scene.name}（自第 ${s.scene.sinceTurn} 轮）${s.scene.description ? `—— ${s.scene.description}` : ""}`,
    `紧张度：${s.tension}/5`,
    s.threads.length
      ? `剧情线：${s.threads.map((t) => `[${t.kind === "main" ? "主" : "支"}·${t.status === "open" ? "进行中" : t.status === "done" ? "完成" : "失败"}] ${t.title}`).join("；")}`
      : "剧情线：尚未记录",
    s.clues.length ? `已发现线索：\n${s.clues.map((c) => `- ${c.text}（第${c.turn}轮${c.foundBy.length ? `，${c.foundBy.join("、")}` : ""}）`).join("\n")}` : "已发现线索：无",
    Object.keys(s.npcs).length
      ? `NPC：\n${Object.entries(s.npcs).map(([n, v]) => `- ${n}：${v.status}${v.attitude ? `，态度 ${v.attitude}` : ""}`).join("\n")}`
      : "",
    Object.keys(s.clocks).length
      ? `威胁时钟（仅KP）：${Object.entries(s.clocks).map(([n, c]) => `${n} ${c.filled}/${c.size}${c.note ? `（${c.note}）` : ""}`).join("；")}`
      : "",
    s.kpNotes.length ? `KP 私密笔记：\n${s.kpNotes.map((n) => `- ${n}`).join("\n")}` : "",
  ];
  return clipToTokens(lines.filter(Boolean).join("\n"), budget);
}

/** What players may see: no clocks, no KP notes. */
export function publicState(s: WorldState) {
  return {
    scene: { name: s.scene.name, description: s.scene.description },
    threads: s.threads,
    clues: s.clues.map(({ text, foundBy, turn }) => ({ text, foundBy, turn })),
    npcs: Object.fromEntries(Object.entries(s.npcs).map(([n, v]) => [n, { status: v.status, attitude: v.attitude }])),
  };
}
