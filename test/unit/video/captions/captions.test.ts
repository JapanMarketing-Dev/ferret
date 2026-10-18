import { describe, expect, it } from 'vitest';
import type { Caption } from '@video/core';
import { validateTimeline } from '@video/core';
import type { Word } from '@video/captions';
import {
  breakAtoms, buildCaptions, CAPTION_STYLES, charLen, endsSentence, glossaryRanges, sentences, DEFAULT_FILLERS, dice, findFillers, findRetakes, layoutLines, normalizeForMatch,
  phrases, toAss, toSrt, wordsFromWhisperJson,
} from '@video/captions';

const F30 = { num: 30, den: 1 };
const V = { width: 1080, height: 1920, fps: F30, colorSpace: 'bt709' as const };

/** Words with even timing: each token `dur` seconds, `gap` between. */
function timed(tokens: string[], o: { start?: number; dur?: number; gap?: number } = {}): Word[] {
  let t = o.start ?? 0;
  return tokens.map((w) => {
    const word = { w, start: t, end: t + (o.dur ?? 0.3) };
    t = word.end + (o.gap ?? 0.02);
    return word;
  });
}

describe('wordsFromWhisperJson', () => {
  const tok = (text: string, from: number, to: number, p = 0.9) => ({ text, offsets: { from, to }, p });
  it('merges English sub-word tokens and punctuation, skips special tokens', () => {
    const json = {
      result: { language: 'en' },
      transcription: [{
        text: ' Hello world, it works.', offsets: { from: 0, to: 2000 },
        tokens: [tok('[_BEG_]', 0, 0), tok(' Hello', 0, 400), tok(' wor', 400, 600), tok('ld', 600, 800, 0.5), tok(',', 800, 820), tok(' it', 900, 1100), tok(' works', 1100, 1500), tok('.', 1500, 1550), tok('[_TT_100]', 2000, 2000)],
      }],
    };
    expect(wordsFromWhisperJson(json)).toEqual([
      { w: 'Hello', start: 0, end: 0.4, conf: 0.9 },
      { w: 'world,', start: 0.4, end: 0.82, conf: 0.5 },
      { w: 'it', start: 0.9, end: 1.1, conf: 0.9 },
      { w: 'works.', start: 1.1, end: 1.55, conf: 0.9 },
    ]);
  });
  it('keeps Japanese tokens as words and repairs split UTF-8 characters from the segment text', () => {
    const json = JSON.stringify({
      transcription: [{
        text: 'こんにちは世界です', offsets: { from: 0, to: 3000 },
        tokens: [tok('こんにちは', 0, 1000), tok('�', 1000, 1200, 0.4), tok('��', 1200, 1500, 0.6), tok('界', 1500, 1800), tok('です', 1800, 2500)],
      }],
    });
    const w = wordsFromWhisperJson(json);
    expect(w.map((x) => x.w)).toEqual(['こんにちは', '世', '界', 'です']);
    expect(w[1]).toMatchObject({ start: 1, end: 1.5, conf: 0.4 });
  });
  it('broken tokens at the end take the rest of the segment', () => {
    const w = wordsFromWhisperJson({ transcription: [{ text: '設定です', offsets: { from: 0, to: 1000 }, tokens: [tok('設定', 0, 500), tok('��', 500, 700), tok('�', 700, 900)] }] });
    expect(w.map((x) => x.w)).toEqual(['設定', 'です']);
    expect(w[1]!.end).toBe(0.9);
  });
  it('falls back to segment-level words without tokens (-oj)', () => {
    expect(wordsFromWhisperJson({ transcription: [{ text: ' 一文目', offsets: { from: 500, to: 1500 } }, { text: '  ', offsets: { from: 1500, to: 1600 } }] }))
      .toEqual([{ w: '一文目', start: 0.5, end: 1.5 }]);
  });
  it('rejects non-whisper input and tolerates malformed tokens', () => {
    expect(() => wordsFromWhisperJson({})).toThrow(/transcription/);
    expect(() => wordsFromWhisperJson('[1,2]')).toThrow(/transcription/);
    expect(() => wordsFromWhisperJson('not json')).toThrow();
    expect(wordsFromWhisperJson({ transcription: [{ text: 'a', tokens: [{ text: 5 }, { text: 'a' }, { text: ' b', offsets: { from: 'x', to: 1 } }] }] })).toEqual([]);
    expect(wordsFromWhisperJson({ transcription: [] })).toEqual([]);
  });
});

describe('layoutLines (BudouX)', () => {
  const texts = [
    '今日はとてもいい天気ですね。散歩に行きましょう',
    'Claude Codeの設定画面を開いて右上の歯車を押します',
    'この動画ではAIエージェントに動画編集をまかせる方法を三つ紹介します',
    '短い',
    'あいうえおかきくけこさしすせそたちつてとなにぬねの',
  ];
  it('never splits inside a phrase (unless the phrase is longer than a line) and respects max chars', () => {
    for (const text of texts) {
      for (const max of [4, 6, 8, 10, 12, 16, 30]) {
        const lines = layoutLines(text, max, 'ja');
        expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, '')); // nothing lost (a space at a break is dropped)
        for (const l of lines) expect(charLen(l), `${text}/${max}: ${l}`).toBeLessThanOrEqual(max);
        if (/\s/.test(text)) continue; // the boundary check below counts raw offsets
        // every break falls on a phrase boundary, or inside a phrase longer than max
        const ps = phrases(text);
        const bounds = new Set<number>();
        let at = 0;
        for (const p of ps) bounds.add((at += p.length));
        let pos = 0;
        for (const l of lines.slice(0, -1)) {
          pos += l.length;
          if (!bounds.has(pos)) {
            const containing = ps.find((_, i) => { const s = ps.slice(0, i).join('').length; return s < pos && s + ps[i]!.length > pos; })!;
            expect(charLen(containing), `break inside "${containing}" at ${max}`).toBeGreaterThan(max);
          }
        }
      }
    }
  });
  it('uses the fewest lines and balances them', () => {
    const lines = layoutLines('Claude Codeの設定画面を開いて', 12, 'ja');
    expect(lines.length).toBe(2);
    expect(lines.every((l) => charLen(l) <= 12)).toBe(true);
    const l2 = layoutLines('今日はとてもいい天気ですね', 10, 'ja');
    expect(l2.length).toBe(2);
    expect(Math.abs(charLen(l2[0]!) - charLen(l2[1]!))).toBeLessThanOrEqual(4);
  });
  it('English breaks between words', () => {
    const lines = layoutLines('the quick brown fox jumps over the lazy dog', 12, 'en');
    expect(lines.every((l) => l.length <= 12)).toBe(true);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
    expect(layoutLines('supercalifragilistic', 8, 'en')).toEqual(['supercal', 'ifragili', 'stic']);
  });
  it('edge cases', () => {
    expect(layoutLines('', 10, 'ja')).toEqual([]);
    expect(layoutLines('   ', 10, 'en')).toEqual([]);
    expect(layoutLines('あ', 1, 'ja')).toEqual(['あ']);
    expect(() => layoutLines('x', 0, 'ja')).toThrow(RangeError);
    // surrogate pairs count as one char and are never split
    expect(layoutLines('𠮷野家の𠮷', 2, 'ja').every((l) => charLen(l) <= 2)).toBe(true);
  });
});

describe('buildCaptions', () => {
  const ja = timed(['今日', 'は', 'Claude', ' Code', 'の', '設定', 'を', '紹介', 'し', 'ます。', 'まず', '画面', 'を', '開き', 'ます']);
  it('builds valid captions within line and char limits', () => {
    const caps = buildCaptions(ja, { fps: F30, maxCharsPerLine: 8, maxLines: 2, language: 'ja', style: 'tiktok-bold' });
    expect(caps.length).toBeGreaterThan(1);
    for (const c of caps) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect(charLen(l)).toBeLessThanOrEqual(8);
      expect(c.range.end).toBeGreaterThan(c.range.start);
      expect(c.text).toBe(c.spoken);
      expect(c.id).toMatch(/^cap_\d{4}$/);
      expect(c.position).toEqual(CAPTION_STYLES['tiktok-bold']!.position);
      for (const w of c.words) {
        expect(w.start).toBeGreaterThanOrEqual(c.range.start);
        expect(w.end).toBeLessThanOrEqual(c.range.end);
      }
    }
    // sentence end splits captions: "ます。" ends one caption
    expect(caps.some((c) => c.text.endsWith('ます。'))).toBe(true);
    // all words used once, in order
    expect(caps.map((c) => c.text).join('')).toBe(ja.map((w) => w.w).join(''));
    // no overlaps
    for (let i = 1; i < caps.length; i++) expect(caps[i]!.range.start).toBeGreaterThanOrEqual(caps[i - 1]!.range.end);
  });
  it('captions pass core validation inside a timeline', () => {
    const caps = buildCaptions(ja, { fps: F30, maxCharsPerLine: 10, maxLines: 2, language: 'ja', style: 'youtube-clean' });
    const end = Math.max(...caps.map((c) => c.range.end));
    const t = {
      schema: 1, meta: { title: 't', kind: 'talk', template: { id: 'x', version: '1' }, audience: '', goal: '', language: 'ja', targets: [], glossary: [], references: [] },
      canvas: V, sources: { cam: { kind: 'camera', path: 'c.mp4', take: 'take_1', role: 'front', fps: F30, size: { width: 1080, height: 1920 }, offset: 0 } },
      outline: [], segments: [{ id: 'seg_1', range: { start: 0, end }, src: { from: 0, to: end, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain', video: { layout: 'camera-full', camera: 'cam' }, decided: { by: 'rule', reason: 'x' } }],
      scenes: [], captions: caps, overlays: [], audio: { voice: { denoise: 'off', eq: 'off', loudness: -14, truePeak: -1 }, bgm: [], sfx: [] }, masks: [], markers: [], outputs: [], review: { openItems: [], feedback: [] },
    };
    const r = validateTimeline(t);
    expect(r.ok, JSON.stringify(r.issues)).toBe(true);
    expect(r.issues.filter((i) => i.path.startsWith('captions'))).toEqual([]);
  });
  it('breaks on long pauses and English word limits', () => {
    const en = [...timed(['This', 'is', 'a', 'test.'], { start: 0 }), ...timed(['After', 'a', 'pause'], { start: 5 })];
    const caps = buildCaptions(en, { fps: F30, maxCharsPerLine: 20, maxLines: 1, language: 'en', style: 'youtube-clean' });
    expect(caps.map((c) => c.text)).toEqual(['This is a test.', 'After a pause']);
    expect(caps[1]!.range.start).toBe(150);
    const narrow = buildCaptions(timed(['one', 'two', 'three', 'four', 'five']), { fps: F30, maxCharsPerLine: 9, maxLines: 1, language: 'en', style: 'x' });
    expect(narrow.map((c) => c.lines)).toEqual([['one two'], ['three'], ['four five']]);
  });
  it('mapTime drops cut words and places the rest on the timeline', () => {
    const w = timed(['えー', '今日は', '設定を', '説明', 'します'], { dur: 0.5, gap: 0 });
    // cut the first 0.5 s: shift everything after by -15 frames
    const caps = buildCaptions(w, {
      fps: F30, maxCharsPerLine: 20, maxLines: 2, language: 'ja', style: 'tiktok-bold',
      mapTime: (sec) => (sec < 0.5 ? null : Math.round((sec - 0.5) * 30)),
    });
    expect(caps.map((c) => c.text)).toEqual(['今日は設定を説明します']);
    expect(caps[0]!.range).toEqual({ start: 0, end: 60 });
  });
  it('bridges small gaps, enforces a minimum duration and never overlaps', () => {
    const w = [{ w: 'あ。', start: 0, end: 0.05 }, { w: 'い。', start: 0.1, end: 0.15 }, { w: 'う。', start: 3, end: 3.1 }];
    const caps = buildCaptions(w, { fps: F30, maxCharsPerLine: 10, maxLines: 1, language: 'ja', style: 'x' });
    expect(caps.map((c) => [c.range.start, c.range.end])).toEqual([[0, 3], [3, 21], [90, 108]]);
  });
  it('handles empty input and bad options', () => {
    expect(buildCaptions([], { fps: F30, maxCharsPerLine: 10, maxLines: 2, language: 'ja', style: 'x' })).toEqual([]);
    expect(buildCaptions([{ w: '  ', start: 0, end: 1 }], { fps: F30, maxCharsPerLine: 10, maxLines: 2, language: 'ja', style: 'x' })).toEqual([]);
    expect(() => buildCaptions(ja, { fps: F30, maxCharsPerLine: 0, maxLines: 2, language: 'ja', style: 'x' })).toThrow(RangeError);
    expect(() => buildCaptions(ja, { fps: F30, maxCharsPerLine: 5, maxLines: 0, language: 'ja', style: 'x' })).toThrow(RangeError);
  });
  it('property: random Japanese word streams always respect the limits', () => {
    const vocab = ['今日', 'は', '動画', 'の', '編集', 'を', 'エージェント', 'に', 'まかせ', 'ます', 'とても', '便利', 'です', '。', 'Claude', 'Code', 'で', '設定', 'する'];
    let seed = 1;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 60; trial++) {
      const tokens = Array.from({ length: 5 + Math.floor(r() * 40) }, () => vocab[Math.floor(r() * vocab.length)]!);
      const max = 6 + Math.floor(r() * 12);
      const lines = 1 + Math.floor(r() * 2);
      const caps = buildCaptions(timed(tokens, { dur: 0.2 + r() * 0.3, gap: r() * 0.2 }), { fps: F30, maxCharsPerLine: max, maxLines: lines, language: 'ja', style: 'x' });
      expect(caps.map((c) => c.text).join('').replace(/\s/g, '')).toBe(tokens.join(''));
      for (const c of caps) {
        for (const l of c.lines) expect(charLen(l)).toBeLessThanOrEqual(max);
        if (c.words.length > 1) expect(c.lines.length).toBeLessThanOrEqual(lines);
      }
      for (let i = 1; i < caps.length; i++) expect(caps[i]!.range.start).toBeGreaterThanOrEqual(caps[i - 1]!.range.end);
    }
  });
});

function cap(p: Partial<Caption> = {}): Caption {
  return {
    id: 'cap_0001', range: { start: 30, end: 90 }, text: '設定を開きます', spoken: '設定を開きます',
    words: [{ text: '設定', start: 30, end: 45 }, { text: 'を', start: 45, end: 50 }, { text: '開きます', start: 50, end: 90 }],
    lines: ['設定を', '開きます'], emphasis: [], style: 'tiktok-bold', position: { anchor: 'bottom', y: 0.7 },
    decided: { by: 'rule', reason: 'x' }, ...p,
  };
}

describe('periods inside tokens and glossary terms', () => {
  const opt = (extra: Partial<Parameters<typeof buildCaptions>[1]> = {}) => ({ fps: F30, maxCharsPerLine: 16, maxLines: 2, language: 'ja' as const, style: 'x', ...extra });
  it('endsSentence: file names, domains, versions and abbreviations are not sentence ends', () => {
    expect(endsSentence('CLAUDE.', 'md', 'ja')).toBe(false);
    expect(endsSentence('CLAUDE.', 'MD', 'ja')).toBe(false);
    expect(endsSentence('2.1.', '296', 'ja')).toBe(false);
    expect(endsSentence('example.', 'com', 'en')).toBe(false);
    expect(endsSentence('e.g.', 'Claude', 'en')).toBe(false);
    expect(endsSentence('i.e.', 'the', 'en')).toBe(false);
    expect(endsSentence('Dr.', 'Smith', 'en')).toBe(false);
    expect(endsSentence('done.', 'Next', 'en')).toBe(true); // English: capital after a space starts a sentence
    expect(endsSentence('done.', undefined, 'en')).toBe(true);
    expect(endsSentence('です。', 'md', 'ja')).toBe(true); // full-width stop always ends
    expect(endsSentence('です.', 'では', 'ja')).toBe(true);
    expect(endsSentence('本当?', 'md', 'ja')).toBe(true);
    expect(endsSentence('待って...', 'md', 'ja')).toBe(true);
    expect(endsSentence('CLAUDE', 'md', 'ja')).toBe(false);
    expect(endsSentence('', 'x', 'ja')).toBe(false);
  });
  it('"CLAUDE.md" stays in one caption (ja), with and without a period-word split', () => {
    for (const toks of [['CLAUDE.', 'md', 'を', '書きます。'], ['CLAUDE', '.', 'md', 'を', '書きます。'], ['CLAUDE.md', 'を', '書きます。']]) {
      const caps = buildCaptions(timed(toks), opt());
      expect(caps.map((c) => c.text)).toEqual(['CLAUDE.mdを書きます。']);
    }
  });
  it('versions and domains do not split; a real sentence end still does', () => {
    const caps = buildCaptions(timed(['バージョン', '2.', '1.', '296', 'です。', 'example.', 'com', 'を', '見て。', '次', 'へ']), opt({ maxCharsPerLine: 30 }));
    expect(caps.map((c) => c.text)).toEqual(['バージョン2.1.296です。', 'example.comを見て。', '次へ']);
    const en = buildCaptions(timed(['Open', 'CLAUDE.', 'md', 'e.g.', 'Claude', 'reads', 'it.', 'Next', 'step']), opt({ language: 'en', maxCharsPerLine: 40, maxLines: 1 }));
    expect(en.map((c) => c.text)).toEqual(['Open CLAUDE. md e.g. Claude reads it.', 'Next step']);
  });
  it('glossaryRanges: case-insensitive, longest first, no overlaps, empty terms ignored', () => {
    expect(glossaryRanges('Claude Codeとclaude', ['Claude', 'Claude Code', ' '])).toEqual([[0, 11], [12, 18]]);
    expect(glossaryRanges('abc', [])).toEqual([]);
    expect(glossaryRanges('', ['x'])).toEqual([]);
    expect(glossaryRanges('aaaa', ['aa'])).toEqual([[0, 2], [2, 4]]);
  });
  it('layoutLines never breaks inside a glossary term; an over-long term gets its own line', () => {
    const text = 'これはClaude Codeの話です';
    const plain = layoutLines(text, 8, 'ja');
    const g = layoutLines(text, 8, 'ja', ['Claude Code']);
    expect(g.some((l) => l.includes('Claude Code'))).toBe(true);
    expect(g.join('').replace(/\s/g, '')).toBe(plain.join('').replace(/\s/g, ''));
    const long = layoutLines('設定はsuper-long-config-file-name.jsonにあります', 10, 'ja', ['super-long-config-file-name.json']);
    expect(long.some((l) => l.includes('super-long-config-file-name.json'))).toBe(true);
    for (const l of long) if (!l.includes('super-long')) expect(charLen(l)).toBeLessThanOrEqual(10);
    // English: a multi-word term never straddles lines
    const en = layoutLines('we use Visual Studio Code daily', 12, 'en', ['Visual Studio Code']);
    expect(en.filter((l) => l.includes('Visual Studio Code'))).toHaveLength(1);
    expect(breakAtoms('Visual Studio Code', 'en', 5, ['visual studio code'])).toEqual(['Visual Studio Code']);
    expect(breakAtoms('Visual Studio Code', 'en', 5).length).toBeGreaterThan(1);
  });
  it('buildCaptions keeps glossary terms in one caption across pauses, sentence marks and tight limits', () => {
    // a long pause between "Claude" and "Code" would normally split the caption
    const w = timed(['Claude', 'Code', 'で', '作る'], { gap: 0.02 });
    for (const x of w.slice(1)) [x.start, x.end] = [x.start + 2, x.end + 2];
    expect(buildCaptions(w, opt()).map((c) => c.text)).toEqual(['Claude', 'Codeで作る']);
    const caps = buildCaptions(w, opt({ glossary: ['Claude Code'] }));
    expect(caps[0]!.text.startsWith('Claude Code')).toBe(true);
    // tight lines: the term is never split across captions
    const tight = buildCaptions(timed(['今日', 'は', 'Claude', 'Code', 'と', 'CLAUDE.', 'md', 'の', '話']), opt({ maxCharsPerLine: 6, maxLines: 1, glossary: ['Claude Code', 'CLAUDE.md'] }));
    const texts = tight.map((c) => c.text);
    expect(texts.some((t) => t.includes('Claude Code'))).toBe(true);
    expect(texts.some((t) => t.includes('CLAUDE.md'))).toBe(true);
    expect(texts.join('')).toBe('今日はClaude CodeとCLAUDE.mdの話');
    for (const c of tight) expect(c.range.end).toBeGreaterThan(c.range.start);
  });
  it('sentences() (retake detection) does not split at file-name periods either', () => {
    const ss = sentences(timed(['CLAUDE.', 'md', 'を', '更新。', '次。']));
    expect(ss).toHaveLength(2);
    expect(ss[0]!.norm).toBe(normalizeForMatch('CLAUDE.mdを更新。'));
  });
});

describe('toAss', () => {
  const style = CAPTION_STYLES['tiktok-bold']!;
  it('writes a header sized to the canvas and a positioned karaoke dialogue', () => {
    const ass = toAss([cap()], style, V, F30);
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toMatch(/Style: Caption,Noto Sans JP,81,&H0000E6FF,&H00FFFFFF,&H00000000/);
    const line = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(line).toBe('Dialogue: 0,0:00:01.00,0:00:03.00,Caption,,0,0,0,,{\\an2\\pos(540,1344)\\b900}{\\k50}設定{\\k17}を\\N{\\k133}開きます');
  });
  it('karaoke durations add up to the caption length', () => {
    const ass = toAss([cap()], style, V, F30);
    const ks = [...ass.matchAll(/\\k(\d+)/g)].map((m) => Number(m[1]));
    expect(ks.reduce((a, b) => a + b, 0)).toBe(200);
  });
  it('splits a word across lines and keeps total karaoke time', () => {
    const c = cap({ text: 'あいうえお', spoken: 'あいうえお', words: [{ text: 'あいうえお', start: 30, end: 90 }], lines: ['あいう', 'えお'] });
    const line = toAss([c], style, V, F30).split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(line).toContain('{\\k120}あいう\\N{\\k80}えお');
  });
  it('escapes braces, backslashes and newlines', () => {
    const c = cap({ text: 'a{b}\\N', words: [], lines: ['a{b}\\N', 'x\ny'] });
    const line = toAss([c], CAPTION_STYLES['youtube-clean']!, V, F30).split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(line).toContain('a\\{b\\}\\⁠N\\Nx\\Ny');
    expect(line).not.toMatch(/\\k/);
  });
  it('falls back to no karaoke when words do not match the (corrected) text', () => {
    const c = cap({ text: '設定画面を開きます', lines: ['設定画面を', '開きます'] });
    const line = toAss([c], style, V, F30).split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(line).not.toMatch(/\\k/);
    expect(line).toContain('設定画面を\\N開きます');
  });
  it('renders emphasis styles', () => {
    const c = cap({ emphasis: [{ word: '設定', style: 'color' }, { word: '開き', style: 'scale' }] });
    const line = toAss([c], style, V, F30).split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(line).toContain('{\\k50\\1c&H303BFF&\\2c&H303BFF&}設定{\\1c&H00E6FF&\\2c&HFFFFFF&}');
    expect(line).toContain('\\fscx120\\fscy120}開き{\\fscx100\\fscy100}');
    const boxed = toAss([cap({ emphasis: [{ word: 'を', style: 'box' }] })], style, V, F30);
    expect(boxed).toMatch(/\\3c&H00E6FF&\\bord[\d.]+\}を\{\\3c&H000000&/);
  });
  it('anchors, skips empty and zero-length captions, sorts by time', () => {
    const ass = toAss([
      cap({ id: 'cap_2', range: { start: 100, end: 130 }, position: { anchor: 'top', y: 0.1 }, words: [] }),
      cap({ id: 'cap_1', range: { start: 0, end: 20 }, position: { anchor: 'center', y: 0.5 }, words: [] }),
      cap({ id: 'cap_3', text: ' ', lines: [' '], words: [] }),
      cap({ id: 'cap_4', range: { start: 50, end: 50 }, words: [] }),
    ], CAPTION_STYLES.boxed!, V, F30);
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('{\\an5\\pos(540,960)}');
    expect(lines[1]).toContain('{\\an8\\pos(540,192)}');
    expect(ass).toMatch(/Style: Caption,[^,]+,\d+,[^,]+,[^,]+,&H4F000000,&H4F000000,0,0,0,0,100,100,0,0,3,/);
  });
});

describe('toSrt', () => {
  it('numbers cues, formats times with milliseconds, keeps lines', () => {
    const srt = toSrt([cap({ range: { start: 3661 * 30 + 15, end: 3662 * 30 } }), cap({ id: 'cap_0', range: { start: 0, end: 1 } })], F30);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:00,033\n設定を\n開きます\n\n2\n01:01:01,500 --> 01:01:02,000\n設定を\n開きます\n');
  });
  it('NTSC rates and sanitization', () => {
    const srt = toSrt([cap({ range: { start: 30, end: 60 }, lines: ['a --> b', '', 'c\r\nd'] })], { num: 30000, den: 1001 });
    expect(srt).toBe('1\n00:00:01,001 --> 00:00:02,002\na -> b\nc d\n');
    expect(toSrt([], F30)).toBe('');
    expect(toSrt([cap({ text: '', lines: [] })], F30)).toBe('');
  });
});

describe('findFillers', () => {
  it('finds Japanese fillers including elongations and split tokens', () => {
    const w = timed(['えー', '今日は', 'えっ', 'と', '設定', 'まあ', 'その', '話', 'あのーー', 'あの', '人', 'えーーっと、']);
    const f = findFillers(w, DEFAULT_FILLERS.ja);
    expect(f.map((x) => x.text)).toEqual(['えー', 'えっと', 'まあ', 'その', 'あのーー', 'えーーっと、']);
    expect(f[1]!.start).toBe(w[2]!.start);
    expect(f[1]!.end).toBe(w[3]!.end);
  });
  it('finds English fillers case- and punctuation-insensitively, multi-word', () => {
    const w = timed(['Um,', 'so', 'I', 'like', 'this,', 'uh', 'you', 'know?', 'Hmm']);
    expect(findFillers(w, DEFAULT_FILLERS.en).map((x) => x.text)).toEqual(['Um,', 'like', 'uh', 'you know?', 'Hmm']);
  });
  it('edge cases', () => {
    expect(findFillers([], ['えー'])).toEqual([]);
    expect(findFillers(timed(['えー']), [])).toEqual([]);
    expect(findFillers(timed(['、']), ['、'])).toEqual([]);
    expect(normalizeForMatch('Ｕｍ！')).toBe('um');
    expect(normalizeForMatch('あの〜〜')).toBe('あのー');
  });
});

describe('findRetakes', () => {
  it('finds a restarted sentence (first attempt cut short)', () => {
    const w = [
      ...timed(['この', '設定', '画面', 'を', '開い', '…'], { start: 0 }),
      ...timed(['この', '設定', '画面', 'を', '開いて', '右上', 'の', '歯車', 'を', '押します。'], { start: 3 }),
      ...timed(['次に', 'エージェント', 'を', '起動', 'します。'], { start: 8 }),
    ];
    const r = findRetakes(w);
    expect(r).toHaveLength(1);
    expect(r[0]!.first[0]).toBe(0);
    expect(r[0]!.second[0]).toBe(3);
    expect(r[0]!.score).toBeGreaterThan(0.8);
  });
  it('English retakes and non-retakes', () => {
    const w = [
      ...timed(['Open', 'the', 'settings', 'and', 'click.'], { start: 0 }),
      ...timed(['Open', 'the', 'settings', 'and', 'click', 'the', 'gear.'], { start: 4 }),
      ...timed(['Now', 'we', 'start', 'the', 'agent.'], { start: 9 }),
    ];
    const r = findRetakes(w);
    expect(r.map((x) => [x.first[0], x.second[0]])).toEqual([[0, 4]]);
  });
  it('respects the window and the threshold', () => {
    const a = timed(['同じ', '文章', 'を', '言い', 'ます。'], { start: 0 });
    const b = timed(['同じ', '文章', 'を', '言い', 'ます。'], { start: 60 });
    expect(findRetakes([...a, ...b])).toEqual([]);
    expect(findRetakes([...a, ...b], { windowSec: 120 })).toHaveLength(1);
    expect(findRetakes([...a, ...timed(['全然', '違う', '話', 'です。'], { start: 3 })])).toEqual([]);
    expect(findRetakes([...a, ...timed(['同じ', '文章', 'を', '言い', 'ます。'], { start: 3 })], { similarity: 1.01 })).toEqual([]);
    expect(findRetakes([])).toEqual([]);
  });
  it('dice', () => {
    expect(dice('abc', 'abc')).toBe(1);
    expect(dice('', '')).toBe(0);
    expect(dice('ab', 'cd')).toBe(0);
    expect(dice('night', 'nacht')).toBeCloseTo(0.25, 5);
  });
});
