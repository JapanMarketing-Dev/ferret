import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Output, Target } from '@video/core';
import { CliError, emit, info, intOpt, opts, t, type Ctx } from '../ctx.js';
import { VARIANTS, applyEdit, openProject, readTimeline, setStep, variantExists, writeAtomic, type Project, type Variant } from '../project.js';
import { allTimelines } from './media.js';
import { emptyOutput, TARGETS } from './meta.js';

// The app uploads (it holds the OAuth tokens); the CLI hands the upload over and records results on
// outputs[].publish (docs/14).
//   publish upload: writes .ferret-video/publish-request.json { id, targets, at } and waits for the app's
//                   .ferret-video/publish-result.json with the same id ({ id, state: running|done, progress?, results }).
//   publish record: records one post on the timeline (the app calls it after an upload).

const STATUSES = ['draft', 'scheduled', 'published', 'failed'] as const;

/** Done when every video's targets are published or scheduled. */
export function updatePublishStep(p: Project): { pending: string[] } {
  const pending: string[] = [];
  for (const x of allTimelines(p)) {
    const tl = readTimeline(x);
    for (const target of x.variant ? [x.variant] : tl.meta.targets) {
      const st = tl.outputs.find((o) => o.target === target)?.publish?.status;
      if (st !== 'published' && st !== 'scheduled') pending.push(target);
    }
  }
  setStep(p, 'publish', pending.length ? 'needs-human' : 'done', pending.length ? `pending: ${pending.join(', ')}` : undefined);
  return { pending };
}

const USAGE =
  'usage: ferret-video publish upload [--target youtube|tiktok] [--force] [--timeout <sec>] | publish record --target youtube|tiktok --status published|scheduled|failed|draft [--url <url>] [--at ISO]';

export async function cmdPublish(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'upload') return cmdUpload(ctx, rest);
  if (sub !== 'record') throw new CliError('usage', USAGE);
  const { values } = opts(rest, { target: { type: 'string' }, status: { type: 'string' }, url: { type: 'string' }, at: { type: 'string' } }, { max: 0 });
  const target = values.target as Target | undefined;
  if (!target || !(TARGETS as readonly string[]).includes(target)) throw new CliError('usage', `--target must be one of ${TARGETS.join(', ')}`);
  const status = values.status as (typeof STATUSES)[number] | undefined;
  if (!status || !(STATUSES as readonly string[]).includes(status)) throw new CliError('usage', `--status must be one of ${STATUSES.join(', ')}`);
  if ((status === 'published' || status === 'scheduled') && !values.url) throw new CliError('usage', '--url is required for published / scheduled');
  if (values.url && !/^https?:\/\/\S+$/.test(values.url)) throw new CliError('usage', `invalid --url: ${values.url}`);
  if (values.at && Number.isNaN(Date.parse(values.at))) throw new CliError('usage', `invalid --at (ISO time): ${values.at}`);
  const p0 = openProject(ctx);
  // without --variant, a TikTok / Shorts target is recorded on its derived variant when it exists
  const p: Project = p0.variant
    ? p0
    : { ...p0, variant: (VARIANTS as readonly string[]).includes(target) && variantExists(p0.dir, target as Variant) ? (target as Variant) : null };
  if (p.variant && p.variant !== target) throw new CliError('usage', `variant ${p.variant} only has the ${p.variant} output`);
  const tl = readTimeline(p);
  const base: Output = tl.outputs.find((o) => o.target === target) ?? emptyOutput(tl, target);
  const publish = { status, ...(values.url ? { url: values.url } : {}), at: values.at ?? new Date().toISOString() };
  await applyEdit(p, [{ op: 'setOutput', output: { ...base, publish } }], { by: 'human', note: `publish ${target}` });
  const { pending } = updatePublishStep(p);
  emit(ctx, { variant: p.variant ?? 'main', target, publish, pending }, () => [
    t(ctx, `${target} を ${status} として記録しました${values.url ? `: ${values.url}` : ''}`, `recorded ${target} as ${status}${values.url ? `: ${values.url}` : ''}`),
    ...(pending.length ? [t(ctx, `未投稿: ${pending.join(', ')}`, `not yet published: ${pending.join(', ')}`)] : []),
  ]);
}

// ---------- upload hand-off ----------

export const REQUEST_FILE = '.ferret-video/publish-request.json';
export const RESULT_FILE = '.ferret-video/publish-result.json';
export const UPLOAD_TARGETS = ['youtube', 'tiktok'] as const;
export type UploadTarget = (typeof UPLOAD_TARGETS)[number];

export interface TargetResult { target: UploadTarget; ok: boolean; url?: string; error?: string; status?: string; alreadyPublished?: boolean; warnings?: string[] }
export interface HandoffResult { id: string; state: 'running' | 'done'; at: string; progress?: { target: string; phase: string; fraction?: number }; results: TargetResult[]; error?: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** publish-result.json for this request id; null when absent, malformed, partially written or for another id. */
export function readHandoffResult(dir: string, id: string): HandoffResult | null {
  let o: unknown;
  try {
    o = JSON.parse(readFileSync(join(dir, RESULT_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!isObj(o) || o.id !== id) return null;
  const results = (Array.isArray(o.results) ? o.results : []).filter(
    (r): r is TargetResult => isObj(r) && (UPLOAD_TARGETS as readonly unknown[]).includes(r.target) && typeof r.ok === 'boolean',
  );
  const progress = isObj(o.progress) && typeof o.progress.target === 'string' ? (o.progress as HandoffResult['progress']) : undefined;
  return {
    id,
    state: o.state === 'running' ? 'running' : 'done',
    at: typeof o.at === 'string' ? o.at : '',
    results,
    ...(progress ? { progress } : {}),
    ...(typeof o.error === 'string' && o.error ? { error: o.error } : {}),
  };
}

export function parseTargets(values: string[] | undefined): UploadTarget[] {
  const out: UploadTarget[] = [];
  for (const v of (values ?? []).flatMap((x) => x.split(','))) {
    const s = v.trim().toLowerCase();
    if (!s) continue;
    if (!(UPLOAD_TARGETS as readonly string[]).includes(s)) throw new CliError('usage', `--target must be youtube or tiktok (got ${v})`);
    if (!out.includes(s as UploadTarget)) out.push(s as UploadTarget);
  }
  return out;
}

export interface WaitOptions {
  /** the app must answer (state running) within this time, else it is not running / not watching this project */
  pickupMs: number;
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (r: HandoffResult) => void;
}

export type WaitOutcome = { kind: 'done'; result: HandoffResult } | { kind: 'no-app' } | { kind: 'timeout'; last: HandoffResult | null };

export async function waitForResult(dir: string, id: string, o: WaitOptions): Promise<WaitOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const start = now();
  let last: HandoffResult | null = null;
  for (;;) {
    const r = readHandoffResult(dir, id);
    if (r) {
      if (r.state === 'done') return { kind: 'done', result: r };
      if (!last || JSON.stringify(r.progress) !== JSON.stringify(last.progress)) o.onProgress?.(r);
      last = r;
    }
    const elapsed = now() - start;
    if (!last && elapsed >= o.pickupMs) return { kind: 'no-app' };
    if (elapsed >= o.timeoutMs) return { kind: 'timeout', last };
    await sleep(o.pollMs);
  }
}

/** Removes our request when nobody picked it up, so an app opened later does not post unexpectedly. */
export function withdrawRequest(dir: string, id: string): void {
  try {
    const o = JSON.parse(readFileSync(join(dir, REQUEST_FILE), 'utf8')) as { id?: unknown };
    if (o.id === id) rmSync(join(dir, REQUEST_FILE), { force: true });
  } catch {
    /* gone or replaced */
  }
}

const PICKUP_MS = 30_000;

async function cmdUpload(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { target: { type: 'string', multiple: true }, timeout: { type: 'string' }, force: { type: 'boolean' } }, { max: 0, usage: USAGE.split(' | ')[0]!.replace('usage: ', '') });
  const targets = parseTargets(values.target);
  const timeoutSec = intOpt(values.timeout, 'timeout') ?? 3600;
  if (timeoutSec < 1) throw new CliError('usage', '--timeout must be at least 1 (seconds)');
  const p = openProject(ctx);
  if (!existsSync(join(p.dir, 'publish.json'))) {
    throw new CliError('not-found', t(ctx, 'publish.json がありません。先にタイトル・説明・タグを publish.json に書いてください（ferret-video meta set）', 'publish.json not found. Write the title, description and tags first (ferret-video meta set)'));
  }
  const id = randomUUID();
  const request = { id, targets, at: new Date().toISOString(), ...(values.force ? { force: true } : {}) };
  writeAtomic(join(p.dir, REQUEST_FILE), JSON.stringify(request, null, 2) + '\n');
  info(ctx, t(ctx, 'Ferret にアップロードを頼みました。終わるまで待ちます…', 'Asked Ferret to upload; waiting…'));
  const timeoutMs = timeoutSec * 1000;
  const out = await waitForResult(p.dir, id, {
    pickupMs: Math.min(PICKUP_MS, timeoutMs),
    timeoutMs,
    pollMs: 500,
    onProgress: (r) => {
      const pr = r.progress;
      if (pr) info(ctx, `${pr.target}: ${pr.phase}${pr.fraction !== undefined ? ` ${Math.round(pr.fraction * 100)}%` : ''}`);
    },
  });
  if (out.kind === 'no-app') {
    withdrawRequest(p.dir, id);
    throw new CliError(
      'app-not-running',
      t(
        ctx,
        `Ferret が応答しません。起動してこのチャンネルのプロジェクトを開いてから、もう一度実行してください（動画: ${p.dir}。別のアップロード中のときは、終わってから）`,
        `Ferret did not answer. Start it, open the project of this channel and run this again (video: ${p.dir}; or wait for the upload in progress to finish)`,
      ),
      { id },
    );
  }
  if (out.kind === 'timeout') {
    throw new CliError(
      'timeout',
      t(ctx, `${timeoutSec} 秒待ちましたが、アップロードが終わりませんでした。アプリの投稿画面で状況を確認してください`, `The upload did not finish within ${timeoutSec} s. Check the Publish screen in the app`),
      { id, last: out.last },
    );
  }
  const r = out.result;
  const failed = r.results.filter((x) => !x.ok);
  const lines = () => [
    ...r.results.map((x) =>
      x.ok
        ? `✓ ${x.target}: ${x.alreadyPublished ? t(ctx, '投稿済み（もう一度は上げていません）', 'already posted (not uploaded again)') : (x.status ?? 'ok')}${x.url ? ` ${x.url}` : ''}`
        : `✗ ${x.target}: ${x.error ?? 'failed'}`,
    ),
    ...r.results.flatMap((x) => (x.warnings ?? []).map((w) => `! ${x.target}: ${w}`)),
    ...(r.error ? [`✗ ${r.error}`] : []),
  ];
  if (failed.length || !r.results.length) {
    if (!ctx.json) ctx.io.stdout(lines().join('\n') + '\n');
    throw new CliError(
      'publish-failed',
      r.error ?? t(ctx, `投稿に失敗しました: ${failed.map((x) => `${x.target}（${x.error ?? ''}）`).join('、')}`, `upload failed: ${failed.map((x) => `${x.target} (${x.error ?? ''})`).join(', ')}`),
      r,
    );
  }
  emit(ctx, { id, results: r.results }, lines);
}
