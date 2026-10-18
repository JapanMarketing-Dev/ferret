import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { previewSpec } from '@video/cli/commands/media.js';
import { correctText, initialPrompt, projectTerms, readingsOf, similarity, soundKey, termsFromScript, termsFromTitle } from '@video/cli/glossary.js';

describe('glossary: sound keys and readings', () => {
  it('reads Latin words, letters, digits and hiragana as katakana', () => {
    expect(soundKey('クロード、M、P')).toBe('クロードエムピー');
    expect(soundKey('CLAUDE.md')).toBe('クロードエムディー');
    expect(soundKey('Claude Code')).toBe('クロードコード');
    expect(soundKey('くろーど')).toBe('クロード');
    expect(soundKey('v2')).toBe('ブイニ');
    expect(readingsOf({ term: 'CLAUDE.md' })).toEqual(['クロードエムディー', 'クロードドットエムディー']);
    expect(readingsOf({ term: 'Go', reading: 'ゴーラング' })).toEqual(['ゴーラング', 'ジーオー']);
    expect(readingsOf({ term: 'a' })).toEqual([]);   // エー is too short to match safely
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', '')).toBe(1);
    expect(similarity('abcd', 'abxd')).toBe(0.75);
  });
});

describe('glossary: correctText', () => {
  const terms = [{ term: 'CLAUDE.md' }, { term: 'Claude Code' }, { term: 'Ferret', reading: 'ソロカット' }];

  it('fixes near-misses by reading and records what changed', () => {
    const r = correctText('まずクロード、M、Pを開きます', terms);
    expect(r.text).toBe('まずCLAUDE.mdを開きます');
    expect(r.corrections).toEqual([{ from: 'クロード、M、P', to: 'CLAUDE.md', score: expect.any(Number) }]);
    expect(r.corrections[0]!.score).toBeGreaterThanOrEqual(0.75);
    expect(correctText('クロードコードで書きます', terms).text).toBe('Claude Codeで書きます');
    expect(correctText('そろかっとを使う', terms).text).toBe('Ferretを使う');
    expect(correctText('Claude CodeとCLAUDE.md', terms)).toEqual({ text: 'Claude CodeとCLAUDE.md', corrections: [] });   // exact spellings stay
    expect(correctText('CLAUDE Codeの設定', terms)).toEqual({ text: 'Claude Codeの設定', corrections: [{ from: 'CLAUDE Code', to: 'Claude Code', score: 1 }] });
    expect(correctText('CLAUDECodeで', terms).text).toBe('Claude Codeで');
  });

  it('leaves unrelated text alone and handles several matches without overlap', () => {
    expect(correctText('今日は天気がいいですね', terms).corrections).toEqual([]);
    expect(correctText('クロードだけ', terms).corrections).toEqual([]);   // a prefix alone is not enough
    const r = correctText('クロードコードとクロードエムディー', terms);
    expect(r.text).toBe('Claude CodeとCLAUDE.md');
    expect(r.corrections.map((c) => c.to)).toEqual(['Claude Code', 'CLAUDE.md']);
    expect(correctText('', terms)).toEqual({ text: '', corrections: [] });
    expect(correctText('クロードコード', []).corrections).toEqual([]);
  });
});

describe('glossary: sources and the whisper prompt', () => {
  it('collects terms from the title, a script and the template; prompt stays short', () => {
    expect(termsFromTitle('Claude Code の設定は3つだけ')).toEqual(['Claude Code']);
    expect(termsFromTitle('CLAUDE.md と MCP 入門')).toEqual(['CLAUDE.md', 'MCP']);
    expect(termsFromTitle('設定のコツ')).toEqual([]);
    expect(termsFromScript('`settings.json` を開き、AGENTS.md と Claude Code を使う。The Next Step')).toEqual(
      expect.arrayContaining(['settings.json', 'AGENTS.md', 'Claude Code', 'The Next Step']));
    const dir = mkdtempSync(join(tmpdir(), 'ferret-video-gl-'));
    try {
      writeFileSync(join(dir, 'script.md'), '`CLAUDE.md` を書く');
      const t = projectTerms(dir, [{ term: 'Claude Code' }, { term: 'claude code' }], [{ term: 'MCP', reading: 'エムシーピー' }]);
      expect(t.map((x) => x.term)).toEqual(['Claude Code', 'MCP', 'CLAUDE.md']);
      const p = initialPrompt('えーと、', t, 'ja');
      expect(p).toBe('えーと、用語: Claude Code、MCP、CLAUDE.md。');
      expect(initialPrompt('base', [], 'en')).toBe('base');
      const long = initialPrompt('', Array.from({ length: 100 }, (_, i) => ({ term: `Term${i}` })), 'en');
      expect(long.length).toBeLessThan(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('preview spec', () => {
  const spec = (note: string) => ({ check: 'spec' as const, status: 'fail' as const, note });
  it('a preview at reduced size passes when the aspect ratio matches; real problems stay', () => {
    expect(previewSpec(spec('size 540x960 (expected 1080x1920)'))).toMatchObject({ status: 'pass' });
    expect(previewSpec(spec('size 960x540 (expected 1080x1920)'))).toMatchObject({ status: 'fail' });
    expect(previewSpec(spec('size 540x960 (expected 1080x1920); audio codec mp3 (expected aac)'))).toEqual(spec('audio codec mp3 (expected aac)'));
    const other = { check: 'loudness' as const, status: 'fail' as const, note: 'size 1x1 (expected 2x2)' };
    expect(previewSpec(other)).toBe(other);
    const pass = { check: 'spec' as const, status: 'pass' as const, note: 'ok' };
    expect(previewSpec(pass)).toBe(pass);
  });
});

describe('init seeds meta.glossary from the title', () => {
  it('Latin product names in the title become glossary terms', async () => {
    const { Sandbox } = await import('./helpers.js');
    const { readFileSync } = await import('node:fs');
    const sb = new Sandbox();
    try {
      const dir = join(sb.root, 'v');
      expect((await sb.run(['init', dir, '--template', 'talk', '--title', 'Claude Code と CLAUDE.md の使い方', '--no-git', '--json'])).code).toBe(0);
      const tl = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
      expect(tl.meta.glossary).toEqual([{ term: 'Claude Code' }, { term: 'CLAUDE.md' }]);
      const d2 = join(sb.root, 'w');
      await sb.run(['init', d2, '--template', 'talk', '--title', '設定のコツ', '--no-git', '--json']);
      expect(JSON.parse(readFileSync(join(d2, 'timeline.json'), 'utf8')).meta.glossary).toEqual([]);
    } finally {
      sb.dispose();
    }
  });
});

describe('glossary terms stay whole through the CLI caption paths', () => {
  const decided = { by: 'agent', reason: 't' };
  const fps = { num: 30, den: 1 };
  // ~0.3 s per word; long sentences so captions must break somewhere near the terms
  const sentence = ['今日は', 'とても', '大事な', '話で', 'まず', 'CLAUDE', '.', 'md', 'という', 'ファイルを', '開いて', 'から', '設定を', '書いて', 'いきます', 'そして',
    'クロード', '、', 'M', '、', 'P', 'を', 'もう一度', '確認して', 'Claude', 'Code', 'で', '読み込みます', '最後に', 'CLAUDE', '.', 'md', 'を', '保存します'];
  const words = sentence.map((w, i) => ({ w, start: i * 0.3, end: i * 0.3 + 0.28 }));

  async function project(sb: { run: (a: string[], o?: { cwd?: string }) => Promise<{ code: number; json: any; stdout: string; stderr: string }>; root: string }, maxChars?: number) {
    const dir = join(sb.root, 'p');
    expect((await sb.run(['init', dir, '--template', 'talk', '--title', 'CLAUDE.md と Claude Code', '--no-git', '--json'])).code).toBe(0);
    const { mkdirSync, writeFileSync: wf } = await import('node:fs');
    if (maxChars) {
      mkdirSync(join(dir, 'templates', 'talk'), { recursive: true });
      wf(join(dir, 'templates', 'talk', 'template.yaml'), JSON.stringify({ id: 'talk', extends: 'talk', captions: { maxCharsPerLine: maxChars, maxLines: 1 } }));
    }
    const cam = { kind: 'camera', path: 'media/a.mp4', take: 'take_1', role: 'front', fps, size: { width: 1920, height: 1080 }, offset: 0 };
    const ops = [
      { op: 'addSource', id: 'cam', source: cam },
      { op: 'setOutline', outline: [{ id: 'ch_1', title: 'a', start: 0, end: 330, points: [], importance: 'core' }] },
      { op: 'addSegment', segment: { id: 'seg_1', range: { start: 0, end: 0 }, src: { from: 0, to: 330, take: 'take_1' }, text: 'x', chapter: 'ch_1', role: 'explain', video: { layout: 'camera-full', camera: 'cam' }, decided } },
    ];
    expect((await sb.run(['edit', '--ops', JSON.stringify(ops), '--json'], { cwd: dir })).json.ok).toBe(true);
    mkdirSync(join(dir, 'derived', 'transcripts'), { recursive: true });
    wf(join(dir, 'derived', 'transcripts', 'main.json'), JSON.stringify({ schema: 1, engine: 'whisper.cpp', model: 'x', language: 'ja', take: 'take_1', source: 'cam', words, createdAt: '' }));
    return dir;
  }

  const assertWhole = (caps: { text: string; lines: string[] }[]) => {
    const all = caps.map((c) => c.text).join('|');
    // never split across captions or lines
    for (const c of caps) {
      for (const l of c.lines) expect(l, all).not.toMatch(/^\.?md|CLAUDE\.?$|^Code|Claude$|^、?[MP]/);
      expect(c.text, all).not.toMatch(/^\.?md|CLAUDE\.?$|^Code\b|Claude $/);
    }
    expect(all.match(/CLAUDE\.md/g)?.length, all).toBe(3);   // two spoken right + the respelled クロード、M、P
    expect(all, all).toContain('Claude Code');
  };

  it.each([undefined, 6, 10])('captions build (main), maxCharsPerLine %s', async (maxChars) => {
    const { Sandbox } = await import('./helpers.js');
    const { readFileSync } = await import('node:fs');
    const sb = new Sandbox();
    try {
      const dir = await project(sb, maxChars);
      const r = await sb.run(['captions', 'build', '--json'], { cwd: dir });
      expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true });
      const caps = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')).captions;
      assertWhole(caps);
      // the misheard span was kept in one caption and respelled
      const fixed = caps.find((c: { corrections?: { from: string }[] }) => c.corrections?.some((x) => x.from === 'クロード、M、P'));
      expect(fixed?.text).toContain('CLAUDE.md');
      expect(readFileSync(join(dir, 'captions', 'main.srt'), 'utf8')).not.toMatch(/CLAUDE\.\s*\n\s*md/);
    } finally {
      sb.dispose();
    }
  });

  it('captionGlossary: the terms plus the misheard spans to keep whole', async () => {
    const { captionGlossary } = await import('@video/cli/commands/media.js');
    expect(captionGlossary(['まず', 'クロード', '、', 'M', '、', 'P', 'を'], [{ term: 'CLAUDE.md' }], 'ja')).toEqual(['CLAUDE.md', 'クロード、M、P']);
    expect(captionGlossary(['a'], [], 'ja')).toEqual([]);
    expect(captionGlossary(['open', 'claude', 'code', 'now'], [{ term: 'Claude Code' }], 'en')).toEqual(['Claude Code']);
  });
});
