import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sandbox } from './helpers.js';

// 全体の --lang ja|en: 画面の言語（メッセージ・next の why / do）。プロジェクトの言語（字幕・文字起こし）は変えない。init の --lang はプロジェクトの言語
let sb: Sandbox;
let dir: string;
beforeEach(async () => {
  sb = new Sandbox();
  dir = join(sb.root, 'v');
  expect((await sb.run(['init', dir, '--lang', 'ja', '--no-git', '--json'])).json.ok).toBe(true);
});
afterEach(() => sb.dispose());

describe('--lang', () => {
  it('status / next in English for a Japanese project (both spellings, anywhere in argv)', async () => {
    const ja = await sb.run(['status', '--json'], { cwd: dir });
    expect(ja.json.next.why).toBe('テイクも取り込んだ素材もありません');
    for (const argv of [['status', '--json', '--lang', 'en'], ['--lang=en', 'status', '--json'], ['status', '--lang', 'en', '--json']]) {
      const en = await sb.run(argv, { cwd: dir });
      expect(en.code, en.stdout + en.stderr).toBe(0);
      expect(en.json.next.why, argv.join(' ')).not.toMatch(/[ぁ-んァ-ン]/);
    }
    const next = await sb.run(['next', '--json', '--lang', 'en'], { cwd: dir });
    expect(next.json.do).not.toMatch(/[ぁ-んァ-ン]/);
    expect((await sb.run(['next', '--json', '--lang', 'ja'], { cwd: dir })).json.do).toMatch(/[ぁ-んァ-ン]/);
  });

  it('errors and help follow --lang too', async () => {
    expect((await sb.run(['nope', '--lang', 'en'])).stderr).toBe('ferret-video: unknown command: nope (see ferret-video help)\n');
    expect((await sb.run(['help', '--lang', 'en'])).stdout).toContain('edit videos by template');
    expect((await sb.run(['help', '--lang', 'ja'])).stdout).toContain('テンプレートで動画を編集する');
    const r = await sb.run(['status', '--json', '--lang', 'en'], { cwd: sb.root });
    expect(r.json.error.code).toBe('no-project');
    expect(r.json.error.message).toMatch(/^no ferret-video project found/);
  });

  it('does not change the project language', async () => {
    await sb.run(['status', '--json', '--lang', 'en'], { cwd: dir });
    expect(JSON.parse(readFileSync(join(dir, 'ferret-video.json'), 'utf8')).language).toBe('ja');
    expect((await sb.run(['status', '--json', '--lang', 'en'], { cwd: dir })).json.project.language).toBe('ja');
  });

  it('init keeps its own --lang (the project language)', async () => {
    const d = join(sb.root, 'en');
    const r = await sb.run(['init', d, '--lang', 'en', '--no-git', '--json']);
    expect(r.json.project.language).toBe('en');
    expect(readFileSync(join(d, 'AGENTS.md'), 'utf8')).toContain('Instructions for the agent');
    const d2 = join(sb.root, 'ja2');
    expect((await sb.run(['--lang=ja', 'init', d2, '--no-git', '--json'])).json.project.language).toBe('ja');
    expect((await sb.run(['init', join(sb.root, 'x'), '--lang', 'fr', '--json'])).code).toBe(2);
  });

  it('bad values are usage errors', async () => {
    for (const argv of [['status', '--lang', 'fr'], ['status', '--lang=EN'], ['status', '--lang=']]) {
      const r = await sb.run([...argv, '--json'], { cwd: dir });
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.json.error).toMatchObject({ code: 'usage', message: expect.stringContaining('--lang') });
    }
    const missing = await sb.run(['status', '--lang'], { cwd: dir });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('--lang');
  });

  it('templates and migrate accept it', async () => {
    expect((await sb.run(['templates', '--json', '--lang', 'en'])).json.ok).toBe(true);
    const m = await sb.run(['migrate', '--lang', 'en'], { cwd: sb.root });
    expect(m.code).toBe(0);
    expect(m.stdout).toMatch(/^no video folder with solocut\.json found/);
  });
});
