import type { Rng, RollResult, RollTerm } from "./types.js";
import { fail } from "./util.js";

// Supported: NdM, dM, d%, NdF, NdMkhK / NdMklK, integer constants, joined by + / -.
// Case-insensitive, so CoC-style "1D6+1D4" works.
interface ParsedTerm {
  text: string;
  sign: 1 | -1;
  kind: "dice" | "const";
  count: number;
  sides: number | "F";
  keep?: { mode: "kh" | "kl"; n: number };
  value: number;
}

const TERM = /^(\d*)d(\d+|%|f)(?:(kh|kl)(\d+))?$/;

export function parseDice(expression: string): ParsedTerm[] {
  const src = expression.replace(/\s+/g, "").toLowerCase();
  if (!src || src.length > 100) fail("INVALID_DICE", "骰子表达式为空或过长");
  const parts = src.split(/(?=[+-])/);
  if (parts.length > 20) fail("INVALID_DICE", "骰子表达式最多 20 项");
  return parts.map((raw) => {
    const sign: 1 | -1 = raw.startsWith("-") ? -1 : 1;
    const body = raw.replace(/^[+-]/, "");
    if (/^\d+$/.test(body)) {
      const value = Number(body);
      if (value > 100000) fail("INVALID_DICE", "常数过大");
      return { text: raw, sign, kind: "const", count: 0, sides: 0, value };
    }
    const m = TERM.exec(body);
    if (!m) fail("INVALID_DICE", `无法解析 "${raw}"，支持 NdM、d%、NdF、NdMkhK、常数`);
    const count = m[1] ? Number(m[1]) : 1;
    const sides: number | "F" = m[2] === "f" ? "F" : m[2] === "%" ? 100 : Number(m[2]);
    if (count < 1 || count > 100) fail("INVALID_DICE", "骰子数量需 1-100");
    if (sides !== "F" && (sides < 2 || sides > 1000))
      fail("INVALID_DICE", "骰子面数需 2-1000");
    let keep: ParsedTerm["keep"];
    if (m[3]) {
      const n = Number(m[4]);
      if (n < 1 || n > count) fail("INVALID_DICE", "保留数量需在 1 到骰子数之间");
      keep = { mode: m[3] as "kh" | "kl", n };
    }
    return { text: raw, sign, kind: "dice", count, sides, keep, value: 0 };
  });
}

export function rollDice(expression: string, rng: Rng): RollResult {
  const terms: RollTerm[] = parseDice(expression).map((t) => {
    if (t.kind === "const")
      return { text: t.text, sign: t.sign, kind: "const", value: t.value };
    const values = Array.from({ length: t.count }, () =>
      t.sides === "F" ? rng.int(-1, 1) : rng.int(1, t.sides as number),
    );
    let kept: number[] | undefined;
    if (t.keep) {
      const sorted = [...values].sort((a, b) =>
        t.keep!.mode === "kh" ? b - a : a - b,
      );
      kept = sorted.slice(0, t.keep.n);
    }
    const value = (kept ?? values).reduce((a, b) => a + b, 0);
    return {
      text: t.text,
      sign: t.sign,
      kind: "dice",
      count: t.count,
      sides: t.sides,
      values,
      kept,
      value,
    };
  });
  return {
    expression: expression.replace(/\s+/g, ""),
    terms,
    total: terms.reduce((s, t) => s + t.sign * t.value, 0),
  };
}

function bound(expression: string, which: "max" | "min"): number {
  return parseDice(expression).reduce((s, t) => {
    if (t.kind === "const") return s + t.sign * t.value;
    const n = t.keep?.n ?? t.count;
    const hi = t.sides === "F" ? 1 : (t.sides as number);
    const lo = t.sides === "F" ? -1 : 1;
    // For a negative term the maximum comes from the lowest dice.
    const face = (which === "max") === (t.sign === 1) ? hi : lo;
    return s + t.sign * n * face;
  }, 0);
}

export const maxOf = (expression: string) => bound(expression, "max");
export const minOf = (expression: string) => bound(expression, "min");

export function formatRoll(r: RollResult): string {
  const parts = r.terms
    .filter((t) => t.kind === "dice")
    .map((t) => {
      const shown = t.values!.map((v) =>
        t.sides === "F" ? (v > 0 ? "+" : v < 0 ? "-" : "0") : String(v),
      );
      return `[${shown.join(",")}]${t.kept ? `取${t.kept.join(",")}` : ""}`;
    });
  return `${r.expression}=${r.total} ${parts.join(" ")}`.trim();
}
