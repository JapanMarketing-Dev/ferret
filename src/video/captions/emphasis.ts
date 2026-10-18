import { glossaryRanges } from './lines.js';

// Keyword emphasis without a decision model (template `captions.emphasis: auto`): popular Japanese tech videos color
// one or two key terms per caption — product names, numbers with units, warnings. Pure and deterministic.

export interface EmphasisOptions {
  language: 'ja' | 'en';
  /** Project terms (glossary): the strongest candidates. */
  glossary?: readonly string[];
  /** At most this many terms per caption (default 2). */
  max?: number;
}

interface Cand { word: string; at: number; score: number }

const NUMBER_JA = /[0-9０-９]+(?:[.,][0-9]+)?\s*(?:%|％|倍|分|秒|時間|日|回|個|つ|件|割|円|万|億|GB|MB|KB|ms|px|行|ステップ|手順|人)/g;
const NUMBER_EN = /\b\d+(?:[.,]\d+)?\s*(?:%|x|times|minutes?|seconds?|hours?|days?|steps?|GB|MB|KB|ms|px|lines?)\b/gi;
const WARN_JA = /(絶対に?|必ず|注意|危険|ダメ|禁止|しない|しないで|やめ(?:る|て)|ポイント|コツ|重要|大事|簡単|無料|最速)/g;
const WARN_EN = /\b(never|always|must|don't|do not|warning|important|key|free|fastest|easy)\b/gi;
/** Latin technical tokens, consecutive words together: "Claude Code", "npm install", "CLAUDE.md", "v22.3". */
const LATIN = /[A-Za-z][A-Za-z0-9._+#-]*(?:\s[A-Za-z][A-Za-z0-9._+#-]*)*/g;
/** Katakana words of 4+ (コマンド, ターミナル). */
const KATAKANA = /[ァ-ヴー]{4,}/g;

function collect(re: RegExp, text: string, score: number, out: Cand[]): void {
  for (const m of text.matchAll(re)) {
    const word = m[0].trim();
    if (word) out.push({ word, at: m.index ?? 0, score });
  }
}

/**
 * Up to `max` key terms of a caption (returned in text order), chosen by importance: glossary terms (3), numbers with a unit (2.5), warnings
 * and "the point" words (2), Latin technical tokens (1.5, 2+ letters), long katakana words (1); with none of these, the
 * first kanji word of 2–6 characters (0.5, Japanese). Overlapping picks are
 * dropped, and a term covering more than 70 % of the caption is not emphasized (it would color everything).
 */
export function pickEmphasis(text: string, o: EmphasisOptions): string[] {
  const t = text.trim();
  if (!t) return [];
  const ja = o.language === 'ja';
  const cands: Cand[] = [];
  for (const [s, e] of glossaryRanges(t, o.glossary ?? [])) cands.push({ word: t.slice(s, e), at: s, score: 3 });
  collect(ja ? NUMBER_JA : NUMBER_EN, t, 2.5, cands);
  collect(ja ? WARN_JA : WARN_EN, t, 2, cands);
  collect(LATIN, t, 1.5, cands);
  if (ja) collect(KATAKANA, t, 1, cands);
  // nothing stands out: the first content word in kanji (2–6 characters, "設定", "自動化") so most captions get one
  if (ja && !cands.length) {
    const k = /[一-龯々]{2,6}/u.exec(t);
    if (k) cands.push({ word: k[0], at: k.index, score: 0.5 });
  }
  const len = [...t].length;
  const usable = cands.filter((c) => [...c.word].length >= 2 && [...c.word].length <= Math.max(2, len * 0.7));
  // best first; on a tie the longer term (more specific), then the earlier one
  usable.sort((a, b) => b.score - a.score || b.word.length - a.word.length || a.at - b.at);
  const picked: Cand[] = [];
  for (const c of usable) {
    if (picked.length >= (o.max ?? 2)) break;
    if (picked.some((p) => c.at < p.at + p.word.length && p.at < c.at + c.word.length)) continue;
    if (picked.some((p) => p.word.toLowerCase() === c.word.toLowerCase())) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.at - b.at).map((c) => c.word);
}
