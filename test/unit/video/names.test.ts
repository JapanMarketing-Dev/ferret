import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_PROJECT_FILE, LEGACY_STATE_DIR, VIDEO_CLI, VIDEO_ENV_PREFIX, VIDEO_HOME_ENV, VIDEO_PROJECT_FILE, VIDEO_STATE_DIR } from '@video/names';
import { DEFAULT_PROMPTS, defaultPromptText, PROMPT_IDS } from '@video/settings';
import { builtinTemplatesDir, CLAUDE_MD, generateAgentsMd, listTemplatesWithErrors, loadTemplate } from '@video/templates';
import { DEFAULT_MANIFEST, videoHome } from '@video/toolchain';
import { Sandbox } from './cli/helpers.js';

// 旧 Solocut の名前が利用者・Agent に見えるところへ残っていないこと（移行の案内だけは旧い名前を書く）

const VIDEO = resolve(__dirname, '../../../src/video');
const PACKAGES = ['core', 'media', 'captions', 'decide', 'toolchain', 'templates', 'settings', 'archive', 'cli', 'builtin-templates'];
/** 旧い名前を書いてよいファイル（移行と、旧名を読むための定数） */
const ALLOWED = new Set(['toolchain/index.ts', 'cli/migrate.ts', 'cli/commands/migrate.ts', 'cli/project.ts', 'cli/index.ts']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('names', () => {
  it('the name constants', () => {
    expect([VIDEO_CLI, VIDEO_PROJECT_FILE, VIDEO_STATE_DIR, VIDEO_ENV_PREFIX, VIDEO_HOME_ENV]).toEqual(['ferret-video', 'ferret-video.json', '.ferret-video', 'FERRET_VIDEO_', 'FERRET_VIDEO_HOME']);
    expect([LEGACY_PROJECT_FILE, LEGACY_STATE_DIR]).toEqual(['solocut.json', '.solocut']);
  });

  it('no source file or built-in template says solocut (except the migration)', () => {
    const hits: string[] = [];
    for (const pkg of PACKAGES) {
      for (const f of files(join(VIDEO, pkg))) {
        const rel = relative(VIDEO, f).split('\\').join('/');
        if (ALLOWED.has(rel)) continue;
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (/solocut|SOLOCUT/i.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });

  it('no download from solocut.app; only https sources', () => {
    const urls = JSON.stringify(DEFAULT_MANIFEST).match(/https?:\/\/[^"]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toMatch(/^https:\/\//);
      expect(u).not.toMatch(/solocut|ferret-video\.app/);
    }
  });

  it('every built-in template loads and its AGENTS.md uses ferret-video', () => {
    expect(listTemplatesWithErrors().errors).toEqual([]);
    const ids = readdirSync(builtinTemplatesDir()).filter((n) => !n.startsWith('.'));
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const id of ids) {
      const tpl = loadTemplate(id);
      for (const lang of ['ja', 'en'] as const) {
        const md = generateAgentsMd(tpl, { dir: '/x', title: 'T', lang });
        expect(md).toContain('ferret-video next --json');
        expect(md).not.toMatch(/solocut/i);
      }
    }
    expect(CLAUDE_MD).toBe('@AGENTS.md\n');
    expect(builtinTemplatesDir()).toBe(join(VIDEO, 'builtin-templates'));
  });

  it('the finish / publish prompts use ferret-video and .ferret-video/', () => {
    expect(DEFAULT_PROMPTS.map((p) => p.id)).toEqual([...PROMPT_IDS]);
    for (const id of PROMPT_IDS) {
      for (const lang of ['ja', 'en'] as const) {
        const text = defaultPromptText(id, lang);
        expect(text).toContain('ferret-video ');
        expect(text).not.toMatch(/solocut/i);
      }
    }
    expect(defaultPromptText('finish', 'ja')).toContain('.ferret-video/handoff.md');
    expect(defaultPromptText('publish', 'en')).toContain('ferret-video publish upload --json');
  });
});

describe('home and the CLI surface', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = new Sandbox();
  });
  afterEach(() => sb.dispose());

  it('the home is ~/.ferret/video unless FERRET_VIDEO_HOME is set', () => {
    expect(videoHome()).toBe(sb.home);
    delete process.env.FERRET_VIDEO_HOME;
    expect(videoHome()).toBe(join(homedir(), '.ferret', 'video'));
  });

  it('help, version, errors and the MCP server are named ferret-video', async () => {
    const help = await sb.run(['help']);
    expect(help.stdout.startsWith('ferret-video ')).toBe(true);
    expect(help.stdout).toContain('migrate [dir]');
    expect(help.stdout.split('\n').filter((l) => /solocut/i.test(l) && !l.includes('migrate'))).toEqual([]);
    expect((await sb.run(['--version'])).stdout).toMatch(/^ferret-video \d+\.\d+\.\d+\n$/);
    const bad = await sb.run(['nope']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toBe('ferret-video: 不明なコマンド: nope（ferret-video help）\n');
    const commands = (await sb.run(['help', '--json'])).json.commands as string[];
    expect(commands).toContain('migrate');
    expect(commands).toContain('mcp');
  });

  it('init writes ferret-video.json and .ferret-video/, never the old names', async () => {
    const dir = join(sb.root, 'p');
    expect((await sb.run(['init', dir, '--no-git', '--json'])).json.ok).toBe(true);
    const names = readdirSync(dir);
    expect(names).toContain('ferret-video.json');
    expect(names).toContain('.ferret-video');
    expect(names).not.toContain('solocut.json');
    expect(names).not.toContain('.solocut');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.ferret-video/lock');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).not.toMatch(/solocut/i);
  });
});
