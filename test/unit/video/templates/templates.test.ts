import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_MD, STEP_DEPS, STEP_IDS, TemplateError, TemplateFileSchema, builtinTemplatesDir, deepMerge, generateAgentsMd, initialStatus, listTemplates,
  listTemplatesWithErrors, loadTemplate, nextStep, stepText, toRational, type NextContext, type PipelineStep, type StepId, type StepState, type Template,
} from '@video/templates';

let home: string;
const saved = { home: process.env.FERRET_VIDEO_HOME, tpl: process.env.FERRET_VIDEO_TEMPLATES_DIR };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ferret-video-tpl-'));
  process.env.FERRET_VIDEO_HOME = home;
  delete process.env.FERRET_VIDEO_TEMPLATES_DIR;
});
afterEach(() => {
  for (const [k, v] of [['FERRET_VIDEO_HOME', saved.home], ['FERRET_VIDEO_TEMPLATES_DIR', saved.tpl]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function writeTemplate(root: string, id: string, yaml: string, files: Record<string, string> = {}) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'template.yaml'), yaml);
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return dir;
}

describe('built-in templates', () => {
  const ALIASES = { talk: 'base-horizontal', 'tech-tutorial': 'tech', 'tech-short': 'tech', 'talk-youtube': 'talk', 'talk-tiktok': 'talk', 'shorts-from-long': 'talk' };

  it('resolves src/video/builtin-templates in development', () => {
    expect(basename(builtinTemplatesDir())).toBe('builtin-templates');
    expect(existsSync(join(builtinTemplatesDir(), 'tech', 'template.yaml'))).toBe(true);
  });

  it('lists exactly one template (tech) without errors; hides bases and aliases', () => {
    const r = listTemplatesWithErrors();
    expect(r.errors.map((e) => e.message)).toEqual([]);
    expect(r.templates.map((t) => t.id)).toEqual(['tech']);
    const all = listTemplatesWithErrors({ includeAbstract: true }).templates.map((t) => t.id);
    for (const id of ['base-horizontal', ...Object.keys(ALIASES)]) expect(all).toContain(id);
    expect(all).not.toContain('base-vertical');
  });

  it.each(['tech', 'talk'])('%s is complete and makes one 16:9 video', (id) => {
    const t = loadTemplate(id);
    expect(t.abstract).toBe(false);
    for (const p of ['rough-cut', 'multicam', 'captions', 'sfx', 'thumbnail', 'metadata']) {
      expect(t.prompts[p], `${id} prompts/${p}.md`).toBeTruthy();
      expect(t.prompts[p]!.length).toBeGreaterThan(200);
    }
    expect(t.prompts.vertical).toBeUndefined();
    expect([t.canvas.width, t.canvas.height]).toEqual([1920, 1080]);
    expect(t.targets).toEqual(['youtube']);
    expect(t.outputs).toEqual({ youtube: { enabled: true } });
    expect(t.features.faceReframe).toBe(true);
    expect(t.pipeline).not.toContain('review');
    expect(t.pipeline.at(-3)).toBe('final');
    expect(t.canvas.fps).toEqual({ num: 30, den: 1 });
  });

  it.each(['tech', 'talk'])('%s rules and prompts: no vertical/3-video/announce wording; person centred; free illustration libraries', (id) => {
    const t = loadTemplate(id);
    const all = [t.rules, ...Object.values(t.prompts)].join('\n');
    for (const bad of ['3本', 'ferret-video derive', '--variant', 'vertical.md', 'Shorts', '告知', 'Instagram', '判定モデルの確信度']) expect(all, bad).not.toContain(bad);
    expect(t.rules).toContain('顔がカメラの枠');
    expect(t.prompts.multicam).toContain('main');
    expect(all).toContain('いらすとや');
    expect(all).toContain('クレジット');
    expect(t.prompts.thumbnail).toContain('API キー');
    expect(t.prompts.metadata).toContain('publish.json');
  });

  it.each(Object.entries(ALIASES))('old id %s is a hidden alias (chain %s)', (id, parent) => {
    const t = loadTemplate(id);
    expect(t.alias).toBe(true);
    expect(t.chain.slice(0, 2)).toEqual([id, parent]);
    expect(t.outputs).toEqual({ youtube: { enabled: true } });
  });

  it('older templates with vertical outputs still load (extra keys ignored)', () => {
    const root = join(home, 'templates');
    writeTemplate(root, 'old', 'id: old\nversion: 1\nextends: tech\noutputs:\n  youtube: {}\n  tiktok: { derive: vertical, maxSec: 90, sameAs: youtube }\n');
    const t = loadTemplate('old');
    expect(t.outputs).toEqual({ youtube: { enabled: true }, tiktok: { enabled: true } });
    expect(t.pipeline).toEqual(loadTemplate('tech').pipeline);
  });

  it('merges extends: child overrides keys, keeps the rest; arrays replace', () => {
    const t = loadTemplate('talk');
    expect(t.cut.silence).toEqual({ minMs: 400, padMs: 100, noiseDb: -35 }); // noiseDb from base
    expect(t.cut.fillers).toContain('えっと'); // from base
    expect(t.layouts.allowed).toEqual(['camera-full', 'scene']); // replaced
    expect(t.rules.indexOf('共通の方針')).toBeLessThan(t.rules.indexOf('語り動画（YouTube）の編集方針')); // base first
  });

  it('tech enables the tech features', () => {
    const t = loadTemplate('tech');
    expect(t.kind).toBe('tech');
    expect(t.features).toMatchObject({ autoZoom: true, keystrokes: true, cursorHighlight: true, piiMask: true, faceReframe: true });
    expect(t.checks).toContain('pii-on-screen');
    expect(t.layouts.default).toBe('screen-with-wipe');
    expect(t.layouts.allowed).toContain('camera-full');
  });

  it('sfx rules, zoom.followClicks and captionLook validate; bad values are rejected', () => {
    const tech = loadTemplate('tech');
    expect(tech.sfx?.rules.map((r) => r.on)).toEqual(['section', 'zoom-in', 'scene-in', 'emphasis']);
    expect(TemplateFileSchema.shape.sfx.unwrap().shape.rules.element.shape.on.options).toContain('zoom-in');
    expect(tech.zoom?.followClicks).toBe(true);
    expect(loadTemplate('talk').zoom).toBeUndefined();
    const base = { id: 'x', version: 1, name: { ja: 'x', en: 'x' }, kind: 'talk', targets: ['youtube'], canvas: { width: 1920, height: 1080, fps: 30 },
      record: { tracks: ['camera'] }, layouts: { default: 'camera-full', allowed: ['camera-full'] },
      cut: { silence: { minMs: 400, padMs: 100 }, fillers: [], retakes: 'keep-last', ngMarkers: 'cut' },
      captions: { style: 's', highlight: 'word', maxCharsPerLine: 20, maxLines: 2, emphasis: 'auto', position: { anchor: 'bottom', y: 0.9 }, burnIn: true },
      audio: { loudness: -14, truePeak: -1, denoise: 'light', bgm: { duckDb: -10 } },
      decisions: { cutKeep: { autoAbove: 0.8, autoBelow: 0.2 }, frameCheck: { passAbove: 0.5 } }, checks: [], pipeline: ['ingest', 'analyze', 'masks'] };
    expect(TemplateFileSchema.safeParse(base).success).toBe(true);
    expect(TemplateFileSchema.safeParse({ ...base, sfx: { rules: [{ on: 'cut', kind: 'pop', probability: 0.3 }], maxPerMin: 2 } }).success).toBe(true);
    expect(TemplateFileSchema.safeParse({ ...base, sfx: { rules: [{ on: 'explosion', kind: 'pop' }] } }).success).toBe(false);
    expect(TemplateFileSchema.safeParse({ ...base, sfx: { rules: [{ on: 'cut', kind: '' }] } }).success).toBe(false);
    expect(TemplateFileSchema.safeParse({ ...base, sfx: { rules: [{ on: 'cut', kind: 'pop', probability: 1.5 }] } }).success).toBe(false);
    expect(TemplateFileSchema.safeParse({ ...base, zoom: { followClicks: { scale: 1.4 } } }).success).toBe(true);
    expect(TemplateFileSchema.safeParse({ ...base, zoom: { followClicks: { scale: 9 } } }).success).toBe(false);
    expect(TemplateFileSchema.parse({ ...base, zoom: {} }).zoom?.followClicks).toBe(false);
    expect(TemplateFileSchema.safeParse({ ...base, captionLook: { size: 0.05, box: false, stroke: { color: '#000', widthRatio: 0.1 } } }).success).toBe(true);
    expect(TemplateFileSchema.safeParse({ ...base, captionLook: { size: -1, box: false } }).success).toBe(false);
    expect(TemplateFileSchema.safeParse({ ...base, pipeline: ['ingest', 'publish'] }).success).toBe(false);
    expect(TemplateFileSchema.safeParse({ ...base, pipeline: ['ingest', 'derive'] }).success).toBe(false);
  });

  it('initialStatus follows the template pipeline exactly', () => {
    expect(initialStatus(loadTemplate('tech')).map((s) => s.step)).toEqual(loadTemplate('tech').pipeline);
    expect(initialStatus({ pipeline: ['ingest', 'final'] })).toEqual([{ step: 'ingest', state: 'todo' }, { step: 'final', state: 'todo' }]);
  });
});

describe('loader errors and overrides', () => {
  it('project → user → built-in overrides of the same id chain without a cycle', () => {
    const user = join(home, 'templates', 'talk');
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, 'template.yaml'), 'id: talk\nextends: talk\ncaptions: { maxLines: 1 }\n');
    const proj = join(home, 'proj', 'templates', 'talk');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'template.yaml'), 'id: talk\nextends: talk\ncaptions: { maxCharsPerLine: 18 }\n');
    const t = loadTemplate('talk', { extraDirs: [join(home, 'proj', 'templates')] });
    expect(t.captions).toMatchObject({ maxLines: 1, maxCharsPerLine: 18 });
    expect(t.chain.length).toBeGreaterThanOrEqual(4);   // project, user, built-in talk, base
    expect(loadTemplate('talk').captions.maxLines).toBe(1);
  });

  it('rejects unknown and malformed ids', () => {
    expect(() => loadTemplate('nope-nothing')).toThrow(/not found/);
    expect(() => loadTemplate('../etc')).toThrow(/invalid template id/);
  });

  it('reports schema errors with paths', () => {
    process.env.FERRET_VIDEO_TEMPLATES_DIR = join(home, 'tpl');
    writeTemplate(join(home, 'tpl'), 'bad', 'id: bad\nversion: 1\nname: { ja: x, en: x }\nkind: video\n');
    try {
      loadTemplate('bad');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      const paths = (e as TemplateError).issues.map((i) => i.path);
      expect(paths).toContain('kind');
      expect(paths).toContain('pipeline');
    }
    expect(listTemplatesWithErrors().errors).toHaveLength(1);
    expect(listTemplates()).toEqual([]);
  });

  it('rejects invalid YAML, non-mapping YAML and id/folder mismatch', () => {
    process.env.FERRET_VIDEO_TEMPLATES_DIR = join(home, 'tpl');
    writeTemplate(join(home, 'tpl'), 'a', 'id: [unclosed');
    writeTemplate(join(home, 'tpl'), 'b', '- 1\n- 2\n');
    writeTemplate(join(home, 'tpl'), 'c', 'id: other\nextends: talk-youtube\n');
    expect(() => loadTemplate('a')).toThrow(/cannot read/);
    expect(() => loadTemplate('b')).toThrow(/mapping/);
    expect(() => loadTemplate('c')).toThrow(/extends unknown|must match/);
  });

  it('detects extends cycles and unknown parents', () => {
    const root = join(home, 'templates');
    writeTemplate(root, 'x', 'id: x\nextends: y\n');
    writeTemplate(root, 'y', 'id: y\nextends: x\n');
    writeTemplate(root, 'z', 'id: z\nextends: does-not-exist\n');
    expect(() => loadTemplate('x')).toThrow(/cycle/);
    expect(() => loadTemplate('z')).toThrow(/unknown template "does-not-exist"/);
  });

  it('a user template extends a built-in and overrides prompts', () => {
    const root = join(home, 'templates');
    const dir = writeTemplate(root, 'my-talk', 'id: my-talk\nversion: 2\nextends: talk-youtube\nname: { ja: 自分用, en: Mine }\ncaptions: { maxCharsPerLine: 18 }\n', {
      'rules.md': '自分のルール',
      'prompts/captions.md': '自分の字幕ルール',
    });
    const t = loadTemplate('my-talk');
    expect(t.dir).toBe(dir);
    expect(t.version).toBe('2');
    expect(t.captions.maxCharsPerLine).toBe(18);
    expect(t.captions.maxLines).toBe(2);
    expect(t.prompts.captions).toBe('自分の字幕ルール');
    expect(t.promptFiles.captions).toBe(join(dir, 'prompts', 'captions.md'));
    expect(t.prompts['rough-cut']).toContain('粗カット'); // inherited
    expect(t.rules.endsWith('自分のルール')).toBe(true);
    expect(t.chain).toEqual(['my-talk', 'talk-youtube', 'talk', 'base-horizontal']);
    expect(listTemplates().map((x) => x.id)).toContain('my-talk');
    expect(t.alias).toBe(false); // alias is not inherited
  });

  it('a user template with a built-in id shadows it and may extend it', () => {
    writeTemplate(join(home, 'templates'), 'talk-youtube', 'id: talk-youtube\nextends: talk-youtube\nversion: 9\n');
    const t = loadTemplate('talk-youtube');
    expect(t.version).toBe('9');
    expect(t.chain).toEqual(['talk-youtube', 'talk-youtube', 'talk', 'base-horizontal']);
    expect(listTemplates().filter((x) => x.id === 'talk-youtube')).toHaveLength(1); // the user's copy is not an alias
  });

  it('extra dirs (project templates) come first', () => {
    const proj = join(home, 'proj-templates');
    writeTemplate(proj, 'talk-youtube', 'id: talk-youtube\nextends: talk-youtube\nversion: p\n');
    expect(loadTemplate('talk-youtube', { extraDirs: [proj] }).version).toBe('p');
  });

  it('validates semantic rules: default layout allowed, thresholds ordered, unique pipeline', () => {
    const root = join(home, 'templates');
    writeTemplate(root, 'l', 'id: l\nextends: talk-youtube\nlayouts: { default: split-v, allowed: [camera-full] }\n');
    writeTemplate(root, 'd', 'id: d\nextends: talk-youtube\ndecisions: { cutKeep: { autoAbove: 0.2, autoBelow: 0.8 } }\n');
    writeTemplate(root, 'p', 'id: p\nextends: talk-youtube\npipeline: [ingest, ingest]\n');
    expect(() => loadTemplate('l')).toThrow(/layouts.default/);
    expect(() => loadTemplate('d')).toThrow(/autoBelow/);
    expect(() => loadTemplate('p')).toThrow(/duplicate/);
  });

  it('fps notation', () => {
    expect(toRational(30)).toEqual({ num: 30, den: 1 });
    expect(toRational(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(toRational(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(toRational(12.5)).toEqual({ num: 12500, den: 1000 });
  });

  it('deepMerge', () => {
    expect(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] }, d: 1 })).toEqual({ a: { b: 1, c: [2] }, d: 1 });
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe('generateAgentsMd', () => {
  const t = () => loadTemplate('talk-youtube');

  it('Japanese: role, first commands, rules, rules.md, cheat sheet, handoff', () => {
    const md = generateAgentsMd(t(), { dir: '/p', title: '設定の3つのコツ', lang: 'ja' });
    expect(md).toContain('# 設定の3つのコツ — エージェントへの指示書');
    expect(md).toContain('あなたはこのプロジェクトの動画編集者です');
    expect(md).toContain('`talk-youtube`');
    expect(md).toMatch(/ferret-video status --json\nferret-video next --json/);
    expect(md).toContain('`media/` の中は変更しない');
    expect(md).toContain('ferret-video validate');
    expect(md).toContain('.ferret-video/questions.md');
    expect(md).toContain('語り動画（YouTube）の編集方針'); // rules.md text
    expect(md).toContain('共通の方針（横型）'); // base rules too
    expect(md).toContain('| `ferret-video edit --ops ops.json` |');
    expect(md).toContain('"state": "needs-human"');
    expect(md).toContain('.ferret-video/handoff.md');
    expect(md).toContain('prompts/rough-cut.md');
    // every pipeline step is listed in order
    let last = -1;
    for (const s of t().pipeline) {
      const i = md.indexOf(`**${s}**`);
      expect(i, s).toBeGreaterThan(last);
      last = i;
    }
    // pipes inside commands are escaped so the table does not break
    expect(md).toContain('ferret-video past list\\|search\\|show\\|timeline');
  });

  it('English output when the project language is en', () => {
    const md = generateAgentsMd(t(), { dir: '/p', title: 'Three tips', lang: 'en' });
    expect(md).toContain('You are the video editor of this project');
    expect(md).toContain('Never modify anything in `media/`');
    expect(md).toContain('Never publish');
    expect(md).not.toContain('あなたは');
  });

  it('CLAUDE.md only imports AGENTS.md', () => {
    expect(CLAUDE_MD).toBe('@AGENTS.md\n');
  });
});

describe('nextStep', () => {
  const tpl = (): Template => loadTemplate('talk-youtube');
  const ctx = (o: Partial<NextContext> = {}): NextContext => ({ hasTakes: true, hasTranscript: true, openItems: 0, lastCheckFailed: 0, ...o });
  const status = (t: Template, done: PipelineStep[], extra: Partial<Record<PipelineStep, StepState['state']>> = {}): StepState[] =>
    t.pipeline.map((step) => ({ step, state: extra[step] ?? (done.includes(step) ? 'done' : 'todo') }));
  const upTo = (t: Template, step: PipelineStep): PipelineStep[] => t.pipeline.slice(0, t.pipeline.indexOf(step));
  /** A template with a human review step (older projects / user templates). */
  const withReview = (): Template => ({ ...tpl(), pipeline: ['ingest', 'sync', 'transcribe', 'rough-cut', 'captions', 'preview', 'check', 'review', 'final', 'thumbnail', 'metadata'] });

  it('initialStatus is all todo', () => {
    expect(initialStatus(tpl()).every((s) => s.state === 'todo')).toBe(true);
  });

  it('no takes → ingest needs a human', () => {
    const n = nextStep(tpl(), initialStatus(tpl()), ctx({ hasTakes: false }));
    expect(n).toMatchObject({ step: 'ingest', state: 'needs-human' });
    expect(n.commands[0]).toContain('ferret-video import');
  });

  it('takes but nothing done → ingest ready', () => {
    expect(nextStep(tpl(), initialStatus(tpl()), ctx({ hasTranscript: false }))).toMatchObject({ step: 'ingest', state: 'ready' });
  });

  it('walks the pipeline in order, one step at a time', () => {
    const t = tpl();
    for (const step of t.pipeline) {
      const n = nextStep(t, status(t, upTo(t, step)), ctx());
      expect(n.step, `after ${upTo(t, step).at(-1)}`).toBe(step);
      expect(n.state).toBe('ready');
      expect(n.commands.length).toBeGreaterThan(0);
    }
  });

  it('includes the template prompt for steps that have one', () => {
    const t = tpl();
    expect(nextStep(t, status(t, upTo(t, 'rough-cut')), ctx()).prompt).toBe(t.promptFiles['rough-cut']);
    expect(nextStep(t, status(t, upTo(t, 'preview')), ctx()).prompt).toBeUndefined();
  });

  it('transcribe marked done without a transcript → transcribe again', () => {
    const t = tpl();
    const n = nextStep(t, status(t, upTo(t, 'rough-cut')), ctx({ hasTranscript: false }));
    expect(n).toMatchObject({ step: 'transcribe', state: 'ready' });
  });

  it('rough-cut todo without transcript (pipeline without transcribe) → transcribe', () => {
    const t = { ...tpl(), pipeline: ['ingest', 'rough-cut'] as StepId[] };
    expect(nextStep(t, status(t, ['ingest']), ctx({ hasTranscript: false })).step).toBe('transcribe');
  });

  it('rough-cut needs-human → wait, but offer captions meanwhile with blocking ids', () => {
    const t = tpl();
    const n = nextStep(t, status(t, upTo(t, 'rough-cut'), { 'rough-cut': 'needs-human' }), ctx({ openItems: 2, openItemRefs: ['seg_14', 'seg_22'] }));
    expect(n).toMatchObject({ step: 'rough-cut', state: 'needs-human', meanwhile: 'captions', blocking: ['seg_14', 'seg_22'] });
    expect(n.commands).toEqual(['ferret-video captions build --json', expect.any(String)]);
  });

  it('rough-cut done with open items still blocks; 0 open items passes', () => {
    const t = tpl();
    const st = status(t, upTo(t, 'multicam'));
    expect(nextStep(t, st, ctx({ openItems: 1 })).state).toBe('needs-human');
    expect(nextStep(t, st, ctx({ openItems: 0 })).step).toBe('multicam');
  });

  it('autopilot never waits on a needs-human step (rough-cut, sync, check, review): it stays 要確認 and the run goes on', () => {
    const t = tpl();
    const rc = nextStep(t, status(t, upTo(t, 'rough-cut'), { 'rough-cut': 'needs-human' }), ctx({ autopilot: true, openItems: 3 }));
    expect(rc.step).toBe('multicam');
    expect(nextStep(t, status(t, ['ingest'], { sync: 'needs-human' }), ctx({ autopilot: true })).step).toBe('analyze');
    const rv = withReview();
    expect(nextStep(rv, status(rv, upTo(rv, 'final'), { review: 'needs-human' }), ctx({ autopilot: true })).step).toBe('final');
    // a human-driven run waits and says where to look; meanwhile transcription can run (it does not depend on sync)
    const sync = nextStep(t, status(t, ['ingest'], { sync: 'needs-human' }), ctx());
    expect(sync).toMatchObject({ step: 'sync', state: 'needs-human', meanwhile: 'transcribe' });
    expect(sync.do).toContain('編集画面の「要確認」');
    expect(sync.do).toContain('--autopilot');
    expect(sync.do).not.toContain('「確認」画面');
    expect(nextStep(t, status(t, ['ingest'], { sync: 'needs-human' }), ctx({ lang: 'en' })).do).toMatch(/Edit screen.*On autopilot/);
  });

  it('only the settings stopBefore list stops autopilot', () => {
    const t = tpl();
    const n = nextStep(t, status(t, upTo(t, 'final')), ctx({ autopilot: true, stopBefore: ['final'] }));
    expect(n).toMatchObject({ step: 'final', state: 'needs-human' });
  });

  it('check failed → check again with preview first; 0 failures passes', () => {
    const t = tpl();
    const st = status(t, upTo(t, 'final'));
    const n = nextStep(t, st, ctx({ lastCheckFailed: 2 }));
    expect(n).toMatchObject({ step: 'check', state: 'ready' });
    expect(n.commands).toContain('ferret-video check --json');
    expect(n.do).toContain('ferret-video step check needs-human');
    expect(nextStep(t, st, ctx({ lastCheckFailed: 0 }))).toMatchObject({ step: 'final', state: 'ready' });
  });

  it('a check the agent cannot fix (needs-human) does not stop autopilot; it does stop a human-driven run', () => {
    const t = tpl();
    const st = status(t, upTo(t, 'final'), { check: 'needs-human' });
    expect(nextStep(t, st, ctx({ autopilot: true, lastCheckFailed: 1 })).step).toBe('final');
    expect(nextStep(t, st, ctx({ lastCheckFailed: 1 }))).toMatchObject({ step: 'check', state: 'needs-human' });
  });

  it('final comes right after check (no human review step); one command per target', () => {
    const t = tpl();
    const n = nextStep(t, status(t, upTo(t, 'final')), ctx());
    expect(n.step).toBe('final');
    expect(n.commands).toEqual(['ferret-video render --final --target youtube --json']);
  });

  it('a template with review: waits for a human; autopilot skips to final', () => {
    const t = withReview();
    const st = status(t, upTo(t, 'review'));
    expect(nextStep(t, st, ctx()).state).toBe('needs-human');
    const ap = nextStep(t, st, ctx({ autopilot: true }));
    expect(ap.step).toBe('final');
    expect(nextStep(t, status(t, upTo(t, 'final')), ctx()).step).toBe('final');
  });

  it('autopilot stops before steps listed in stopBefore', () => {
    const t = tpl();
    const n = nextStep(t, status(t, upTo(t, 'final')), ctx({ autopilot: true, stopBefore: ['final'] }));
    expect(n).toMatchObject({ step: 'final', state: 'needs-human' });
  });

  it('running steps are resumed', () => {
    const t = tpl();
    const n = nextStep(t, status(t, ['ingest'], { sync: 'running' }), ctx());
    expect(n).toMatchObject({ step: 'sync', state: 'ready' });
  });

  it('skipped counts as passed', () => {
    const t = tpl();
    const st = status(t, upTo(t, 'captions'), { multicam: 'skipped' });
    expect(nextStep(t, st, ctx()).step).toBe('captions');
  });

  it('everything done → done; English text; never asks to publish', () => {
    const t = tpl();
    const n = nextStep(t, status(t, t.pipeline), ctx({ lang: 'en' }));
    expect(n).toMatchObject({ step: 'done', state: 'done', commands: [] });
    expect(n.why).toMatch(/video is finished/);
    expect(n.do).toMatch(/Do not publish/);
    expect(nextStep(t, status(t, t.pipeline), ctx()).why).toContain('投稿画面');
  });

  it('a needs-human step note becomes the reason', () => {
    const t = tpl();
    const st = status(t, ['ingest']);
    st[1] = { step: 'sync', state: 'needs-human', note: '同期の信頼度が 0.41' };
    expect(nextStep(t, st, ctx()).why).toBe('同期の信頼度が 0.41');
  });

  it('missing status entries count as todo; unknown steps are ignored', () => {
    expect(nextStep(tpl(), [{ step: 'ingest', state: 'done' }], ctx()).step).toBe('sync');
    expect(STEP_IDS.length).toBe(16);
  });

  it('multicam passes by itself with fewer than two cameras', () => {
    const t = loadTemplate('talk');
    const upToMulticam = status(t, ['ingest', 'sync', 'analyze', 'transcribe', 'rough-cut']);
    expect(nextStep(t, upToMulticam, ctx({ cameras: 2 })).step).toBe('multicam');
    expect(nextStep(t, upToMulticam, ctx({ cameras: 1 })).step).toBe('captions');
    expect(nextStep(t, upToMulticam, ctx({ cameras: 0 })).step).toBe('captions');
    expect(nextStep(t, upToMulticam, ctx()).step).toBe('multicam');   // unknown → ask
  });

  it('round-5 steps: analyze after sync, masks before preview (tech), commands name the new CLI', () => {
    const tech = loadTemplate('tech');
    const p = tech.pipeline;
    expect(p.indexOf('analyze')).toBe(p.indexOf('sync') + 1);
    expect(p.indexOf('masks')).toBeLessThan(p.indexOf('preview'));
    expect(p.indexOf('masks')).toBeGreaterThan(p.indexOf('layout'));
    expect(loadTemplate('talk').pipeline).not.toContain('masks');
    expect(stepText('masks', 'ja').commands[0]).toBe('ferret-video masks from-analysis --json');
    expect(stepText('sfx', 'en').commands[0]).toBe('ferret-video sfx apply --json');
    expect(stepText('layout', 'en').commands[0]).toBe('ferret-video tracks apply --json');
    expect(stepText('multicam', 'en').commands[0]).toBe('ferret-video multicam material --json');
    expect(stepText('analyze', 'ja').commands).toEqual(['ferret-video analyze --json']);
    // masks waits for analyze and rough-cut
    expect(STEP_DEPS.masks).toEqual(['rough-cut', 'analyze']);
    expect(STEP_DEPS.preview).toContain('masks');
  });

  describe('publish.json (metadata / thumbnail)', () => {
    const pub = (o: Partial<NonNullable<NextContext['publish']>> = {}) => ({ valid: true, thumbnail: true, ...o });

    it('metadata and thumbnail pass by the file even when nobody marked them done', () => {
      const t = tpl();
      const st = status(t, upTo(t, 'thumbnail'));
      expect(nextStep(t, st, ctx({ publish: pub() })).step).toBe('done');
      expect(nextStep(t, st, ctx({ publish: pub({ thumbnail: false }) }))).toMatchObject({ step: 'thumbnail', state: 'ready' });
      expect(nextStep(t, st, ctx({ publish: pub({ valid: false, problems: ['title is empty'] }) }))).toMatchObject({ step: 'metadata', state: 'ready' });
      expect(nextStep(t, st, ctx({ publish: pub({ valid: false, problems: ['title is empty'] }) })).why).toContain('title is empty');
    });

    it('marked done but the file is missing or broken → do it again', () => {
      const t = tpl();
      const st = status(t, t.pipeline);
      expect(nextStep(t, st, ctx({ publish: pub({ valid: false }) }))).toMatchObject({ step: 'metadata', state: 'ready' });
      expect(nextStep(t, st, ctx({ publish: pub({ thumbnail: false }) }))).toMatchObject({ step: 'thumbnail', state: 'ready' });
      expect(nextStep(t, st, ctx({ publish: pub({ thumbnail: false }), lang: 'en' })).why).toMatch(/thumbnail/);
    });

    it('skipped thumbnail passes without an image; without publish info the status decides', () => {
      const t = tpl();
      const st = status(t, t.pipeline, { thumbnail: 'skipped' });
      expect(nextStep(t, st, ctx({ publish: pub({ thumbnail: false }) })).step).toBe('done');
      expect(nextStep(t, status(t, t.pipeline), ctx()).step).toBe('done');
    });

    it('the steps name publish.json, meta check and thumb pick; prompts/metadata.md is attached', () => {
      const t = tpl();
      const m = nextStep(t, status(t, upTo(t, 'metadata')), ctx({ publish: pub({ valid: false }) }));
      expect(m.do).toContain('publish.json');
      expect(m.commands).toContain('ferret-video meta check --json');
      expect(m.prompt).toBe(t.promptFiles.metadata);
      const th = nextStep(t, status(t, upTo(t, 'thumbnail')), ctx({ publish: pub({ thumbnail: false }) }));
      expect(th.commands.some((c) => c.startsWith('ferret-video thumb pick'))).toBe(true);
      expect(stepText('thumbnail', 'ja').do).toContain('API キーは使わない');
    });

    it('AGENTS.md lists one video, publish.json and no derive/variant steps', () => {
      const md = generateAgentsMd(loadTemplate('tech'), { dir: '/p', title: 'x', lang: 'ja' });
      expect(md).toContain('publish.json');
      expect(md).not.toMatch(/derive(?!d)/);
      expect(md).not.toContain('--variant');
      expect(md).not.toContain('**publish**');
      expect(md).not.toContain('判定モデルの結果');
    });
  });
});

describe('nextStep never dead-ends', () => {
  const STATES: StepState['state'][] = ['todo', 'running', 'done', 'needs-human', 'skipped'];
  // a small deterministic PRNG so failures reproduce
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;

  it.each(['tech', 'talk', 'tech-tutorial', 'talk-tiktok', 'shorts-from-long'])('%s: every state gives a command or a human action', (id) => {
    const t = loadTemplate(id);
    const pipeline = t.pipeline;
    for (let k = 0; k < 400; k++) {
      const status = pipeline.map((step) => ({ step, state: pick(STATES), ...(rnd() < 0.2 ? { note: 'n' } : {}) }));
      const n = nextStep(t, status, {
        hasTakes: rnd() < 0.8, hasTranscript: rnd() < 0.7, openItems: rnd() < 0.3 ? 2 : 0, lastCheckFailed: rnd() < 0.3 ? 1 : 0,
        autopilot: rnd() < 0.5, stopBefore: rnd() < 0.5 ? ['final'] : [], lang: pick(['ja', 'en'] as const),
        ...(rnd() < 0.5 ? { publish: { valid: rnd() < 0.5, thumbnail: rnd() < 0.5 } } : {}),
        ...(rnd() < 0.5 ? { cameras: Math.floor(rnd() * 3) } : {}),
      });
      const where = `${id} #${k}: ${JSON.stringify(n)}`;
      expect(n.do.trim(), where).not.toBe('');
      expect(n.why.trim(), where).not.toBe('');
      if (n.state === 'ready') expect(n.commands.length, where).toBeGreaterThan(0);
      if (n.state === 'done') expect(n.step, where).toBe('done');
      for (const c of n.commands) expect(c, where).toMatch(/^ferret-video /);
    }
  });
});
