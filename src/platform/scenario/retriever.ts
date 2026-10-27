// BM25 retrieval over scenario chunks. Chinese text is indexed as character bigrams,
// so no word-segmentation dictionary is needed; Latin text is indexed by word.
import type { ScenarioChunk } from "../storage/store.js";
import { estimateTokens } from "../context/tokens.js";

const CJK = /[㐀-鿿豈-﫿]/;

export function terms(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const run of lower.match(/[㐀-鿿豈-﫿]+|[a-z0-9]+/g) ?? []) {
    if (CJK.test(run[0])) {
      if (run.length === 1) out.push(run);
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    } else if (run.length > 1 || /\d/.test(run)) out.push(run);
  }
  return out;
}

interface Doc {
  chunk: ScenarioChunk;
  tf: Map<string, number>;
  length: number;
}

export class ScenarioIndex {
  private docs: Doc[];
  private df = new Map<string, number>();
  private avgLength: number;

  constructor(chunks: ScenarioChunk[]) {
    this.docs = chunks.map((chunk) => {
      const tf = new Map<string, number>();
      // Headings count double: they name scenes, NPCs and places.
      const all = [...terms(chunk.heading), ...terms(chunk.heading), ...terms(chunk.text)];
      for (const t of all) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { chunk, tf, length: all.length };
    });
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLength = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
  }

  byIdx(idx: number): ScenarioChunk | undefined {
    return this.docs.find((d) => d.chunk.idx === idx)?.chunk;
  }

  get size() {
    return this.docs.length;
  }

  search(query: string, limit = 8): { chunk: ScenarioChunk; score: number }[] {
    const q = new Map<string, number>();
    for (const t of terms(query)) q.set(t, (q.get(t) ?? 0) + 1);
    if (!q.size) return [];
    const n = this.docs.length;
    const k1 = 1.2;
    const b = 0.75;
    return this.docs
      .map((d) => {
        let score = 0;
        for (const [t, qf] of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          const df = this.df.get(t)!;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          score += qf * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / this.avgLength)));
        }
        return { chunk: d.chunk, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Best chunks that fit in a token budget, returned in scenario order for readability. */
  select(query: string, budget: number, always: number[] = []): ScenarioChunk[] {
    const picked = new Map<number, ScenarioChunk>();
    let used = 0;
    const take = (c: ScenarioChunk) => {
      if (picked.has(c.idx)) return;
      const cost = estimateTokens(c.heading + c.text) + 8;
      if (used + cost > budget) return;
      picked.set(c.idx, c);
      used += cost;
    };
    for (const idx of always) {
      const d = this.docs.find((x) => x.chunk.idx === idx);
      if (d) take(d.chunk);
    }
    for (const r of this.search(query, 30)) take(r.chunk);
    return [...picked.values()].sort((a, b) => a.idx - b.idx);
  }
}
