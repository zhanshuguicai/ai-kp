import type { JsonSchema } from "./types.js";

/** Rule errors are meant to be sent back to the model as a tool error so it can correct itself. */
export class RuleError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuleError";
  }
}

export function fail(code: string, message: string): never {
  throw new RuleError(code, message);
}

export const norm = (s: string) =>
  s.trim().toLowerCase().replace(/[\s_\-·.()（）]/g, "");

/**
 * Find `name` in `table`, also trying every synonym from the alias group that contains it.
 * Groups are symmetric: a sheet may use "Spot Hidden" while the model asks for "侦查".
 */
export function lookup<T>(
  table: Record<string, T> | undefined,
  name: string,
  groups: string[][] = [],
): { key: string; value: T } | undefined {
  if (!table) return undefined;
  const index = new Map<string, string>();
  for (const k of Object.keys(table)) index.set(norm(k), k);
  for (const candidate of synonyms(name, groups)) {
    const key = index.get(norm(candidate));
    if (key !== undefined) return { key, value: table[key] };
  }
  return undefined;
}

export function synonyms(name: string, groups: string[][]): string[] {
  const n = norm(name);
  const group = groups.find((g) => g.some((x) => norm(x) === n));
  return group ? [name, ...group] : [name];
}

/** Resolve a name to the canonical (first) entry of its alias group. */
export function canonical(name: string, groups: string[][]): string | undefined {
  const n = norm(name);
  return groups.find((g) => g.some((x) => norm(x) === n))?.[0];
}

export const opt = <T>(v: T | null | undefined): T | undefined =>
  v === null ? undefined : v;

export function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    fail("INVALID_ARGS", `${field} 需要 1-${max} 字符的文本`);
  return v.trim();
}

export function optInt(
  v: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max)
    fail("INVALID_ARGS", `${field} 需要 ${min} 到 ${max} 的整数`);
  return v as number;
}

export function reqInt(
  v: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const n = optInt(v, field, min, max);
  if (n === undefined) fail("INVALID_ARGS", `必须提供 ${field}（掷骰前先定难度）`);
  return n;
}

export function optEnum<T extends string>(
  v: unknown,
  field: string,
  values: readonly T[],
): T | undefined {
  if (v === null || v === undefined) return undefined;
  if (!values.includes(v as T))
    fail("INVALID_ARGS", `${field} 只能是 ${values.join(" / ")}`);
  return v as T;
}

export function optBool(v: unknown, field: string): boolean | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "boolean") fail("INVALID_ARGS", `${field} 需要 true/false`);
  return v;
}

export function record(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    fail("INVALID_SHEET", `${field} 需要对象`);
  return v as Record<string, unknown>;
}

export function numberMap(
  v: unknown,
  field: string,
  min: number,
  max: number,
): Record<string, number> {
  if (v === undefined) return {};
  const r = record(v, field);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(r)) {
    if (!Number.isInteger(n) || (n as number) < min || (n as number) > max)
      fail("INVALID_SHEET", `${field}.${k} 需要 ${min} 到 ${max} 的整数`);
    out[k] = n as number;
  }
  return out;
}

// ---- JSON schema helpers (OpenAI-strict compatible) ----
export const sch = {
  str: (description: string) => ({ type: "string", description }),
  nstr: (description: string) => ({ type: ["string", "null"], description }),
  int: (description: string) => ({ type: "integer", description }),
  nint: (description: string) => ({ type: ["integer", "null"], description }),
  nnum: (description: string) => ({ type: ["number", "null"], description }),
  nbool: (description: string) => ({ type: ["boolean", "null"], description }),
  nenum: (values: string[], description: string) => ({
    type: ["string", "null"],
    enum: [...values, null],
    description,
  }),
};

export function objectSchema(properties: Record<string, unknown>): JsonSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export function baseCheckProps(opts: {
  stat: string;
  value: string;
  bonus?: string;
}) {
  return {
    actor: sch.nstr("进行检定的玩家 id；NPC 或无角色卡时为 null"),
    stat: sch.str(opts.stat),
    reason: sch.str("可公开的检定原因"),
    ...(opts.bonus ? { bonus: sch.nint(opts.bonus) } : {}),
    value: sch.nnum(opts.value),
  };
}
