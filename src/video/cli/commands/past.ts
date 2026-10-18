import { parseFrameRange, query, summarize } from '@video/core';
import { compareStats, computeStats, getArchive, listArchive, registerProject, searchArchive, type ArchiveEntry } from '@video/archive';
import { loadSettings } from '@video/settings';
import { join, resolve } from 'node:path';
import { CliError, emit, intOpt, opts, t, type Ctx } from '../ctx.js';
import { applyEdit, openProject, readTimeline, writeAtomic, writeTemplateOverride } from '../project.js';
import { REUSE_PARTS, planReuse, type ReusePart } from '../reuse.js';

function row(e: ArchiveEntry): string {
  const m = Math.floor(e.durationSec / 60);
  const s = String(Math.round(e.durationSec % 60)).padStart(2, '0');
  return `${e.id}  ${e.registeredAt.slice(0, 10)}  ${e.template.id.padEnd(16)} ${m}:${s}  ${e.title}`;
}

function wrapArchive<T>(_ctx: Ctx, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError('archive', (e as Error).message);
  }
}

export async function cmdPast(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  try {
    openProject(ctx); // only to pick the project language when inside a project
  } catch {
    if (!ctx.uiLang) ctx.lang = loadSettings().language;
  }
  if (sub === 'list' || sub === undefined) {
    const { values } = opts(rest, { kind: { type: 'string' }, template: { type: 'string' }, target: { type: 'string' }, limit: { type: 'string' } }, { max: 0 });
    const limit = intOpt(values.limit, 'limit');
    const list = listArchive({ ...(values.kind ? { kind: values.kind } : {}), ...(values.template ? { template: values.template } : {}), ...(values.target ? { target: values.target } : {}), ...(limit !== undefined ? { limit } : {}) });
    emit(ctx, { entries: list }, () => (list.length ? list.map(row) : [t(ctx, 'アーカイブはまだ空です', 'the archive is empty')]));
    return;
  }
  if (sub === 'search') {
    const { values, positionals } = opts(rest, { limit: { type: 'string' } }, { min: 1, usage: 'ferret-video past search "<words>"' });
    const limit = intOpt(values.limit, 'limit');
    const list = searchArchive(positionals.join(' '), limit !== undefined ? { limit } : {});
    emit(ctx, { query: positionals.join(' '), entries: list }, () => (list.length ? list.map(row) : [t(ctx, '見つかりませんでした', 'no matches')]));
    return;
  }
  if (sub === 'show') {
    const { positionals } = opts(rest, {}, { min: 1, max: 1, usage: 'ferret-video past show <id>' });
    const { entry, stats } = wrapArchive(ctx, () => getArchive(positionals[0]!));
    emit(ctx, { entry, stats }, () => [
      row(entry),
      entry.goal ? `goal: ${entry.goal}` : '',
      ...entry.chapters.map((c) => `  ${c.startSec}s ${c.title}`),
      t(ctx,
        `区間 ${stats.segments}（平均 ${stats.avgSegmentSec} 秒）・切った割合 ${Math.round(stats.cutRatio * 100)}%・字幕 ${stats.captions}・効果音 ${stats.sfx}・ズーム ${stats.zooms}`,
        `${stats.segments} segments (avg ${stats.avgSegmentSec}s) · cut ${Math.round(stats.cutRatio * 100)}% · ${stats.captions} captions · ${stats.sfx} sfx · ${stats.zooms} zooms`),
    ].filter(Boolean));
    return;
  }
  if (sub === 'timeline') {
    const { values, positionals } = opts(rest, { range: { type: 'string' }, only: { type: 'string' } }, { min: 1, max: 1, usage: 'ferret-video past timeline <id> [--range a-b] [--only scenes]' });
    const { timeline } = wrapArchive(ctx, () => getArchive(positionals[0]!));
    if (!values.range && !values.only) {
      emit(ctx, { summary: summarize(timeline) }, () => JSON.stringify(summarize(timeline), null, 2));
      return;
    }
    let range: [number, number] | undefined;
    if (values.range) {
      try {
        range = parseFrameRange(values.range, timeline.canvas.fps);
      } catch (e) {
        throw new CliError('usage', (e as Error).message);
      }
    }
    let items;
    try {
      items = query(timeline, { ...(range ? { range } : {}), ...(values.only ? { kind: values.only } : {}) });
    } catch (e) {
      throw new CliError('usage', (e as Error).message);
    }
    emit(ctx, { items }, () => JSON.stringify(items, null, 2));
    return;
  }
  if (sub === 'compare') {
    const { positionals } = opts(rest, {}, { min: 1, max: 1, usage: 'ferret-video past compare <id>' });
    const { entry, stats } = wrapArchive(ctx, () => getArchive(positionals[0]!));
    const p = openProject(ctx);
    const current = computeStats(readTimeline(p));
    const diff = compareStats(stats, current);
    emit(ctx, { archive: entry.id, past: stats, current, diff }, () => [
      `${t(ctx, '項目', 'metric').padEnd(16)} ${t(ctx, '過去', 'past').padStart(8)} ${t(ctx, '今', 'now').padStart(8)}`,
      ...diff.map((d) => `${d.key.padEnd(16)} ${String(d.a).padStart(8)} ${String(d.b).padStart(8)}`),
    ]);
    return;
  }
  if (sub === 'reuse') {
    const { values, positionals } = opts(rest, { what: { type: 'string' }, apply: { type: 'boolean' }, out: { type: 'string' } }, { min: 1, max: 1, usage: `ferret-video past reuse <id> --what ${REUSE_PARTS.join(',')} [--apply] [--out ops.json]` });
    const what = (values.what ?? REUSE_PARTS.join(',')).split(',').map((x) => x.trim()).filter(Boolean) as ReusePart[];
    for (const w of what) if (!(REUSE_PARTS as readonly string[]).includes(w)) throw new CliError('usage', `unknown part: ${w} (${REUSE_PARTS.join(', ')})`);
    const past = wrapArchive(ctx, () => getArchive(positionals[0]!));
    const p = openProject(ctx);
    const cur = readTimeline(p);
    const plan = planReuse(past, cur, computeStats(cur), what, { lang: ctx.lang, by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}) });
    if (values.out) writeAtomic(resolve(ctx.io.cwd, values.out), JSON.stringify(plan.ops, null, 2) + '\n');
    let applied = false;
    let templateFile: string | undefined;
    if (values.apply) {
      await applyEdit(p, plan.ops, { by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}), note: `past reuse ${past.entry.id}` });
      applied = true;
      if (Object.keys(plan.templatePatch).length) templateFile = writeTemplateOverride(join(p.dir, 'templates'), p.file.template.id, plan.templatePatch, 'ferret-video past reuse', { project: p.dir }).file;
    }
    emit(ctx, { archive: past.entry.id, what, ops: plan.ops, templatePatch: plan.templatePatch, notes: plan.notes, skipped: plan.skipped, applied, ...(templateFile ? { templateFile } : {}) }, () => [
      ...plan.notes,
      ...plan.skipped.map((x) => `- ${x}`),
      applied ? t(ctx, `${plan.ops.length} 件の操作を適用しました${templateFile ? `。テンプレートの上書き: ${templateFile}` : ''}`, `applied ${plan.ops.length} operation(s)${templateFile ? `; template override: ${templateFile}` : ''}`)
        : t(ctx, `${plan.ops.length} 件の操作の案です。--apply で適用、--out で保存`, `${plan.ops.length} proposed operation(s); --apply to apply, --out to save`),
      ...(Object.keys(plan.templatePatch).length && !applied ? [`template: ${JSON.stringify(plan.templatePatch)}`] : []),
    ]);
    return;
  }
  if (sub === 'register') {
    opts(rest, {}, { max: 0 });
    const p = openProject(ctx);
    const entry = await registerProject(p.dir, { reason: 'manual' }).catch((e: Error) => {
      throw new CliError('archive', e.message);
    });
    emit(ctx, { entry }, () => t(ctx, `アーカイブに登録しました: ${entry.id}`, `registered: ${entry.id}`));
    return;
  }
  throw new CliError('usage', 'usage: ferret-video past list | search <q> | show <id> | timeline <id> | compare <id> | reuse <id> | register');
}
