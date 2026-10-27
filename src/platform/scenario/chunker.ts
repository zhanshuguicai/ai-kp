// Split a raw scenario into retrievable chunks that keep their heading path.
import type { ScenarioChunk } from "../storage/store.js";

// Heading styles with a nesting level. Markdown uses 1-6; Chinese styles nest below them:
// 第X章/部/篇 (7) > 第X节/幕/场/回 (8) > 【标题】, 一、标题, 场景：xx (9).
const HEADING: [RegExp, number][] = [
  [/^第[一二三四五六七八九十百零〇\d]+[章部篇卷]/, 7],
  [/^第[一二三四五六七八九十百零〇\d]+[节幕场回]/, 8],
  [/^【[^】]{1,40}】\s*$/, 9],
  [/^[一二三四五六七八九十]+[、.．]\s*\S.{0,40}$/, 9],
  [/^(场景|地点|NPC|人物|线索|附录|背景|结局|真相|开场|序章|尾声)[\s:：].{0,40}$/i, 9],
];

/** Heading level of a line, or 0 if it is not a heading. */
export function headingLevel(line: string): number {
  const t = line.trim();
  if (!t || t.length > 60) return 0;
  const md = /^(#{1,6})\s+\S/.exec(t);
  if (md) return md[1].length;
  return HEADING.find(([r]) => r.test(t))?.[1] ?? 0;
}

export const isHeading = (line: string) => headingLevel(line) > 0;

const cleanHeading = (line: string) => line.trim().replace(/^#{1,6}\s+/, "");

/** Split a long paragraph at sentence ends so no piece exceeds `max` characters. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^。！？!?.\n]+[。！？!?.]*|\n/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) {
      out.push(cur);
      cur = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
    } else cur += s;
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkScenario(
  raw: string,
  opts: { target?: number; max?: number } = {},
): Omit<ScenarioChunk, "scenarioId">[] {
  const target = opts.target ?? 900;
  const max = opts.max ?? 1400;
  const text = raw.replace(/\r\n?/g, "\n");
  const chunks: Omit<ScenarioChunk, "scenarioId">[] = [];
  const path: { level: number; title: string }[] = [];
  let buf = "";
  let bufStart = 0;

  const heading = () => path.map((p) => p.title).join(" / ");
  const flush = () => {
    const body = buf.trim();
    if (body) chunks.push({ idx: chunks.length, heading: heading(), text: body, start: bufStart });
    buf = "";
  };
  const addParagraph = (para: string, start: number) => {
    for (const piece of splitLong(para, max)) {
      if (buf && buf.length + piece.length > target) flush();
      if (!buf) bufStart = start;
      buf += (buf ? "\n" : "") + piece;
    }
  };

  // Scan line by line: a heading line starts a new chunk, a blank line ends a paragraph.
  let pos = 0;
  let para: string[] = [];
  let paraStart = 0;
  const endParagraph = () => {
    if (para.length) addParagraph(para.join("\n"), paraStart);
    para = [];
  };
  for (const line of text.split("\n")) {
    const lineStart = pos;
    pos += line.length + 1;
    const level = headingLevel(line);
    if (level) {
      endParagraph();
      flush();
      while (path.length && path[path.length - 1].level >= level) path.pop();
      path.push({ level, title: cleanHeading(line) });
      continue;
    }
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    if (!para.length) paraStart = lineStart;
    para.push(line);
  }
  endParagraph();
  flush();
  return chunks;
}
