import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildVideoCli, cliBanner, NODE_BUILTINS, videoCliPlugin } from '../../../../src/video/build/cliPlugin';

const ROOT = resolve(__dirname, '../../../..');

describe('cliPlugin pieces', () => {
  it('banner gives the bundle a require for CommonJS dependencies', () => {
    const b = cliBanner('1.2.3');
    expect(b.split('\n')[0]).toBe('// ferret-video (Ferret 1.2.3) — bundled by src/video/build/cliPlugin.ts. Do not edit.');
    expect(b).toContain("import { createRequire as __ferretVideoCreateRequire } from 'node:module';");
    expect(b).toContain('const require = __ferretVideoCreateRequire(import.meta.url);');
  });

  it('node builtins stay external (both spellings), packages do not', () => {
    for (const m of ['fs', 'node:fs', 'child_process', 'node:child_process', 'node:util']) expect(NODE_BUILTINS).toContain(m);
    for (const m of ['zod', 'yaml', 'budoux']) expect(NODE_BUILTINS).not.toContain(m);
  });

  it('the plugin runs at build only', () => {
    const p = videoCliPlugin(ROOT);
    expect(p.name).toBe('ferret-video-cli');
    expect(p.apply).toBe('build');
    expect(typeof p.closeBundle).toBe('function');
  });
});

// 本物のまとめを作って Node で動かす（1〜3 秒）
describe('buildVideoCli', () => {
  let out: string;
  let work: string;
  let built: Awaited<ReturnType<typeof buildVideoCli>>;
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ferret-video-build-'));
    out = join(work, 'video-cli');
    mkdirSync(join(out, 'templates', 'stale'), { recursive: true });
    writeFileSync(join(out, 'templates', 'stale', 'x'), 'old');
    built = await buildVideoCli({ root: ROOT, outDir: out });
  }, 60_000);
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [built.bundle, ...args], {
      encoding: 'utf8', cwd: work, timeout: 20_000,
      env: { ...process.env, FERRET_VIDEO_HOME: join(work, 'home'), FERRET_VIDEO_TEMPLATES_DIR: '', FERRET_VIDEO_DECISION_PROVIDER: 'off', ...env }
    });

  it('one ESM file with the banner; zod / yaml / budoux inside, node builtins imported', () => {
    expect(built.bundle).toBe(join(out, 'ferret-video.mjs'));
    expect(built.bytes).toBeGreaterThan(200_000);
    const js = readFileSync(built.bundle, 'utf8');
    expect(js.startsWith('#!/usr/bin/env node\n// ferret-video ')).toBe(true);
    expect(js).toContain('const require = __ferretVideoCreateRequire(import.meta.url);');
    expect(js).not.toMatch(/from ["'](zod|yaml|budoux)["']/);
    expect(js).toMatch(/from ["']node:fs["']/);
    expect(js).not.toMatch(/require\(["']electron["']\)|from ["']electron["']/);
  });

  it('copies the built-in templates (and drops stale ones)', () => {
    expect(built.templatesDir).toBe(join(out, 'templates'));
    expect(existsSync(join(out, 'templates', 'tech', 'template.yaml'))).toBe(true);
    expect(existsSync(join(out, 'templates', 'talk', 'prompts', 'rough-cut.md'))).toBe(true);
    expect(existsSync(join(out, 'templates', 'stale'))).toBe(false);
  });

  it('runs with node: --help, version finds the templates next to the bundle, init works', () => {
    const h = run(['--help']);
    expect(h.status, h.stderr).toBe(0);
    expect(h.stdout.startsWith('ferret-video ')).toBe(true);
    const v = run(['version', '--json']);
    expect(JSON.parse(v.stdout).templatesDir).toBe(join(realpathSync(out), 'templates'));
    const i = run(['init', join(work, 'v1'), '--no-git', '--json']);
    expect(i.status, i.stdout + i.stderr).toBe(0);
    expect(existsSync(join(work, 'v1', 'ferret-video.json'))).toBe(true);
    const bad = run(['nope']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('ferret-video: ');
  });
});
