// Rough token estimate without a tokenizer: CJK characters ≈ 1 token each, other text ≈ 3.5 chars per token.
// Budgets use this conservatively; exact counts are not needed to keep context bounded.
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[　-鿿豈-﫿＀-￯]/.test(ch)) cjk++;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

/** Cut text to roughly `budget` tokens, marking the cut. */
export function clipToTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget - 4) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…（已截断）";
}
