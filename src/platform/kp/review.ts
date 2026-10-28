// Spoiler review of the KP's public reply before it is published. The auxiliary model compares the
// reply with the KP-only material and says whether it reveals something players have not found yet.
// The check is semantic on purpose: literal matching flags legitimate clue reveals and misses paraphrase.
import type { ModelProvider } from "../providers/types.js";

const SYSTEM = `你是跑团的防剧透审核员。KP 写了一段要发给玩家的回复，你判断它有没有提前透露玩家还不知道的秘密。
判为泄密（leak=true）的情况：回复直接说出、或明确暗示了"KP 秘密"中玩家尚未得知的事实，例如：核心真相、NPC 的隐藏身份或真实动机、尚未发现的线索及其结论、结局条件、威胁时钟会导致的后果、KP 私密笔记里的内容。
不算泄密（leak=false）：
- 玩家本轮通过行动或检定合理获得的信息（见"本轮刚给出的线索"）；
- 已经公开的信息（见"玩家已知"）；
- 氛围描写、模糊的伏笔、NPC 说谎或误导、玩家角色合理的推测；
- 只是提到 NPC 的名字或公开身份。
拿不准时判为不泄密。只输出 JSON：{"leak": true 或 false, "reason": "泄密时用一句话指出哪句话透露了什么，写给 KP 看；不泄密时为空字符串"}`;

export interface ReviewInput {
  /** KP-only material: compiled guide or hand-written brief, plus KP notes. */
  secrets: string;
  /** What players already know (found clues, public state). */
  known: string;
  /** Clues recorded during this turn: allowed to appear in the reply. */
  revealedNow: string[];
  /** The player's action this turn. */
  action: string;
  /** The reply and any whispers, as they would be published. */
  reply: string;
}

export interface ReviewVerdict {
  leak: boolean;
  reason: string;
}

export function parseVerdict(raw: string): ReviewVerdict {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON");
  const v = JSON.parse(raw.slice(start, end + 1));
  if (typeof v.leak !== "boolean") throw new Error("leak is not boolean");
  return { leak: v.leak, reason: typeof v.reason === "string" ? v.reason.slice(0, 300) : "" };
}

export async function reviewReply(provider: ModelProvider, input: ReviewInput): Promise<ReviewVerdict> {
  const prompt = [
    `KP 秘密（玩家不应提前知道）：\n${input.secrets}`,
    `玩家已知：\n${input.known || "（尚无）"}`,
    `本轮刚给出的线索（允许出现）：\n${input.revealedNow.length ? input.revealedNow.map((c) => `- ${c}`).join("\n") : "（无）"}`,
    `玩家本轮行动：\n${input.action}`,
    `待审核的回复：\n${input.reply}`,
  ].join("\n\n");
  return parseVerdict(await provider.complete({ system: SYSTEM, prompt, maxTokens: 2000 }));
}
