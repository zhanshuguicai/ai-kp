import type { Decision, GameAction } from "./contracts.js";
import type { PublicContext } from "./providers.js";
import { requireThat, object, str } from "./foundation.js";
export interface Affordance {
  label: string;
  action: GameAction;
  aliases?: string[];
}
/** JSON object property order is not semantic. Reject extra action/payload fields. */
export function sameAction(a: unknown, b: unknown): boolean {
  if (!object(a) || !object(b) || !object(a.payload) || !object(b.payload))
    return false;
  if (
    Object.keys(a).some((k) => k !== "kind" && k !== "payload") ||
    Object.keys(b).some((k) => k !== "kind" && k !== "payload")
  )
    return false;
  const canonical = (p: Record<string, unknown>) =>
    JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));
  return a.kind === b.kind && canonical(a.payload) === canonical(b.payload);
}
export interface DirectorContext extends PublicContext {
  location: string;
  actors: { name: string; hp: number }[];
  events: string[];
  action: string;
  affordances: Affordance[];
  status: string;
  inventory: { id: string; name: string; quantity: number }[];
}
export const decisionSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["dialogue", "action", "clarification", "proposal"],
    },
    message: { type: "string" },
    action: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [
                "check",
                "attack",
                "end_turn",
                "move",
                "interact",
                "rest",
                "retreat",
              ],
            },
            payload: {
              type: "object",
              properties: {
                targetId: { type: ["string", "null"] },
                sceneId: { type: ["string", "null"] },
                skill: { type: ["string", "null"] },
                dc: { type: ["integer", "null"] },
              },
              required: ["targetId", "sceneId", "skill", "dc"],
              additionalProperties: false,
            },
          },
          required: ["kind", "payload"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["type", "message", "action"],
  additionalProperties: false,
};
export function validateDecision(d: unknown): Decision {
  requireThat(
    object(d) &&
      Object.keys(d).length === 3 &&
      ["dialogue", "action", "clarification", "proposal"].includes(d.type) &&
      str(d.message, 2000),
    "PROVIDER_FAILURE",
    "导演返回结构无效",
    502,
  );
  if (d.action !== null) {
    requireThat(
      object(d.action) &&
        Object.keys(d.action).length === 2 &&
        [
          "check",
          "attack",
          "end_turn",
          "move",
          "interact",
          "rest",
          "retreat",
        ].includes(d.action.kind) &&
        object(d.action.payload),
      "PROVIDER_FAILURE",
      "导演动作结构无效",
      502,
    );
    for (const [k, v] of Object.entries(d.action.payload)) {
      requireThat(
        ["targetId", "sceneId", "skill", "dc"].includes(k) &&
          (v === null || (k === "dc" ? Number.isInteger(v) : str(v, 100))),
        "PROVIDER_FAILURE",
        "导演参数无效",
        502,
      );
      if (v === null) delete d.action.payload[k];
    }
  }
  requireThat(
    (d.type === "action" || d.type === "proposal") === (d.action !== null),
    "PROVIDER_FAILURE",
    "导演动作类型不一致",
    502,
  );
  return d as Decision;
}
export function needsClarification(text: string) {
  return /[?？“”「」"『』]|想到过|讨论|昨天|曾经|之前|过去|记得|他说|故事里|提到|假设|也许|可能|如果|假如|要是|是否|能否|可以.*吗|不|没|勿|别|什么|为何|为什么|怎么|吗|么|并且|然后|同时|接着|之后|先.+再|且|或者|还是/.test(
    text,
  );
}
export function localInterpret(c: DirectorContext): Decision {
  const t = c.action.trim().replace(/[。！!]$/, "");
  const answer = (
    type: Decision["type"],
    message: string,
    action: GameAction | null = null,
  ): Decision => ({ type, message, action });
  if (/来这里做什么|任务是什么|有什么人|这里有谁/.test(t))
    return answer(
      "dialogue",
      `${c.opening ?? ""} 当前人物：${c.scene?.npcs.map((n) => `${n.name}：${n.description}`).join("；") || "没有可见人物"}。公开目标：${c.objectives?.map((o) => `${o.text}${o.completed ? "（已完成）" : ""}`).join("、") ?? "等待队伍决定"}。`,
    );
  if (/信使/.test(t) && /线索|为什么|怎么|吗|？|\?/.test(t))
    return answer(
      "dialogue",
      `信使提醒：当前可以${c.affordances.map((a) => a.label).join("、")}。已知记录：${c.events.slice(-3).join(" ")}`,
    );
  if (needsClarification(t))
    return answer(
      "clarification",
      "请明确本次要执行的一个动作；问题、引用、否定或条件表达不会直接执行。",
    );
  const candidates = c.affordances.filter((a) =>
    [a.label, ...(a.aliases ?? [])].some((l) => t.includes(l)),
  );
  if (candidates.length > 1)
    return answer("clarification", "这句话对应多个动作，请每次只选择一个。");
  if (candidates.length === 1) {
    const a = candidates[0];
    return answer(
      /建议|你觉得|帮我选择/.test(t) ? "proposal" : "action",
      `准备执行：${a.label}`,
      a.action,
    );
  }
  if (/^(你好|谢谢|hello|hi|大家好|我叫)/i.test(t))
    return answer("dialogue", "信使向你点头，等待你的决定。");
  if (/状态|背包|目标|怎么办|下一步|帮助|看看四周/.test(t))
    return answer(
      "dialogue",
      `当前位置：${c.location}。可执行：${c.affordances.map((x) => x.label).join("、")}。`,
    );
  return answer(
    "clarification",
    `尚不能确定你的动作。当前可执行：${c.affordances.map((x) => x.label).join("、")}。请明确一个目标。`,
  );
}
