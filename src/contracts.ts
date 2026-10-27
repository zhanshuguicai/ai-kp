export type ProviderId = "mock" | "openai" | "anthropic" | "gemini";
export interface Actor {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  ac: number;
  bonus: number;
  stamina: number;
}
export interface GameEvent {
  id: string;
  version: number;
  type: string;
  text: string;
  audience: "public" | "owner" | string;
}
export interface SessionView {
  id: string;
  name: string;
  version: number;
  provider: ProviderId;
  paused: boolean;
  mode: "exploration" | "combat";
  location: string;
  sceneId: string;
  scenes: Pick<Scene, "id" | "name" | "description" | "links" | "npcs">[];
  actors: Actor[];
  enemies: Actor[];
  turnActorId: string | null;
  events: GameEvent[];
  personal: string[];
  role: "owner" | "player";
  actorId: string | null;
  rule: { id: string; version: string };
  scenario: { id: string; version: string };
  status: "active" | "won" | "lost";
  inventory: { id: string; name: string; quantity: number }[];
  objectives: { id: string; text: string; completed: boolean }[];
  interactions: { id: string; label: string; description: string }[];
  ending: { id: string; title: string; text: string } | null;
  pending: PendingProposal | null;
  director: "local-demo" | "provider";
}
export interface ActionRequest {
  requestId: string;
  expectedVersion: number;
  kind:
    | "say"
    | "check"
    | "attack"
    | "end_turn"
    | "move"
    | "interact"
    | "rest"
    | "retreat"
    | "confirm"
    | "cancel";
  payload: {
    text?: string;
    skill?: string;
    dc?: number;
    targetId?: string;
    sceneId?: string;
    proposalId?: string;
  };
}
export interface ControlRequest {
  requestId: string;
  expectedVersion: number;
  command: "pause" | "resume" | "start_combat";
}
export interface CreateRequest {
  name: string;
  ruleId?: string;
  scenarioId?: string;
  scenarioVersion?: string;
  ruleVersion?: string;
  provider?: ProviderId;
}
export interface JoinRequest {
  inviteCode: string;
  name: string;
}
export interface ApiError {
  error: { code: string; message: string };
}
export interface RulePackage {
  kind: "rules";
  id: string;
  version: string;
  name: string;
  description: string;
  engine: "simple-d20-v1";
  parameters: {
    defaultDc: number;
    maxStamina: number;
    damageSides: number;
    damageBonus: number;
  };
  supported: string[];
  unsupported: string[];
}
export interface Scene {
  id: string;
  name: string;
  description: string;
  links: string[];
  npcs: { name: string; description: string }[];
  entryCondition: { type: "always" };
  revealCondition: { type: "planned"; description: string } | null;
}
export interface ScenarioPackage {
  kind: "scenario";
  id: string;
  version: string;
  name: string;
  description: string;
  startLocation: string;
  startSceneId: string;
  scenes: Scene[];
  opening: string;
  secrets: string[];
  personalSecrets: string[];
  story?: StoryDefinition;
}
export type GamePackage = RulePackage | ScenarioPackage;

export type GameAction = {
  kind:
    "check" | "attack" | "end_turn" | "move" | "interact" | "rest" | "retreat";
  payload: ActionRequest["payload"];
};
export interface Decision {
  type: "dialogue" | "action" | "clarification" | "proposal";
  message: string;
  action: GameAction | null;
}
export interface PendingProposal {
  id: string;
  actorId: string;
  version: number;
  action: GameAction;
  message: string;
}
export type Condition =
  | { type: "scene"; id: string }
  | { type: "target"; id: string }
  | { type: "action"; kind: GameAction["kind"] }
  | { type: "flag"; id: string; value: boolean }
  | { type: "item"; id: string; quantity: number }
  | { type: "check"; success: boolean }
  | { type: "enemy"; id: string; defeated: boolean }
  | { type: "status"; value: "active" | "won" | "lost" };
export type Effect =
  | { type: "flag"; id: string; value: boolean }
  | { type: "item"; id: string; quantity: number }
  | { type: "reveal"; text: string; audience: "public" | "actor" }
  | { type: "path"; from: string; to: string }
  | { type: "objective"; id: string }
  | { type: "encounter"; id: string }
  | { type: "end_encounter" }
  | { type: "ending"; id: string };
export interface Interaction {
  id: string;
  sceneId: string;
  label: string;
  description: string;
  aliases: string[];
  conditions: Condition[];
  check: null | { dc: number; cost: number };
  effects: Effect[];
  failureEffects: Effect[];
}
export interface StoryDefinition {
  flags: string[];
  items: { id: string; name: string }[];
  objectives: { id: string; text: string }[];
  endings: {
    id: string;
    title: string;
    text: string;
    status: "won" | "lost";
  }[];
  encounters: Actor[];
  initialPaths: { from: string; to: string }[];
  interactions: Interaction[];
  triggers: {
    id: string;
    once: boolean;
    conditions: Condition[];
    effects: Effect[];
  }[];
}
export interface StoryState {
  flags: Record<string, boolean>;
  inventory: Record<string, number>;
  completed: string[];
  fired: string[];
  paths: { from: string; to: string }[];
  discovered: string[];
  status: "active" | "won" | "lost";
  endingId: string | null;
  pending: PendingProposal | null;
}
