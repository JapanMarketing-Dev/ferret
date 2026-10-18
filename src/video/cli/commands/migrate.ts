import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LEGACY_PROJECT_FILE, VIDEO_PROJECT_FILE } from '@video/names';
import { CliError, emit, intOpt, opts, t, type Ctx } from '../ctx.js';
import { findLegacyProjects, isLegacyOnly, migrateProject, type MigrateResult } from '../migrate.js';

/**
 * `ferret-video migrate [dir] [--depth 2]`: 旧 Solocut の動画フォルダ（solocut.json・.solocut/）を新しい名前へ移す。
 * dir（既定は今のフォルダ。--project でも可）が動画フォルダならそれを、そうでなければその下（チャンネルのフォルダ）を探して全部移す。
 */
export async function cmdMigrate(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, { depth: { type: 'string' }, 'dry-run': { type: 'boolean' } }, { max: 1, usage: 'ferret-video migrate [dir] [--depth 2] [--dry-run]' });
  const depth = intOpt(values.depth, 'depth') ?? 2;
  if (depth < 0 || depth > 5) throw new CliError('usage', '--depth must be 0..5');
  const root = resolve(ctx.io.cwd, positionals[0] ?? ctx.projectFlag ?? '.');
  if (!existsSync(root)) throw new CliError('not-found', t(ctx, `フォルダがありません: ${root}`, `folder not found: ${root}`));
  const targets = isLegacyOnly(root) ? [root] : findLegacyProjects(root, depth);
  const results: MigrateResult[] = values['dry-run'] ? targets.map((dir) => ({ dir, moved: [], skipped: [], warnings: [] })) : targets.map((dir) => migrateProject(dir));
  const already = !targets.length && existsSync(join(root, VIDEO_PROJECT_FILE));
  emit(ctx, { root, dryRun: !!values['dry-run'], migrated: results, already }, () => {
    if (!results.length) {
      return already
        ? t(ctx, `移すものはありません（${root} はすでに ${VIDEO_PROJECT_FILE} を使っています）`, `nothing to migrate (${root} already uses ${VIDEO_PROJECT_FILE})`)
        : t(ctx, `${LEGACY_PROJECT_FILE} のある動画フォルダは見つかりませんでした（${root}）`, `no video folder with ${LEGACY_PROJECT_FILE} found under ${root}`);
    }
    return results.flatMap((r) => [
      values['dry-run'] ? t(ctx, `移します: ${r.dir}`, `would migrate: ${r.dir}`) : t(ctx, `移しました: ${r.dir}`, `migrated: ${r.dir}`),
      ...r.moved.map((m) => `  ${m}`),
      ...r.warnings.map((w) => `  ! ${w}`),
    ]);
  });
}
