import { describe, expect, it } from 'vitest';
import { validateTimeline } from '@video/core';
import type { Word } from '@video/captions';
import { buildCaptions, CAPTION_STYLES, charLen, layoutLines, pickEmphasis, toAss } from '@video/captions';

const F30 = { num: 30, den: 1 };
const H = { width: 1920, height: 1080, fps: F30, colorSpace: 'bt709' as const };

function timed(tokens: string[], o: { start?: number; dur?: number; gap?: number } = {}): Word[] {
  let t = o.start ?? 0;
  return tokens.map((w) => {
    const word = { w, start: t, end: t + (o.dur ?? 0.3) };
    t = word.end + (o.gap ?? 0.02);
    return word;
  });
}

describe('tech-bold style (the default of the tech template)', () => {
  it('heavy white text, thick dark outline, bottom centre ~8 %, 18 chars a line, yellow keywords', () => {
    const s = CAPTION_STYLES['tech-bold']!;
    expect(s).toMatchObject({ weight: 900, color: '#FFFFFF', karaoke: false, maxLines: 2, position: { anchor: 'bottom', y: 0.92 } });
    expect(s.maxCharsPerLine.ja).toBe(18);
    expect(s.outlineWidth).toBeGreaterThanOrEqual(0.12);
    expect(s.emphasis.color).toBe('#FFE600');
    // not tiny: at least ~60 px on a 1080p frame, and 18 characters still fit in the frame width
    expect(s.size * 1080).toBeGreaterThanOrEqual(60);
    expect(18 * s.size * 1080).toBeLessThan(1920 * 0.9);
  });

  it('ASS output colors the emphasized term yellow and returns to white', () => {
    const caps = buildCaptions(timed(['Claude', 'Code', 'で', '設定', 'ファイル', 'を', '作る']), {
      fps: F30, maxCharsPerLine: 18, maxLines: 2, language: 'ja', style: 'tech-bold', glossary: ['Claude Code'], emphasis: { auto: true },
    });
    expect(caps[0]!.emphasis).toEqual([{ word: 'Claude Code', style: 'color' }, { word: 'ファイル', style: 'color' }]);
    const ass = toAss(caps, CAPTION_STYLES['tech-bold']!, H, F30);
    expect(ass).toMatch(/\\1c&H00E6FF&[^}]*\}Claude Code\{\\1c&HFFFFFF&/);
  });
});

describe('pickEmphasis', () => {
  const ja = (t: string, glossary: string[] = [], max?: number) => pickEmphasis(t, { language: 'ja', glossary, ...(max !== undefined ? { max } : {}) });

  it('glossary terms first, then numbers with units, warnings, Latin tokens, katakana', () => {
    expect(ja('Claude Code なら設定は3つだけ', ['Claude Code'])).toEqual(['Claude Code', '3つ']);
    expect(ja('ここは絶対に消さないでください')).toEqual(['絶対に']);
    expect(ja('npm install を実行します')).toEqual(['npm install']);
    expect(ja('ターミナルを開きます')).toEqual(['ターミナル']);
    expect(ja('ビルドが10倍速くなります')).toEqual(['10倍']);
  });

  it('at most `max` terms, in text order, no overlaps or duplicates', () => {
    const r = ja('まず GitHub で 5分、次に Docker で 10分、最後に GitHub を開く', ['GitHub', 'Docker']);
    expect(r).toHaveLength(2);
    expect(r).toEqual(['GitHub', 'Docker']);
    expect(ja('GitHub と github', ['GitHub'])).toEqual(['GitHub']);
    expect(ja('3つのコツ', [], 1)).toEqual(['3つ']);
    expect(ja('3つのコツ', [], 0)).toEqual([]);
  });

  it('nothing to emphasize, empty text, or a term that is the whole caption → none', () => {
    expect(ja('それではやっていきましょう')).toEqual([]);
    expect(ja('   ')).toEqual([]);
    expect(ja('Claude', ['Claude'])).toEqual([]); // 100 % of the caption
    expect(ja('あ')).toEqual([]);
  });

  it('English', () => {
    expect(pickEmphasis('This is 10x faster, never skip it', { language: 'en' })).toEqual(['10x', 'never']);
  });
});

describe('timing: min 0.8 s, max 4 s', () => {
  it('a caption never spans more than maxDurationMs; long speech is split between words', () => {
    // 20 short words at 0.32 s each = 6.4 s of continuous speech, all fitting on 2 lines by length
    const words = timed(Array.from({ length: 20 }, (_, i) => (i % 2 ? 'あ' : 'い')), { dur: 0.3 });
    const caps = buildCaptions(words, { fps: F30, maxCharsPerLine: 18, maxLines: 2, language: 'ja', style: 'tech-bold', maxDurationMs: 4000 });
    expect(caps.length).toBeGreaterThanOrEqual(2);
    for (const c of caps) expect(c.words.at(-1)!.end - c.words[0]!.start).toBeLessThanOrEqual(120);
    const none = buildCaptions(words, { fps: F30, maxCharsPerLine: 18, maxLines: 2, language: 'ja', style: 'tech-bold' });
    expect(none).toHaveLength(1);
  });

  it('a single word longer than the limit stays one caption (never empty)', () => {
    const caps = buildCaptions([{ w: 'えーーーー', start: 0, end: 6 }], { fps: F30, maxCharsPerLine: 18, maxLines: 2, language: 'ja', style: 'tech-bold', maxDurationMs: 4000 });
    expect(caps).toHaveLength(1);
  });

  it('short captions are held for minFrames (0.8 s) when the next one leaves room', () => {
    const words = [{ w: 'はい', start: 0, end: 0.2 }, { w: '次', start: 3, end: 3.3 }];
    const caps = buildCaptions(words, { fps: F30, maxCharsPerLine: 18, maxLines: 2, language: 'ja', style: 'tech-bold', minFrames: 24 });
    expect(caps[0]!.range.end - caps[0]!.range.start).toBe(24);
    expect(validateTimeline).toBeTypeOf('function');
  });
});

describe('line breaking at 18 characters', () => {
  it('two balanced lines, never over the limit for normal text, phrases kept', () => {
    const text = 'このコマンドを実行すると設定ファイルが自動で作られます';
    const lines = layoutLines(text, 18, 'ja');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(charLen(l)).toBeLessThanOrEqual(18);
    expect(lines.join('')).toBe(text);
    expect(Math.abs(charLen(lines[0]!) - charLen(lines[1]!))).toBeLessThanOrEqual(8);
  });
});

describe('captions never run past the timeline end (regression: the real 1.8 s take)', () => {
  it('the minimum duration is cut at endFrame; a caption starting at or after it is dropped', () => {
    const words = [{ w: 'この設定を', start: 0, end: 0.5 }, { w: '行う。', start: 1.6, end: 1.75 }];
    const caps = buildCaptions(words, { fps: F30, maxCharsPerLine: 18, maxLines: 2, language: 'ja', style: 'tech-bold', minFrames: 24, endFrame: 55 });
    expect(caps.at(-1)!.range.end).toBe(55);
    for (const c of caps) {
      expect(c.range.end).toBeLessThanOrEqual(55);
      expect(c.range.end).toBeGreaterThan(c.range.start);
      for (const w of c.words) expect(w.end).toBeLessThanOrEqual(55);
    }
    const late = buildCaptions([{ w: 'a', start: 0, end: 0.3 }, { w: 'b。', start: 3, end: 3.2 }], { fps: F30, maxCharsPerLine: 18, maxLines: 2, language: 'ja', style: 'tech-bold', endFrame: 60 });
    expect(late.map((c) => c.text)).toEqual(['a']);
  });
});

describe('real-take regressions', () => {
  it('a pause inside one word (whisper split 設|定) does not start a new caption; a pause between phrases still does', () => {
    const words = [{ w: 'この', start: 8.9, end: 9.0 }, { w: '設', start: 9.0, end: 9.32 }, { w: '定', start: 9.95, end: 9.96 }, { w: 'を', start: 9.96, end: 9.97 }, { w: '行', start: 9.97, end: 9.98 }, { w: 'う。', start: 9.98, end: 9.99 }];
    const caps = buildCaptions(words, { fps: F30, maxCharsPerLine: 18, maxLines: 2, language: 'ja', style: 'tech-bold' });
    expect(caps.map((c) => c.text)).toEqual(['この設定を行う。']);
    const two = buildCaptions([{ w: 'これは', start: 0, end: 0.3 }, { w: '大事', start: 1.5, end: 1.8 }], { fps: F30, maxCharsPerLine: 18, maxLines: 2, language: 'ja', style: 'tech-bold' });
    expect(two).toHaveLength(2);
  });

  it('plain text still gets one keyword: the first kanji word', () => {
    expect(pickEmphasis('この設定を行う。', { language: 'ja' })).toEqual(['設定']);
    expect(pickEmphasis('お、お、お。', { language: 'ja' })).toEqual([]);
    expect(pickEmphasis('this is it', { language: 'en' })).toEqual([]);
  });
});
