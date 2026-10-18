import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SETTINGS_SCHEMA_URL,
  DEFAULT_PROMPTS, PROMPT_IDS, SettingsError, SettingsSchema, applySetting, defaultPromptText, defaultSettings, diffSettings, getSetting,
  isPromptId, loadPrompts, loadPromptsWithErrors, loadSettings, loadSettingsWithErrors, parseCliValue, parseSettings, promptOverride,
  promptsFromSettings, renderPrompt, renderPromptById, saveSettings, setSetting, settingsHistoryPath, settingsJsonSchema, settingsPath,
  stripJsonComments, TIKTOK_PRIVACY, YOUTUBE_PRIVACY,
} from '@video/settings';

let home: string;
const saved = process.env.FERRET_VIDEO_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ferret-video-set-'));
  process.env.FERRET_VIDEO_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FERRET_VIDEO_HOME;
  else process.env.FERRET_VIDEO_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('defaults', () => {
  it('fills every section from an empty object', () => {
    const s = defaultSettings();
    expect(s.language).toBe('ja');
    expect(s.agents.order).toEqual(['claude', 'codex', 'gemini']);
    expect(s.agents.failover.enabled).toBe(true);
    expect(s.recording.camera).toEqual({ deviceId: 'default', width: 1920, height: 1080, fps: 30 });
    expect(s.decision.provider).toBe('off');
    expect(s.decision.limits).toEqual({ perProjectUsd: 2, perDayUsd: 5, perProjectCalls: 200 });
    expect(s.library.download).toBe('on-demand');
    expect(s.autopilot).toEqual({ autoStart: true, stopBefore: ['publish'], maxFixLoops: 3, notify: ['done', 'needs-human'], budget: { decisionUsd: 2 } });
    expect(s.prompts).toEqual({});
    expect(s.telemetry.crashReports).toBe(true);
    expect(s.updates).toEqual({ channel: 'stable', auto: true });
    // images are made inside the subscriptions: no API provider by default
    expect(s.imageGen).toEqual({ order: ['codex'], providers: { codex: { via: 'subscription' } } });
  });

  it('has no theme option', () => {
    expect(Object.keys(defaultSettings().appearance)).not.toContain('theme');
  });

  it('missing file → defaults without errors', () => {
    expect(loadSettingsWithErrors()).toEqual({ settings: defaultSettings(), errors: [] });
  });

  it('partially filled section keeps the rest of the defaults', () => {
    const s = SettingsSchema.parse({ recording: { camera: { fps: 60 } } });
    expect(s.recording.camera).toEqual({ deviceId: 'default', width: 1920, height: 1080, fps: 60 });
    expect(s.recording.hotkeys.markNg).toBe('CmdOrCtrl+Shift+N');
  });
});

describe('loading broken files', () => {
  it('invalid JSON → defaults + error', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(settingsPath(), '{ "language": "en", ');
    const r = loadSettingsWithErrors();
    expect(r.settings).toEqual(defaultSettings());
    expect(r.errors[0]!.message).toMatch(/invalid JSON/);
  });

  it('non-object JSON → defaults + error', () => {
    expect(parseSettings('[1,2]').errors[0]!.path).toBe('(root)');
    expect(parseSettings('null').settings).toEqual(defaultSettings());
  });

  it('an invalid section falls back to defaults but keeps valid ones', () => {
    const r = parseSettings(JSON.stringify({ language: 'en', recording: { camera: { fps: 31 } }, decision: { provider: 'ollama' } }));
    expect(r.settings.language).toBe('en');
    expect(r.settings.decision.provider).toBe('ollama');
    expect(r.settings.recording.camera.fps).toBe(30);
    expect(r.errors.map((e) => e.path)).toContain('recording.camera.fps');
  });

  it('invalid top-level value is reported with its path', () => {
    const r = parseSettings(JSON.stringify({ language: 'fr' }));
    expect(r.settings.language).toBe('ja');
    expect(r.errors[0]!.path).toBe('language');
  });

  it('accepts jsonc comments (but not inside strings)', () => {
    const r = parseSettings('{\n // comment\n "language": "en", /* block */ "agents": { "order": ["codex"] },\n "recording": { "hotkeys": { "markNg": "a//b" } } }');
    expect(r.errors).toEqual([]);
    expect(r.settings.language).toBe('en');
    expect(r.settings.recording.hotkeys.markNg).toBe('a//b');
    expect(stripJsonComments('"/* x */"')).toBe('"/* x */"');
  });

  it('unknown keys are dropped, not fatal', () => {
    expect(parseSettings(JSON.stringify({ foo: 1, appearance: { theme: 'light' } })).errors).toEqual([]);
  });
});

describe('save and history', () => {
  it('writes atomically with $schema and logs changes', () => {
    const s = defaultSettings();
    s.language = 'en';
    saveSettings(s);
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(raw.$schema).toBe(SETTINGS_SCHEMA_URL);
    expect(raw.language).toBe('en');
    expect(loadSettings().language).toBe('en');
    const lines = readFileSync(settingsHistoryPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).changes).toEqual([{ key: 'language', from: 'ja', to: 'en' }]);
  });

  it('does not log when nothing changed', () => {
    saveSettings(defaultSettings());
    expect(existsSync(settingsHistoryPath())).toBe(false);
  });

  it('refuses to save invalid settings', () => {
    const s = defaultSettings() as unknown as { language: string };
    s.language = 'xx';
    expect(() => saveSettings(s as never)).toThrow(SettingsError);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('diffSettings treats arrays as leaves', () => {
    expect(diffSettings({ a: { b: [1] } }, { a: { b: [1, 2] } })).toEqual([{ key: 'a.b', from: [1], to: [1, 2] }]);
  });
});

describe('get/set by dot path', () => {
  it('gets nested values and undefined for unknown keys', () => {
    expect(getSetting('decision.limits.perDayUsd')).toBe(5);
    expect(getSetting('agents.order.0')).toBe('claude');
    expect(getSetting('nope.nothing')).toBeUndefined();
    expect(getSetting('agents.order.x')).toBeUndefined();
  });

  it('sets, validates and persists', () => {
    const s = setSetting('recording.camera.fps', 60);
    expect(s.recording.camera.fps).toBe(60);
    expect(getSetting('recording.camera.fps')).toBe(60);
    setSetting('agents.order', ['codex', 'claude']);
    expect(loadSettings().agents.order).toEqual(['codex', 'claude']);
    setSetting('agents.order.1', 'gemini');
    expect(loadSettings().agents.order).toEqual(['codex', 'gemini']);
  });

  it('allows new keys inside records', () => {
    setSetting('imageGen.providers.mine', { via: 'api', apiKeyRef: 'mine' });
    expect(loadSettings().imageGen.providers.mine).toEqual({ via: 'api', apiKeyRef: 'mine' });
  });

  it('ui.layout and onboarding.completedAt (desktop)', () => {
    const d = defaultSettings();
    expect(d.ui.layout).toEqual({ sidebar: true, center: true, terminal: true });
    expect(d.onboarding.completedAt).toBeNull();
    expect(d.appearance.uiScale).toBe(1);
    expect(setSetting('ui.layout', { sidebar: false, center: true, terminal: true, sidebarWidth: 280, terminalWidth: 640 }).ui.layout.sidebarWidth).toBe(280);
    expect(setSetting('ui.layout.terminal', false).ui.layout).toMatchObject({ terminal: false, sidebarWidth: 280 });
    expect(setSetting('onboarding.completedAt', '2026-10-11T12:00:00+09:00').onboarding.completedAt).toBe('2026-10-11T12:00:00+09:00');
    expect(setSetting('onboarding.completedAt', null).onboarding.completedAt).toBeNull();
    expect(() => setSetting('onboarding.completedAt', 'yesterday')).toThrow(SettingsError);
    expect(() => setSetting('ui.layout.sidebarWidth', 10)).toThrow(SettingsError);
    expect(() => setSetting('ui.layout.sidebar', 'yes')).toThrow(SettingsError);
    expect(() => setSetting('appearance.uiScale', 3)).toThrow(SettingsError);
  });

  it('agents.order accepts any catalog agent id and custom ones', () => {
    expect(setSetting('agents.order', ['aider', 'claude', 'custom:mine']).agents.order).toEqual(['aider', 'claude', 'custom:mine']);
  });

  it('decision.provider accepts auto and the agent CLIs', () => {
    for (const v of ['auto', 'claude-cli', 'codex-cli', 'gemini-cli', 'off', 'ollama']) expect(setSetting('decision.provider', v).decision.provider).toBe(v);
  });

  it('rejects invalid values with issues', () => {
    try {
      setSetting('recording.camera.fps', 61);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsError);
      expect((e as SettingsError).issues[0]!.path).toBe('recording.camera.fps');
    }
    expect(() => setSetting('decision.limits.perDayUsd', -1)).toThrow(/invalid value/);
    expect(() => setSetting('language', 'de')).toThrow(SettingsError);
    expect(() => setSetting('agents.order', ['Not An Agent!'])).toThrow(SettingsError);
    expect(() => setSetting('decision.endpoint', 'not a url')).toThrow(SettingsError);
    expect(() => setSetting('decision.provider', 'chatgpt-web')).toThrow(SettingsError);
    expect(() => setSetting('decision.limits.perProjectCalls', 1.5)).toThrow(SettingsError);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('rejects unknown keys and malformed paths', () => {
    expect(() => setSetting('appearance.theme', 'light')).toThrow(/unknown setting/);
    expect(() => setSetting('bogus', 1)).toThrow(/unknown setting/);
    expect(() => setSetting('a..b', 1)).toThrow(/invalid key/);
    expect(() => setSetting('', 1)).toThrow(/invalid key/);
    expect(() => setSetting('.language', 'en')).toThrow(/invalid key/);
    expect(() => setSetting('$schema', 'x')).toThrow(SettingsError);
    expect(() => setSetting('agents.order.x', 'claude')).toThrow(/array index/);
    expect(() => applySetting(defaultSettings(), 'appearance.__proto__', {})).toThrow(SettingsError);
  });

  it('parseCliValue reads JSON when possible', () => {
    expect(parseCliValue('60')).toBe(60);
    expect(parseCliValue('true')).toBe(true);
    expect(parseCliValue('["a"]')).toEqual(['a']);
    expect(parseCliValue('hello')).toBe('hello');
    expect(parseCliValue('{bad')).toBe('{bad');
  });

  it('exports a JSON schema with all sections', () => {
    const js = settingsJsonSchema() as { properties: Record<string, unknown>; $id: string };
    expect(js.$id).toBe(SETTINGS_SCHEMA_URL);
    for (const k of ['language', 'agents', 'recording', 'decision', 'autopilot', 'telemetry']) expect(js.properties).toHaveProperty(k);
  });
});

describe('settings for the simplified app', () => {
  it('autopilot.autoStart defaults to true and only takes booleans', () => {
    expect(defaultSettings().autopilot.autoStart).toBe(true);
    expect(setSetting('autopilot.autoStart', false).autopilot.autoStart).toBe(false);
    expect(() => setSetting('autopilot.autoStart', 'yes')).toThrow(SettingsError);
    expect(loadSettings().autopilot.autoStart).toBe(false);
  });

  it('prompts.finish / prompts.publish are optional strings; unknown prompt keys are refused', () => {
    expect(setSetting('prompts.finish', '自分の文').prompts.finish).toBe('自分の文');
    expect(setSetting('prompts.publish', '').prompts.publish).toBe('');
    expect(() => setSetting('prompts.finish', 42)).toThrow(SettingsError);
    expect(() => setSetting('prompts.finish', 'x'.repeat(50_001))).toThrow(SettingsError);
    expect(() => setSetting('prompts.rough-cut', 'x')).toThrow(/unknown setting/);
    // reset to the default: the key disappears from the file
    setSetting('prompts.finish', undefined);
    expect(loadSettings().prompts.finish).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8')).prompts).not.toHaveProperty('finish');
  });

  it('a broken prompts section falls back to the defaults and keeps the rest', () => {
    writeFileSync(settingsPath(), JSON.stringify({ language: 'en', prompts: { finish: 1 } }));
    const r = loadSettingsWithErrors();
    expect(r.settings.language).toBe('en');
    expect(r.settings.prompts).toEqual({});
    expect(r.errors[0]!.path).toBe('prompts.finish');
  });

  it('publish privacy defaults: YouTube private, TikTok only me; only the platform values are accepted', () => {
    const d = defaultSettings();
    expect(d.publish).toEqual({ youtube: { privacy: 'private' }, tiktok: { privacy: 'SELF_ONLY' } });
    for (const v of YOUTUBE_PRIVACY) expect(setSetting('publish.youtube.privacy', v).publish.youtube.privacy).toBe(v);
    for (const v of TIKTOK_PRIVACY) expect(setSetting('publish.tiktok.privacy', v).publish.tiktok.privacy).toBe(v);
    for (const bad of ['PUBLIC', 'friends', '', null, 1]) {
      expect(() => setSetting('publish.youtube.privacy', bad)).toThrow(SettingsError);
      expect(() => setSetting('publish.tiktok.privacy', bad)).toThrow(SettingsError);
    }
    expect(() => setSetting('publish.youtube.privacy', 'SELF_ONLY')).toThrow(SettingsError);
    expect(() => setSetting('publish.tiktok.privacy', 'public')).toThrow(SettingsError);
    expect(() => setSetting('publish.instagram.privacy', 'public')).toThrow(/unknown setting/);
    expect(loadSettings().publish).toEqual({ youtube: { privacy: 'public' }, tiktok: { privacy: 'PUBLIC_TO_EVERYONE' } });
  });

  it('a broken publish section falls back to the defaults and keeps the rest', () => {
    writeFileSync(settingsPath(), JSON.stringify({ language: 'en', publish: { youtube: { privacy: 'everyone' } } }));
    const r = loadSettingsWithErrors();
    expect(r.settings.language).toBe('en');
    expect(r.settings.publish.youtube.privacy).toBe('private');
    expect(r.errors[0]!.path).toBe('publish.youtube.privacy');
    writeFileSync(settingsPath(), JSON.stringify({ publish: { tiktok: {} } }));
    expect(loadSettings().publish).toEqual({ youtube: { privacy: 'private' }, tiktok: { privacy: 'SELF_ONLY' } });
  });

  it('the decision model is off by default and still configurable', () => {
    expect(defaultSettings().decision.provider).toBe('off');
    expect(setSetting('decision.provider', 'auto').decision.provider).toBe('auto');
  });
});

describe('prompts', () => {
  it('ships exactly finish and publish, with ja and en bodies', () => {
    expect(PROMPT_IDS).toEqual(['finish', 'publish']);
    expect(DEFAULT_PROMPTS.map((p) => p.id)).toEqual(['finish', 'publish']);
    for (const p of DEFAULT_PROMPTS) {
      expect(p.body.ja, p.id).toBeTruthy();
      expect(p.body.en, p.id).toBeTruthy();
      expect(p.label.ja && p.label.en).toBeTruthy();
      expect(p.agent).toBe('default');
    }
    expect(DEFAULT_PROMPTS.find((p) => p.id === 'finish')!.autopilot).toBe(true);
    expect(DEFAULT_PROMPTS.find((p) => p.id === 'publish')!.autopilot).toBeUndefined();
  });

  it('isPromptId accepts only the two ids', () => {
    expect(isPromptId('finish')).toBe(true);
    expect(isPromptId('publish')).toBe(true);
    for (const x of ['rough-cut', 'thumbnail', 'FINISH', '', undefined, null, 1, {}]) expect(isPromptId(x)).toBe(false);
  });

  describe('finish (startup prompt)', () => {
    const ja = defaultPromptText('finish', 'ja');
    const en = defaultPromptText('finish', 'en');
    it('drives the ferret-video next loop in autopilot and never publishes', () => {
      expect(ja).toContain('ferret-video next --autopilot --json');
      expect(en).toContain('ferret-video next --autopilot --json');
      expect(ja).toContain('投稿はしないでください');
      expect(en).toContain('Do not publish');
    });
    it('does not require the decision model and marks unsure items 要確認', () => {
      expect(ja).toContain('判定モデルは要りません');
      expect(ja).toContain('要確認');
      expect(en).toContain('No decision model is needed');
    });
    it('keeps the person centered', () => {
      expect(ja).toMatch(/中央/);
      expect(en).toMatch(/center/);
    });
    it('lists the free illustration libraries with their terms, and no downloads in advance', () => {
      for (const lib of ['いらすとや', 'irasutoya.com', '20点', 'ソコスト', 'ICOOON MONO', 'Loose Drawing', 'unDraw', 'Openverse', 'Pixabay', 'Unsplash', 'Pexels']) expect(ja).toContain(lib);
      for (const lib of ['irasutoya.com', '20 images', 'ICOOON MONO', 'Loose Drawing', 'unDraw', 'Openverse', 'Pixabay', 'Unsplash', 'Pexels']) expect(en).toContain(lib);
      expect(ja).toContain('前もってダウンロードはしません');
      expect(ja).toContain('credits.md');
    });
    it('makes the thumbnail through the subscriptions (Codex $imagegen, Gemini CLI), never API keys', () => {
      expect(ja).toContain('codex exec');
      expect(ja).toContain("'$imagegen");
      expect(ja).toContain('1280x720');
      expect(ja).toContain('gemini extensions list');
      expect(ja).toContain('API キーは使いません');
      expect(en).toContain('Never use API keys');
      expect(ja).toContain('thumbnails/');
    });
    it('writes publish.json with the shared schema', () => {
      for (const s of [ja, en]) {
        expect(s).toContain('publish.json');
        for (const k of ['"video"', '"thumbnail"', '"title"', '"description"', '"tags"', '"youtube"', '"privacy"', '"tiktok"', '"enabled"', '"chapters"']) expect(s).toContain(k);
      }
      // the embedded example is valid JSON apart from the placeholders
      const json = ja.slice(ja.indexOf('{\n  "video"'), ja.indexOf('\n}', ja.indexOf('{\n  "video"')) + 2);
      expect(JSON.parse(json)).toMatchObject({ video: 'renders/final.mp4', youtube: { privacy: 'private' }, tiktok: { enabled: false } });
    });
    it('uses the privacy defaults from settings unless the human said otherwise', () => {
      for (const s of [ja, en]) {
        expect(s).toContain('ferret-video meta --json');
        expect(s).toContain('publish.youtube.privacy');
        expect(s).toContain('publish.tiktok.privacy');
      }
    });
    it('ends with a 3-line report', () => {
      expect(ja).toContain('3行で報告');
      expect(en).toContain('3 lines');
    });
  });

  describe('publish (posting prompt)', () => {
    const ja = defaultPromptText('publish', 'ja');
    const en = defaultPromptText('publish', 'en');
    it('checks publish.json limits and uploads through the app', () => {
      for (const s of [ja, en]) {
        expect(s).toContain('publish.json');
        expect(s).toContain('ferret-video publish upload');
        expect(s).toMatch(/100/);
        expect(s).toMatch(/5000/);
        expect(s).toContain('private');
      }
      expect(ja).toContain('URL');
      expect(en).toContain('URL');
      for (const s of [ja, en]) expect(s).toContain('ferret-video meta --json');
    });
  });

  it('promptOverride: a non-blank string wins, absent / blank / non-string mean the default', () => {
    expect(promptOverride({ prompts: { finish: 'mine' } }, 'finish')).toBe('mine');
    expect(promptOverride({ prompts: { finish: '' } }, 'finish')).toBeUndefined();
    expect(promptOverride({ prompts: { finish: ' \n\t ' } }, 'finish')).toBeUndefined();
    expect(promptOverride({ prompts: {} }, 'finish')).toBeUndefined();
    expect(promptOverride({ prompts: { publish: 'p' } }, 'finish')).toBeUndefined();
    expect(promptOverride(undefined, 'finish')).toBeUndefined();
    expect(promptOverride({ prompts: { finish: 7 } } as never, 'finish')).toBeUndefined();
  });

  it('promptsFromSettings replaces both languages and marks the override; defaults stay untouched', () => {
    const list = promptsFromSettings({ prompts: { finish: '短く {{project}}' } });
    const f = list.find((p) => p.id === 'finish')!;
    expect(f.body).toEqual({ ja: '短く {{project}}', en: '短く {{project}}' });
    expect(f.overridden).toBe(true);
    expect(f.label.ja).toBe('動画を完成させて');
    expect(f.autopilot).toBe(true);
    const p = list.find((x) => x.id === 'publish')!;
    expect(p.overridden).toBeUndefined();
    expect(p.body.ja).toBe(defaultPromptText('publish', 'ja'));
    expect(DEFAULT_PROMPTS[0]!.body.ja).not.toBe('短く {{project}}');
    // the returned objects are copies
    p.body.ja = 'mutated';
    expect(defaultPromptText('publish', 'ja')).not.toBe('mutated');
  });

  it('loadPrompts reads the overrides from settings.json; prompts.json files are ignored', () => {
    writeFileSync(join(home, 'prompts.json'), JSON.stringify({ prompts: [{ id: 'finish', body: { ja: 'old file' } }] }));
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.ferret-video'), { recursive: true });
    writeFileSync(join(proj, '.ferret-video', 'prompts.json'), JSON.stringify({ prompts: [{ id: 'finish', body: { ja: 'project file' } }] }));
    expect(loadPrompts(proj).find((p) => p.id === 'finish')!.body.ja).toBe(defaultPromptText('finish', 'ja'));
    setSetting('prompts.finish', 'from settings');
    expect(loadPrompts().find((p) => p.id === 'finish')!.body.ja).toBe('from settings');
    expect(loadPrompts(proj, { includeHidden: true }).map((p) => p.id)).toEqual(['finish', 'publish']);
    expect(loadPromptsWithErrors().errors).toEqual([]);
  });

  it('a broken settings.json still yields the default prompts', () => {
    writeFileSync(settingsPath(), '{oops');
    const r = loadPromptsWithErrors();
    expect(r.prompts.map((p) => p.id)).toEqual(['finish', 'publish']);
    expect(r.prompts[0]!.body.ja).toBe(defaultPromptText('finish', 'ja'));
  });

  it('renders vars, falls back to the other language, blanks unknown vars', () => {
    const p = { body: { ja: '{{template}} / {{ project }} / {{nope}} / {{date}}' } };
    const out = renderPrompt(p, { template: 'talk-youtube', project: 'p1' }, 'en');
    expect(out).toMatch(/^talk-youtube \/ p1 \/  \/ \d{4}-\d{2}-\d{2}$/);
    expect(renderPrompt({ body: {} }, {}, 'ja')).toBe('');
    expect(renderPrompt({ body: { ja: '{{date}}' } }, { date: 'today' }, 'ja')).toBe('today');
    expect(renderPrompt({ body: { ja: '{{1x}} {{}}' } }, {}, 'ja')).toBe('{{1x}} {{}}');
    const finish = DEFAULT_PROMPTS.find((x) => x.id === 'finish')!;
    expect(renderPrompt(finish, { template: 'tech-tutorial', project: 'demo' }, 'ja')).toContain('テンプレート tech-tutorial');
    expect(renderPrompt(finish, { project: 'demo' }, 'ja')).toContain('（demo）');
    for (const id of PROMPT_IDS) for (const lang of ['ja', 'en'] as const) expect(renderPrompt(DEFAULT_PROMPTS.find((x) => x.id === id)!, {}, lang)).not.toContain('{{');
  });

  it('renderPromptById: overrides, empty override → default, unknown id throws', () => {
    expect(renderPromptById('finish', { project: 'X' }, 'ja', { prompts: { finish: 'go {{project}}' } }).text).toBe('go X');
    expect(renderPromptById('finish', {}, 'en', { prompts: { finish: '   ' } }).text).toBe(renderPrompt({ body: { en: defaultPromptText('finish', 'en') } }, {}, 'en'));
    expect(renderPromptById('publish', {}, 'ja').prompt.id).toBe('publish');
    expect(() => renderPromptById('rough-cut', {}, 'ja')).toThrow(/unknown prompt: rough-cut/);
    expect(() => renderPromptById('', {}, 'ja')).toThrow(/unknown prompt/);
  });
});
