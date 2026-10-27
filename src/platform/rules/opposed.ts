// Shared pieces for opposed checks: each side rolls with the system's own check, then the sides are compared.
import type { CheckResult, OpposedResult, OpposedSpec, Outcome, RuleSystem } from "./types.js";

export const sideName = (side: Record<string, unknown>, fallback: string) =>
  (typeof side.label === "string" && side.label.trim()) || (typeof side.actor === "string" && side.actor) || fallback;

/** Turn a side's check into a contest result: no fixed target, outcome = win / lose / tie. */
export function asSide(r: CheckResult, label: string, result: "win" | "lose" | "tie", degree = r.degree): CheckResult & { label: string } {
  const outcome: Outcome = result === "win" ? "success" : result === "lose" ? "failure" : "partial";
  const { target: _t, targetLabel: _l, margin: _m, ...rest } = r;
  return { ...rest, label, outcome, degree };
}

export function diceText(r: CheckResult): string {
  return r.dice.map((d) => `${d.label}[${(d.kept ?? d.values).join(",")}]`).join(" ");
}

export function contestSummary(a: CheckResult & { label: string }, b: CheckResult & { label: string }, winner: OpposedResult["winner"], show: (r: CheckResult) => string) {
  const verdict = winner === "tie" ? "平手" : `${winner === "a" ? a.label : b.label} 胜`;
  return `对抗：${a.label} ${show(a)} vs ${b.label} ${show(b)} → ${verdict}`;
}

/**
 * Contest by comparing totals (d20 systems, FATE, dice pools). `fill` supplies a dummy value for the
 * target parameter the system's check requires; the target is not shown or used.
 */
export function contestByTotal<S>(
  system: () => RuleSystem<S>,
  omit: string[],
  fill: Record<string, unknown>,
  opts: { tieNote: string; show?: (r: CheckResult) => string; extraNotes?: (diff: number) => string[] },
): OpposedSpec<S> {
  return {
    omit,
    resolve(a, b, sheetA, sheetB, rng) {
      const sys = system();
      const ra = sys.resolveCheck({ ...a, ...fill }, sheetA, rng);
      const rb = sys.resolveCheck({ ...b, ...fill }, sheetB, rng);
      const winner = ra.total > rb.total ? "a" : rb.total > ra.total ? "b" : "tie";
      const sa = asSide(ra, sideName(a, "甲方"), winner === "a" ? "win" : winner === "b" ? "lose" : "tie", "");
      const sb = asSide(rb, sideName(b, "乙方"), winner === "b" ? "win" : winner === "a" ? "lose" : "tie", "");
      const show = opts.show ?? ((r: CheckResult) => `${r.stat} ${diceText(r)}=${r.total}`);
      const notes = winner === "tie" ? [opts.tieNote] : (opts.extraNotes?.(Math.abs(ra.total - rb.total)) ?? []);
      return {
        system: sys.id,
        kind: "opposed",
        reason: String(a.reason ?? ""),
        sides: [sa, sb],
        winner,
        summary: contestSummary(sa, sb, winner, show),
        notes,
      };
    },
  };
}
