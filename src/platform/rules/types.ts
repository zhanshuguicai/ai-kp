// Rule layer contracts. The model decides *whether* and *what* to check;
// a RuleSystem decides *how* dice are rolled and what the outcome is.

export interface Rng {
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
}

/** Shared outcome scale so the director and KP can reason across systems. */
export type Outcome =
  | "critical_success"
  | "success"
  | "partial"
  | "failure"
  | "critical_failure";

export interface DieGroup {
  label: string;
  sides: number | "F";
  values: number[];
  /** Values that counted, when some were dropped (advantage, bonus dice…). */
  kept?: number[];
}

/** Where the number tested against came from. "declared" = supplied by the model, not a sheet. */
export type ValueSource = "sheet" | "base" | "declared";

export interface SheetEffect {
  actor: string;
  field: string;
  delta: number;
}

export interface CheckResult {
  system: string;
  actor?: string;
  stat: string;
  reason: string;
  dice: DieGroup[];
  /** The number that was compared (roll for roll-under, total for roll-over, net successes for pools). */
  total: number;
  target?: number;
  targetLabel?: string;
  outcome: Outcome;
  /** System-specific degree label, e.g. 困难成功 / 弱命中 / 风格成功. */
  degree: string;
  margin?: number;
  valueSource: ValueSource;
  /** One public line suitable for showing to players. */
  summary: string;
  /** Suggested sheet changes; the state layer decides whether to apply them. */
  effects?: SheetEffect[];
  notes?: string[];
}

export interface OpposedResult {
  system: string;
  kind: "opposed";
  reason: string;
  /** Side a (the one acting) and side b (the one resisting). Each side's outcome is win/lose/tie. */
  sides: [CheckResult & { label: string }, CheckResult & { label: string }];
  winner: "a" | "b" | "tie";
  summary: string;
  notes?: string[];
}

export interface OpposedSpec<S> {
  /** Check parameters that make no sense in a contest (fixed targets, pushes); removed from each side. */
  omit: string[];
  resolve(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    sheetA: S | undefined,
    sheetB: S | undefined,
    rng: Rng,
  ): OpposedResult;
}

export interface RollTerm {
  text: string;
  sign: 1 | -1;
  kind: "dice" | "const";
  count?: number;
  sides?: number | "F";
  values?: number[];
  kept?: number[];
  value: number;
}

export interface RollResult {
  expression: string;
  terms: RollTerm[];
  total: number;
}

/** JSON schema written so it is also valid for OpenAI strict tools (all keys required, nullable optionals). */
export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface RuleToolContext<S> {
  sheetFor(actor: string | null | undefined): S | undefined;
  rng: Rng;
}

export interface RuleTool<S> {
  def: ToolDef;
  execute(args: Record<string, unknown>, ctx: RuleToolContext<S>): unknown;
}

export interface RuleSystem<S = unknown> {
  id: string;
  name: string;
  aliases: string[];
  /** Short line for listings. */
  summary: string;
  /** Validate raw sheet data; throws RuleError with a readable message. */
  parseSheet(data: unknown): S;
  exampleSheet(): S;
  checkParameters: JsonSchema;
  resolveCheck(
    args: Record<string, unknown>,
    sheet: S | undefined,
    rng: Rng,
  ): CheckResult;
  extraTools?: RuleTool<S>[];
  /** Groups of names for the same skill/attribute ("侦查" = "Spot Hidden"), for matching names across tools. */
  statAliases?: string[][];
  /** Contests between two sides (stealth vs listen …). Absent when the system has no opposed rolls. */
  opposed?: OpposedSpec<S>;
  /** Injected into the KP's fixed context (L0). */
  promptGuide(): string;
}
