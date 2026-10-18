import type { SlotValue } from '../schema.js';

export type SlotKind = SlotValue['kind'];

/** One slot a pattern declares (pattern.json "slots"). */
export interface SlotDef {
  kind: SlotKind;
  required?: boolean;
  /** text: max characters (code points). */
  maxChars?: number;
  /** list: max items. code: max lines. */
  maxItems?: number;
  hint?: string;
  /** text: default text; video: "camera:<role>" = the synced camera with that role. */
  default?: string;
}

/** Colors and fonts a pattern renders with. Custom patterns override these via `theme`. */
export interface PatternTheme {
  background: string;
  wave: string;
  wave2: string;
  accentFrom: string;
  accentTo: string;
  text: string;
  subtext: string;
  bubbleFill: string;
  bubbleText: string;
  panel: string;
  /** Text font family (bundled OFL: Noto Sans JP, weights 400/700/900). */
  font: string;
  /** Code font family (bundled OFL: JetBrains Mono). */
  mono: string;
}

/** pattern.json (docs/15). `extends` = a built-in pattern whose renderer is reused with this theme/slots. */
export interface PatternDef {
  id: string;
  version: string;
  name: { ja: string; en: string };
  for: ('talk' | 'tech')[];
  aspect: ('16:9' | '9:16')[];
  slots: Record<string, SlotDef>;
  style: Record<string, string>;
  animation: { in: string[]; out: string[] };
  theme?: Partial<PatternTheme>;
  extends?: string;
}

export const DEFAULT_THEME: PatternTheme = {
  background: '#0A0B10',
  wave: '#1A2133',
  wave2: '#141A29',
  accentFrom: '#FF8A00',
  accentTo: '#FF2D55',
  text: '#FFFFFF',
  subtext: '#AEB6C6',
  bubbleFill: '#FFFFFF',
  bubbleText: '#111111',
  panel: '#161B26',
  font: 'Noto Sans JP',
  mono: 'JetBrains Mono',
};

const BOTH = ['16:9', '9:16'] as ('16:9' | '9:16')[];
const ALL = ['talk', 'tech'] as ('talk' | 'tech')[];
const BASE_STYLE = { background: 'waves-dark', frame: 'gradient-orange-red' };

/** Built-in scene patterns (docs/15 組み込みのパターン). */
export const PATTERNS: Record<string, PatternDef> = {
  'explain-illust-bubbles': {
    id: 'explain-illust-bubbles', version: '1', name: { ja: 'イラスト＋吹き出し＋丸ワイプ', en: 'Illustration with bubbles' },
    for: ALL, aspect: BOTH,
    slots: {
      illustration: { kind: 'image', required: true, hint: '人物の線画。黒背景で見えるもの' },
      bubbleLeft: { kind: 'text', maxChars: 30, hint: '発言の要点（15字以内が目安）' },
      bubbleRight: { kind: 'text', maxChars: 30 },
      wipe: { kind: 'video', default: 'camera:front' },
    },
    style: { ...BASE_STYLE, bubble: 'white-rounded', wipe: 'circle-gradient' },
    animation: { in: ['bubbles-pop', 'frame-draw'], out: ['fade'] },
  },
  'title-card': {
    id: 'title-card', version: '1', name: { ja: '章の見出し', en: 'Title card' }, for: ALL, aspect: BOTH,
    slots: {
      title: { kind: 'text', required: true, maxChars: 24 },
      subtitle: { kind: 'text', maxChars: 40 },
      number: { kind: 'number', hint: '章の番号' },
    },
    style: BASE_STYLE, animation: { in: ['rise'], out: ['fade'] },
  },
  'bullet-points': {
    id: 'bullet-points', version: '1', name: { ja: '箇条書き', en: 'Bullet points' }, for: ALL, aspect: BOTH,
    slots: { title: { kind: 'text', maxChars: 24 }, items: { kind: 'list', required: true, maxItems: 5, maxChars: 28 } },
    style: BASE_STYLE, animation: { in: ['line-by-line'], out: ['fade'] },
  },
  'compare-2col': {
    id: 'compare-2col', version: '1', name: { ja: '2つを比べる', en: 'Compare two' }, for: ALL, aspect: BOTH,
    slots: {
      leftTitle: { kind: 'text', required: true, maxChars: 14, default: 'Before' },
      rightTitle: { kind: 'text', required: true, maxChars: 14, default: 'After' },
      left: { kind: 'list', required: true, maxItems: 4, maxChars: 22 },
      right: { kind: 'list', required: true, maxItems: 4, maxChars: 22 },
    },
    style: BASE_STYLE, animation: { in: ['left-then-right'], out: ['fade'] },
  },
  ranking: {
    id: 'ranking', version: '1', name: { ja: 'ランキング', en: 'Ranking' }, for: ALL, aspect: BOTH,
    slots: { title: { kind: 'text', maxChars: 24 }, items: { kind: 'list', required: true, maxItems: 5, maxChars: 24, hint: '1位から順に' } },
    style: BASE_STYLE, animation: { in: ['reverse-reveal'], out: ['fade'] },
  },
  'big-number': {
    id: 'big-number', version: '1', name: { ja: '大きな数字', en: 'Big number' }, for: ALL, aspect: BOTH,
    slots: { value: { kind: 'number', required: true }, label: { kind: 'text', maxChars: 30 } },
    style: BASE_STYLE, animation: { in: ['pop'], out: ['fade'] },
  },
  quote: {
    id: 'quote', version: '1', name: { ja: '引用', en: 'Quote' }, for: ALL, aspect: BOTH,
    slots: { text: { kind: 'text', required: true, maxChars: 80 }, by: { kind: 'text', maxChars: 30 } },
    style: BASE_STYLE, animation: { in: ['fade'], out: ['fade'] },
  },
  'code-focus': {
    id: 'code-focus', version: '1', name: { ja: 'コードの強調', en: 'Code focus' }, for: ['tech'], aspect: BOTH,
    slots: { code: { kind: 'code', required: true, maxItems: 18 }, title: { kind: 'text', maxChars: 40 } },
    style: { background: 'dark', panel: 'editor' }, animation: { in: ['highlight'], out: ['fade'] },
  },
  'terminal-typing': {
    id: 'terminal-typing', version: '1', name: { ja: 'ターミナル入力', en: 'Terminal typing' }, for: ['tech'], aspect: BOTH,
    slots: { command: { kind: 'code', required: true, maxItems: 3 }, output: { kind: 'text', maxChars: 400 } },
    style: { background: 'dark', panel: 'terminal' }, animation: { in: ['typing'], out: ['fade'] },
  },
  'screen-zoom-callout': {
    id: 'screen-zoom-callout', version: '1', name: { ja: '画面の一部を拡大', en: 'Screen zoom callout' }, for: ['tech'], aspect: BOTH,
    slots: {
      screen: { kind: 'video', required: true }, x: { kind: 'number', required: true }, y: { kind: 'number', required: true },
      w: { kind: 'number', required: true }, h: { kind: 'number', required: true }, label: { kind: 'text', maxChars: 30 },
    },
    style: BASE_STYLE, animation: { in: ['zoom'], out: ['fade'] },
  },
  'cta-subscribe': {
    id: 'cta-subscribe', version: '1', name: { ja: 'チャンネル登録の呼びかけ', en: 'Subscribe call to action' }, for: ALL, aspect: BOTH,
    slots: {
      text: { kind: 'text', maxChars: 30, default: 'チャンネル登録お願いします' },
      button: { kind: 'text', maxChars: 12, default: 'チャンネル登録' },
    },
    style: { background: 'none', button: 'red-pill' }, animation: { in: ['pop'], out: ['fade'] },
  },
};

/**
 * Resolve a pattern id: custom patterns (from patterns/<id>/pattern.json) may `extends` another custom pattern or a
 * built-in. The chain must end at a built-in, whose renderer is used. Returns null for unknown or unrenderable ids.
 */
export function resolvePattern(id: string, custom: Record<string, PatternDef> = {}): { def: PatternDef; renderer: string; theme: PatternTheme } | null {
  const chain: PatternDef[] = [];
  const seen = new Set<PatternDef>();
  let cur: PatternDef | undefined = custom[id] ?? PATTERNS[id];
  while (cur) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    chain.push(cur);
    if (!cur.extends) break;
    const ext: string = cur.extends;
    const next: PatternDef | undefined = (ext !== cur.id ? custom[ext] : undefined) ?? PATTERNS[ext];
    if (!next) return null;
    cur = next;
  }
  const root = chain[chain.length - 1];
  if (!root || PATTERNS[root.id] !== root) return null;
  let def: PatternDef = root;
  let theme: Partial<PatternTheme> = { ...(root.theme ?? {}) };
  for (const d of chain.slice(0, -1).reverse()) {
    def = { ...def, ...d, slots: { ...def.slots, ...d.slots }, style: { ...def.style, ...d.style } };
    theme = { ...theme, ...(d.theme ?? {}) };
  }
  return { def: { ...def, id }, renderer: root.id, theme: { ...DEFAULT_THEME, ...theme } };
}
