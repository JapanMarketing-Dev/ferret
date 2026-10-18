import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Glossary terms (product names, file names) for transcription: they go into whisper's initial prompt, and a
// reading-based pass fixes captions where whisper still heard them as something else ("クロード、M、P" → "CLAUDE.md").

export interface Term { term: string; reading?: string }

const LETTERS: Record<string, string> = {
  a: 'エー', b: 'ビー', c: 'シー', d: 'ディー', e: 'イー', f: 'エフ', g: 'ジー', h: 'エイチ', i: 'アイ', j: 'ジェー', k: 'ケー', l: 'エル', m: 'エム',
  n: 'エヌ', o: 'オー', p: 'ピー', q: 'キュー', r: 'アール', s: 'エス', t: 'ティー', u: 'ユー', v: 'ブイ', w: 'ダブリュー', x: 'エックス', y: 'ワイ', z: 'ゼット',
};

/** How common tech words are said in Japanese (the rest is spelled letter by letter). */
const WORDS: Record<string, string> = {
  claude: 'クロード', code: 'コード', codex: 'コーデックス', gemini: 'ジェミニ', git: 'ギット', github: 'ギットハブ', python: 'パイソン',
  docker: 'ドッカー', react: 'リアクト', node: 'ノード', next: 'ネクスト', vue: 'ビュー', type: 'タイプ', script: 'スクリプト', json: 'ジェイソン',
  yaml: 'ヤムル', mac: 'マック', windows: 'ウィンドウズ', linux: 'リナックス', chrome: 'クローム', google: 'グーグル', open: 'オープン',
  agent: 'エージェント', agents: 'エージェンツ', cursor: 'カーソル', copilot: 'コパイロット', ferret: 'フェレット', cloud: 'クラウド', api: 'エーピーアイ',
  mcp: 'エムシーピー', ai: 'エーアイ', cli: 'シーエルアイ', md: 'エムディー', npm: 'エヌピーエム', vs: 'ブイエス', studio: 'スタジオ',
};

const hiraToKata = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

/** Sound key: NFKC, hiragana → katakana, Latin words → their katakana reading, no spaces or punctuation. */
export function soundKey(s: string): string {
  return hiraToKata(s.normalize('NFKC'))
    // camel-case runs are separate words: "CLAUDECode" → CLAUDE + Code, "GitHub" → Git + Hub (unless known whole)
    .replace(/[A-Za-z]+/g, (run) => (WORDS[run.toLowerCase()] ? [run] : run.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
      .map((w) => WORDS[w.toLowerCase()] ?? [...w.toLowerCase()].map((c) => LETTERS[c] ?? '').join('')).join(''))
    .replace(/[0-9]/g, (d) => ['ゼロ', 'イチ', 'ニ', 'サン', 'ヨン', 'ゴ', 'ロク', 'ナナ', 'ハチ', 'キュウ'][Number(d)]!)
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** Readings a term may be heard as: its given reading, the spelled-out form, and with "." read as ドット. */
export function readingsOf(t: Term): string[] {
  const out = new Set<string>();
  if (t.reading) out.add(soundKey(t.reading));
  out.add(soundKey(t.term));
  if (t.term.includes('.')) out.add(soundKey(t.term.replace(/\./g, ' ドット ')));
  return [...out].filter((r) => r.length >= 3);
}

function levenshtein(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[B.length]!;
}

export function similarity(a: string, b: string): number {
  const n = Math.max([...a].length, [...b].length);
  return n ? 1 - levenshtein(a, b) / n : 1;
}

export interface Correction { from: string; to: string; score: number }

/**
 * Replace near-matches of glossary terms in `text` (reading similarity ≥ `min`, default 0.75). A spelling that only
 * differs in case ("CLAUDE Code") is respelled; exact spellings are left alone; matches do not overlap (best first).
 */
export function correctText(text: string, terms: Term[], min = 0.75): { text: string; corrections: Correction[] } {
  const chars = [...text];
  type Hit = { i: number; j: number; term: string; score: number };
  const hits: Hit[] = [];
  // the term spelled with other letter case is fixed outright; any spelling of it is protected from the fuzzy pass
  const lower = chars.map((c) => c.toLowerCase());
  const exact: [number, number][] = [];
  for (const t of terms) {
    const tc = [...t.term.toLowerCase()];
    for (let i = 0; i + tc.length <= lower.length; i++) {
      if (!tc.every((c, k) => lower[i + k] === c)) continue;
      exact.push([i, i + tc.length]);
      if (chars.slice(i, i + tc.length).join('') !== t.term) hits.push({ i, j: i + tc.length, term: t.term, score: 1 });
    }
  }
  for (const t of terms) {
    const reads = readingsOf(t);
    if (!reads.length) continue;
    const maxLen = Math.max(...reads.map((r) => [...r].length));
    for (let i = 0; i < chars.length; i++) {
      if (/[\s\p{P}]/u.test(chars[i]!)) continue;   // a match starts on a letter
      for (let j = i + 1; j <= chars.length && j - i <= maxLen * 2 + 4; j++) {
        if (/[\s\p{P}]/u.test(chars[j - 1]!)) continue;   // and ends on one
        const raw = chars.slice(i, j).join('');
        if (exact.some(([a, b]) => i < b && a < j)) continue;
        const key = soundKey(raw);
        if (key.length < 3) continue;
        const score = Math.max(...reads.map((r) => similarity(key, r)));
        if (score >= min) hits.push({ i, j, term: t.term, score });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || (b.j - b.i) - (a.j - a.i));
  const taken: Hit[] = [];
  for (const h of hits) if (!taken.some((x) => h.i < x.j && x.i < h.j)) taken.push(h);
  taken.sort((a, b) => b.i - a.i);
  const out = [...chars];
  const corrections: Correction[] = [];
  for (const h of taken) {
    corrections.unshift({ from: chars.slice(h.i, h.j).join(''), to: h.term, score: Math.round(h.score * 100) / 100 });
    out.splice(h.i, h.j - h.i, h.term);
  }
  return { text: out.join(''), corrections };
}

/** Latin-looking terms in a script: `code spans`, file names (x.md) and capitalized words / phrases. */
export function termsFromScript(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{2,40})`/g)) out.add(m[1]!.trim());
  for (const m of text.matchAll(/\b[A-Za-z][\w-]*\.(?:md|json|ya?ml|ts|js|py|toml|txt)\b/g)) out.add(m[0]);
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9]+(?: [A-Z][A-Za-z0-9]+)*\b/g)) {
    if (m[0].length >= 3 && ![...out].some((x) => x.includes(m[0]))) out.add(m[0]);
  }
  return [...out];
}

/** Title words worth seeding meta.glossary with (init): Latin phrases such as "Claude Code". */
export function termsFromTitle(title: string): string[] {
  return [...new Set([...title.matchAll(/[A-Za-z][A-Za-z0-9.+#-]*(?: [A-Z][A-Za-z0-9.+#-]*)*/g)].map((m) => m[0].trim()).filter((s) => s.length >= 2))];
}

/** Every glossary term for a project: timeline meta.glossary, the template's glossary, script.md terms. */
export function projectTerms(dir: string, metaGlossary: Term[], templateGlossary: Term[] = []): Term[] {
  const seen = new Map<string, Term>();
  const add = (t: Term) => {
    const k = t.term.trim();
    if (k && !seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), { ...t, term: k });
  };
  metaGlossary.forEach(add);
  templateGlossary.forEach(add);
  for (const f of ['script.md', 'SCRIPT.md']) {
    const p = join(dir, f);
    if (existsSync(p)) {
      termsFromScript(readFileSync(p, 'utf8')).forEach((term) => add({ term }));
      break;
    }
  }
  return [...seen.values()];
}

/** whisper `--prompt`: the filler-keeping sentence plus the terms (whisper reads ~224 tokens; keep it short). */
export function initialPrompt(base: string, terms: Term[], lang: 'ja' | 'en'): string {
  if (!terms.length) return base;
  let list = '';
  for (const t of terms) {
    const next = list ? `${list}${lang === 'ja' ? '、' : ', '}${t.term}` : t.term;
    if (next.length > 160) break;
    list = next;
  }
  return `${base}${lang === 'ja' ? `用語: ${list}。` : ` Terms: ${list}.`}`;
}
