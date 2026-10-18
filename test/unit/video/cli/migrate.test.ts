import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLegacyProjectDir, findLegacyProjects, isLegacyOnly, migrateProject } from '@video/cli/migrate.js';
import { Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = new Sandbox();
});
afterEach(() => sb.dispose());

/** 新しい名前で作ってから旧い名前へ戻す（旧 Solocut の動画フォルダと同じ形） */
async function legacyProject(dir: string, o: { agentsMd?: 'generated' | 'handwritten' | 'none'; gitignore?: string } = {}): Promise<void> {
  const r = await sb.run(['init', dir, '--title', '旧い動画', '--no-git', '--json']);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const { renameSync, rmSync } = await import('node:fs');
  renameSync(join(dir, 'ferret-video.json'), join(dir, 'solocut.json'));
  renameSync(join(dir, '.ferret-video'), join(dir, '.solocut'));
  if (o.agentsMd === 'generated') writeFileSync(join(dir, 'AGENTS.md'), '<!-- solocut が自動生成したファイルです。テンプレートを変えると作り直されます。 -->\n`solocut next --json`\n');
  else if (o.agentsMd === 'handwritten') writeFileSync(join(dir, 'AGENTS.md'), '# 自分で書いた指示\n`solocut next` を使う\n');
  else if (o.agentsMd === 'none') rmSync(join(dir, 'AGENTS.md'));
  if (o.gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), o.gitignore);
}

describe('ferret-video migrate', () => {
  it('moves solocut.json and .solocut/ to the new names, regenerates the generated AGENTS.md and fixes .gitignore', async () => {
    const dir = join(sb.root, 'v1');
    await legacyProject(dir, { agentsMd: 'generated', gitignore: '# solocut: x\nmedia/\n.solocut/lock\n/.solocut/\nnot.solocut.txt\n' });
    const r = await sb.run(['migrate', '--json'], { cwd: dir });
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, dryRun: false, already: false });
    expect(r.json.migrated).toHaveLength(1);
    expect(r.json.migrated[0].moved).toEqual(['solocut.json → ferret-video.json', '.solocut → .ferret-video', '.gitignore', 'AGENTS.md']);
    expect(existsSync(join(dir, 'ferret-video.json'))).toBe(true);
    expect(existsSync(join(dir, 'solocut.json'))).toBe(false);
    expect(existsSync(join(dir, '.ferret-video', 'status.json'))).toBe(true);
    expect(existsSync(join(dir, '.solocut'))).toBe(false);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('# ferret-video: x\nmedia/\n.ferret-video/lock\n/.ferret-video/\nnot.solocut.txt\n');
    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(md).toContain('ferret-video next --json');
    expect(md).not.toMatch(/solocut/i);
    // 移したあとは普通に使える
    expect((await sb.run(['status', '--json'], { cwd: dir })).json.ok).toBe(true);
  });

  it('does nothing when the folder already uses the new names (idempotent)', async () => {
    const dir = join(sb.root, 'v1');
    await sb.run(['init', dir, '--no-git', '--json']);
    const before = readFileSync(join(dir, 'ferret-video.json'), 'utf8');
    const r = await sb.run(['migrate', '--json'], { cwd: dir });
    expect(r.json).toMatchObject({ ok: true, migrated: [], already: true });
    expect(readFileSync(join(dir, 'ferret-video.json'), 'utf8')).toBe(before);
    expect((await sb.run(['migrate'], { cwd: dir })).stdout).toContain('移すものはありません');
  });

  it('leaves a stray solocut.json alone when ferret-video.json exists', () => {
    const dir = join(sb.root, 'both');
    mkdirSync(join(dir, '.solocut'), { recursive: true });
    writeFileSync(join(dir, 'ferret-video.json'), '{"new":true}');
    writeFileSync(join(dir, 'solocut.json'), '{"old":true}');
    const r = migrateProject(dir);
    expect(r.moved).toEqual([]);
    expect(r.skipped).toEqual(['solocut.json', '.solocut/']);
    expect(readFileSync(join(dir, 'ferret-video.json'), 'utf8')).toBe('{"new":true}');
    expect(existsSync(join(dir, 'solocut.json'))).toBe(true);
    expect(isLegacyOnly(dir)).toBe(false);
  });

  it('keeps an existing .ferret-video/ and the old .solocut/ when both exist', async () => {
    const dir = join(sb.root, 'v1');
    await legacyProject(dir);
    mkdirSync(join(dir, '.ferret-video'));
    writeFileSync(join(dir, '.ferret-video', 'keep.txt'), 'x');
    const r = migrateProject(dir);
    expect(r.moved).toContain('solocut.json → ferret-video.json');
    expect(r.skipped).toEqual(['.solocut']);
    expect(r.warnings[0]).toMatch(/\.ferret-video already exists/);
    expect(existsSync(join(dir, '.solocut', 'status.json'))).toBe(true);
    expect(readFileSync(join(dir, '.ferret-video', 'keep.txt'), 'utf8')).toBe('x');
  });

  it('does not rewrite a hand-written AGENTS.md (warns instead) and works without AGENTS.md / .gitignore', async () => {
    const a = join(sb.root, 'a');
    await legacyProject(a, { agentsMd: 'handwritten' });
    const ra = migrateProject(a);
    expect(readFileSync(join(a, 'AGENTS.md'), 'utf8')).toBe('# 自分で書いた指示\n`solocut next` を使う\n');
    expect(ra.warnings.join('\n')).toMatch(/AGENTS\.md mentions solocut/);
    const b = join(sb.root, 'b');
    await legacyProject(b, { agentsMd: 'none' });
    const { rmSync } = await import('node:fs');
    rmSync(join(b, '.gitignore'));
    const rb = migrateProject(b);
    expect(rb.moved).toEqual(['solocut.json → ferret-video.json', '.solocut → .ferret-video']);
    expect(rb.warnings).toEqual([]);
  });

  it('warns when the generated AGENTS.md cannot be regenerated (unknown template) but still moves the files', async () => {
    const dir = join(sb.root, 'v1');
    await legacyProject(dir, { agentsMd: 'generated' });
    const f = join(dir, 'solocut.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), template: { id: 'no-such-template', version: '1' } }));
    const r = migrateProject(dir);
    expect(r.moved).toContain('.solocut → .ferret-video');
    expect(r.warnings.join('\n')).toMatch(/AGENTS\.md was not regenerated/);
  });

  it('migrates every old video under a channel folder (depth 2), skips new ones, hidden folders and node_modules', async () => {
    const ch = join(sb.root, 'channel');
    await legacyProject(join(ch, 'v1'));
    await legacyProject(join(ch, '2026', 'v2'));
    await legacyProject(join(ch, 'a', 'b', 'too-deep'));
    await legacyProject(join(ch, 'node_modules', 'x'));
    await legacyProject(join(ch, '.hidden'));
    await sb.run(['init', join(ch, 'new'), '--no-git', '--json']);
    expect(findLegacyProjects(ch).map((d) => d.slice(ch.length + 1))).toEqual(['2026/v2', 'v1'].map((p) => p.split('/').join(sep)));
    const dry = await sb.run(['migrate', ch, '--dry-run', '--json']);
    expect(dry.json.migrated).toHaveLength(2);
    expect(existsSync(join(ch, 'v1', 'solocut.json'))).toBe(true);
    const r = await sb.run(['migrate', ch, '--json']);
    expect(r.json.migrated).toHaveLength(2);
    expect(existsSync(join(ch, 'v1', 'ferret-video.json'))).toBe(true);
    expect(existsSync(join(ch, '2026', 'v2', 'ferret-video.json'))).toBe(true);
    expect(existsSync(join(ch, 'a', 'b', 'too-deep', 'solocut.json'))).toBe(true);
    const deep = await sb.run(['migrate', ch, '--depth', '3', '--json']);
    expect(deep.json.migrated).toHaveLength(1);
    expect(existsSync(join(ch, 'node_modules', 'x', 'solocut.json'))).toBe(true);
    expect(existsSync(join(ch, '.hidden', 'solocut.json'))).toBe(true);
  });

  it('reports usage errors and missing folders', async () => {
    expect((await sb.run(['migrate', '--depth', '9', '--json'])).json.error.code).toBe('usage');
    expect((await sb.run(['migrate', '--depth', 'x', '--json'])).code).toBe(2);
    expect((await sb.run(['migrate', 'a', 'b', '--json'])).code).toBe(2);
    expect((await sb.run(['migrate', join(sb.root, 'nope'), '--json'])).json.error.code).toBe('not-found');
    const empty = await sb.run(['migrate', '--json']);
    expect(empty.json).toMatchObject({ ok: true, migrated: [], already: false });
    expect((await sb.run(['migrate'])).stdout).toContain('solocut.json のある動画フォルダは見つかりませんでした');
  });
});

describe('old-name video folders guide to migrate', () => {
  it('other commands fail with legacy-project from the folder, a subfolder and with --project', async () => {
    const dir = join(sb.root, 'v1');
    await legacyProject(dir);
    for (const [args, cwd] of [[['status', '--json'], dir], [['next', '--json'], join(dir, 'media')], [['status', '--project', dir, '--json'], sb.root]] as const) {
      const r = await sb.run([...args], { cwd });
      expect(r.code).toBe(1);
      expect(r.json.error.code, JSON.stringify(r.json)).toBe('legacy-project');
      expect(r.json.error.message).toContain('ferret-video migrate');
      expect(r.json.error.details.dir).toBe(dir);
    }
    const human = await sb.run(['status'], { cwd: dir });
    expect(human.stderr).toMatch(/^ferret-video: この動画フォルダは旧 Solocut の名前/);
  });

  it('init refuses to make a new project over an old one', async () => {
    const dir = join(sb.root, 'v1');
    await legacyProject(dir);
    const r = await sb.run(['init', dir, '--force', '--json']);
    expect(r.json.error.code).toBe('legacy-project');
    expect(existsSync(join(dir, 'ferret-video.json'))).toBe(false);
  });

  it('a new project inside an old folder wins; plain folders still say no-project', async () => {
    const outer = join(sb.root, 'outer');
    await legacyProject(outer);
    const inner = join(outer, 'inner');
    await sb.run(['init', inner, '--no-git', '--json']);
    expect((await sb.run(['status', '--json'], { cwd: inner })).json.ok).toBe(true);
    expect(findLegacyProjectDir(inner)).toBeNull();
    expect(findLegacyProjectDir(join(outer, 'media'))).toBe(outer);
    mkdirSync(join(sb.root, 'plain'));
    expect((await sb.run(['status', '--json'], { cwd: join(sb.root, 'plain') })).json.error.code).toBe('no-project');
  });
});
