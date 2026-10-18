/** A transcribed word. Times in seconds. */
export interface Word {
  w: string;
  start: number;
  end: number;
  conf?: number;
  speaker?: string;
}

interface WToken { text?: unknown; offsets?: { from?: unknown; to?: unknown }; p?: unknown }
interface WSegment { text?: unknown; offsets?: { from?: unknown; to?: unknown }; tokens?: unknown }

const isSpecial = (t: string) => /^\[_[A-Z]+_?\d*\]$/.test(t.trim()) || /^\[_.*_\]$/.test(t.trim()) || /^<\|.*\|>$/.test(t.trim());
const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v / 1000 : null);
const BROKEN = '�';

interface Piece { text: string; start: number; end: number; conf?: number }

/**
 * Whisper splits multi-byte characters across tokens; JSON decoding turns those bytes into U+FFFD. The segment text
 * is intact, so broken tokens are re-filled from the segment text between their intact neighbours.
 */
function repairPieces(tokens: Piece[], segText: string): Piece[] {
  const out: Piece[] = [];
  let cursor = 0;
  let pending: Piece[] = [];
  const flush = (text: string) => {
    if (pending.length === 0) return;
    const first = pending[0]!;
    const last = pending[pending.length - 1]!;
    const confs = pending.map((p) => p.conf).filter((c): c is number => c !== undefined);
    const piece: Piece = { text, start: first.start, end: last.end };
    if (confs.length) piece.conf = Math.min(...confs);
    if (text.trim() !== '') out.push(piece);
    pending = [];
  };
  for (const t of tokens) {
    if (t.text.includes(BROKEN)) {
      pending.push(t);
      continue;
    }
    const idx = segText.indexOf(t.text, cursor);
    if (idx >= 0) {
      flush(segText.slice(cursor, idx));
      cursor = idx + t.text.length;
    } else {
      flush(pending.map((p) => p.text.replaceAll(BROKEN, '')).join(''));
    }
    out.push(t);
  }
  flush(cursor < segText.length && pending.length ? segText.slice(cursor) : pending.map((p) => p.text.replaceAll(BROKEN, '')).join(''));
  return out;
}

const WORDISH = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}'’_-]$/u;
const WORDISH_START = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}'’_-]/u;
const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;

/** Merge token pieces into words: a leading space starts a word; Latin sub-words and punctuation attach. */
export function piecesToWords(pieces: Piece[]): Word[] {
  const words: Word[] = [];
  for (const p of pieces) {
    const raw = p.text;
    const text = raw.trim();
    if (text === '') continue;
    const prev = words[words.length - 1];
    const spaced = /^\s/.test(raw);
    const attach = prev && !spaced && (PUNCT_ONLY.test(text) || (WORDISH.test(prev.w) && WORDISH_START.test(text)));
    if (prev && attach) {
      prev.w += text;
      prev.end = Math.max(prev.end, p.end);
      if (p.conf !== undefined) prev.conf = Math.min(prev.conf ?? 1, p.conf);
    } else {
      const w: Word = { w: text, start: p.start, end: Math.max(p.start, p.end) };
      if (p.conf !== undefined) w.conf = p.conf;
      words.push(w);
    }
  }
  return words;
}

/**
 * Words from whisper.cpp `-ojf` (full JSON) output. Accepts the parsed object or the JSON text.
 * Without token data (`-oj`), each segment becomes one word.
 */
export function wordsFromWhisperJson(json: unknown): Word[] {
  const doc = typeof json === 'string' ? (JSON.parse(json) as unknown) : json;
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as { transcription?: unknown }).transcription)) {
    throw new Error('not whisper.cpp JSON: missing "transcription" array');
  }
  const words: Word[] = [];
  for (const seg of (doc as { transcription: WSegment[] }).transcription) {
    const segText = typeof seg.text === 'string' ? seg.text : '';
    const tokens = Array.isArray(seg.tokens) ? (seg.tokens as WToken[]) : null;
    if (!tokens || tokens.length === 0) {
      const s = ms(seg.offsets?.from);
      const e = ms(seg.offsets?.to);
      if (segText.trim() && s !== null && e !== null) words.push({ w: segText.trim(), start: s, end: Math.max(s, e) });
      continue;
    }
    const pieces: Piece[] = [];
    for (const t of tokens) {
      if (typeof t.text !== 'string' || t.text === '' || isSpecial(t.text)) continue;
      const s = ms(t.offsets?.from);
      const e = ms(t.offsets?.to);
      if (s === null || e === null) continue;
      const piece: Piece = { text: t.text, start: s, end: e };
      if (typeof t.p === 'number') piece.conf = t.p;
      pieces.push(piece);
    }
    words.push(...piecesToWords(repairPieces(pieces, segText)));
  }
  return words;
}
