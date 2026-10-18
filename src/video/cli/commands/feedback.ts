import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { frameToSeconds, frameToTimecode, type Timeline } from '@video/core';
import { loadSettings } from '@video/settings';
import { whichSync } from '@video/toolchain';
import { CliError, emit, info, opts, t, type Ctx } from '../ctx.js';
import { getAgent } from '../agents.js';
import {
  buildItems, feedbackMarkdown, fromAppSession, splitRemarks, type AppSession, strokesAss, strokesBox, targetsAt, type FeedbackItem, type FeedbackSession,
} from '../feedback.js';
import { applyEdit, openProject, readJsonFile, readTimeline, writeAtomic, type Project } from '../project.js';
import { defaultRun } from '../thumb.js';
import { freshPreview, media, whisperWords } from './media.js';

function newFeedbackId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `fb_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function validSession(raw: unknown): FeedbackSession & { id?: string } {
  if (!raw || typeof raw !== 'object' || (raw as { schema?: unknown }).schema !== 1) throw new CliError('invalid-session', 'session.json must be an object with "schema": 1');
  if (Array.isArray((raw as AppSession).events)) {
    // the desktop app's event list (docs: CONTRACTS.md, feedback import)
    try {
      const a = raw as AppSession;
      return { ...fromAppSession(a), ...(typeof a.id === 'string' ? { id: a.id } : {}) };
    } catch (e) {
      throw new CliError('invalid-session', (e as Error).message);
    }
  }
  const s = raw as FeedbackSession;
  for (const st of s.strokes ?? []) {
    if (!Array.isArray(st.points) || st.points.some((pt) => !Array.isArray(pt) || pt.length !== 2 || pt.some((v) => typeof v !== 'number' || !Number.isFinite(v)))) {
      throw new CliError('invalid-session', 'stroke points must be [x, y] pairs normalized to 0..1');
    }
    if (typeof st.startMs !== 'number' || typeof st.endMs !== 'number') throw new CliError('invalid-session', 'strokes need startMs and endMs');
  }
  return s;
}

const ffEsc = (v: string) => v.replace(/[\\:']/g, (c) => `\\${c}`);

/** The frame image with the pen strokes: ASS drawing when libass exists, else a drawbox around the strokes. */
async function frameImage(ffmpeg: string, preview: string, sec: number, it: FeedbackItem, tl: Timeline, dir: string, nn: string): Promise<void> {
  const out = join(dir, `${nn}.png`);
  const W = tl.canvas.width;
  const H = tl.canvas.height;
  const base = ['-hide_banner', '-nostdin', '-y', '-ss', sec.toFixed(3), '-i', preview, '-frames:v', '1', '-an'];
  const run = (vf: string | null) => new Promise<boolean>((res) => {
    execFile(ffmpeg, [...base, ...(vf ? ['-vf', vf] : []), out], { cwd: dir }, (err) => res(!err));
  });
  const scale = `scale=${W}:${H}`;
  if (!it.strokes.length) {
    await run(scale);
    return;
  }
  writeFileSync(join(dir, `${nn}.ass`), strokesAss(it.strokes, W, H));
  const ok = await run(`${scale},ass=${ffEsc(`${nn}.ass`)}`);
  rmSync(join(dir, `${nn}.ass`), { force: true });
  if (ok) return;
  const b = strokesBox(it.strokes, W, H)!;
  if (!(await run(`${scale},drawbox=x=${Math.round(b.x)}:y=${Math.round(b.y)}:w=${Math.round(b.w)}:h=${Math.round(b.h)}:color=red@0.9:t=6`))) await run(scale);
}

const ORGANIZE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['index', 'title', 'request'], properties: { index: { type: 'integer' }, title: { type: 'string' }, request: { type: 'string' } } } } },
};

function organizePrompt(items: FeedbackItem[], lang: 'ja' | 'en'): string {
  const list = items.map((it) => ({ index: it.index, timecode: it.frame, speech: it.speech, notes: it.notes, targets: it.targets.map((x) => x.label), pen: it.strokes.length > 0 }));
  return lang === 'ja'
    ? `動画編集のフィードバックを整理してください。各項目について、見出し（20字以内）と、編集者への要望（1文、何をどう直すか）を書いてください。発話の引用は書かないでください（原文はこちらで時刻から付けます）。推測で内容を足さないこと。JSON だけを返してください: {"items":[{"index":1,"title":"…","request":"…"}]}\n\n${JSON.stringify(list, null, 1)}`
    : `Organize this video-editing feedback. For each item write a title (≤ 8 words) and one-sentence request to the editor (what to change and how). Do not quote the speech (we attach the original by time). Don't invent content. Return JSON only: {"items":[{"index":1,"title":"…","request":"…"}]}\n\n${JSON.stringify(list, null, 1)}`;
}

function parseOrganized(text: string, items: FeedbackItem[]): Map<number, { title: string; request: string }> {
  let raw: unknown;
  const trimmed = text.trim();
  try {
    raw = JSON.parse(trimmed);
  } catch {
    const m = /\{[\s\S]*\}/.exec(trimmed);
    if (!m) throw new Error('no JSON in the agent output');
    raw = JSON.parse(m[0]);
  }
  // claude -p --output-format json wraps the answer in { result: "…" }
  if (raw && typeof raw === 'object' && typeof (raw as { result?: unknown }).result === 'string') return parseOrganized((raw as { result: string }).result, items);
  const list = (raw as { items?: unknown }).items;
  if (!Array.isArray(list)) throw new Error('agent output has no items');
  const out = new Map<number, { title: string; request: string }>();
  for (const x of list as { index?: unknown; title?: unknown; request?: unknown }[]) {
    if (typeof x.index === 'number' && typeof x.title === 'string' && typeof x.request === 'string' && items.some((it) => it.index === x.index)) {
      out.set(x.index, { title: x.title.trim().slice(0, 80), request: x.request.trim().slice(0, 400) });
    }
  }
  return out;
}

/** Ask an agent CLI in print mode to write titles and requests (quotes are never taken from the agent). */
async function organize(ctx: Ctx, dir: string, items: FeedbackItem[], lang: 'ja' | 'en', which: string | true): Promise<{ agent: string; organized: number }> {
  const settings = loadSettings();
  const candidates = typeof which === 'string' ? [which] : settings.agents.order.filter((a) => a === 'claude' || a === 'codex');
  const agent = candidates.find((a) => getAgent(a) && whichSync(getAgent(a)!.commands[0]!, ctx.io.env));
  if (!agent) throw new CliError('no-agent', t(ctx, '整理に使えるエージェント（claude / codex）が見つかりません', 'no agent CLI (claude / codex) found to organize the feedback'));
  const prompt = organizePrompt(items, lang);
  let text: string;
  if (agent === 'codex') {
    writeFileSync(join(dir, '.schema.json'), JSON.stringify(ORGANIZE_SCHEMA));
    const r = await defaultRun('codex', ['exec', '--skip-git-repo-check', '--output-schema', join(dir, '.schema.json'), '-o', join(dir, '.organized.txt'), '-'], { cwd: dir, env: ctx.io.env, timeoutMs: 5 * 60_000, input: prompt });
    rmSync(join(dir, '.schema.json'), { force: true });
    if (r.code !== 0 || !existsSync(join(dir, '.organized.txt'))) throw new CliError('organize-failed', `codex exec failed (${r.code}): ${r.stderr.trim().slice(-200)}`);
    text = readFileSync(join(dir, '.organized.txt'), 'utf8');
    rmSync(join(dir, '.organized.txt'), { force: true });
  } else {
    const r = await defaultRun('claude', ['-p', '--output-format', 'json'], { cwd: dir, env: ctx.io.env, timeoutMs: 5 * 60_000, input: prompt });
    if (r.code !== 0) throw new CliError('organize-failed', `claude -p failed (${r.code}): ${r.stderr.trim().slice(-200)}`);
    text = r.stdout;
  }
  let map: Map<number, { title: string; request: string }>;
  try {
    map = parseOrganized(text, items);
  } catch (e) {
    throw new CliError('organize-failed', `${agent}: ${(e as Error).message}`);
  }
  for (const it of items) {
    const o = map.get(it.index);
    if (o) {
      it.title = o.title;
      it.request = o.request;
    }
  }
  return { agent, organized: map.size };
}

async function cmdImport(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, { organize: { type: 'string' }, 'no-organize': { type: 'boolean' }, id: { type: 'string' } }, { min: 1, max: 1, usage: 'ferret-video feedback import <session-dir> [--organize claude|codex]' });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const src = resolve(ctx.io.cwd, positionals[0]!);
  const session = validSession(readJsonFile(join(src, 'session.json')));
  const sessionId = typeof session.id === 'string' && /^fb_[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(session.id) ? session.id : undefined;
  const id = values.id ?? sessionId ?? newFeedbackId();
  if (!/^fb_[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new CliError('usage', `invalid feedback id: ${id}`);
  const dir = join(p.dir, 'feedback', id);
  if (existsSync(join(dir, 'items.json'))) throw new CliError('exists', t(ctx, `すでにあります: feedback/${id}`, `feedback/${id} already exists`));
  // everything is built in a work folder and renamed into place at the end, so a failed transcription (or any
  // other failure) leaves no feedback/<id>/ behind
  const work = join(p.dir, 'feedback', `.tmp-${id}-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    await importInto(ctx, p, tl, { src, session, id, work, dir, organize: values['no-organize'] ? undefined : values.organize });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function importInto(ctx: Ctx, p: Project, tl: Timeline, o: { src: string; session: FeedbackSession; id: string; work: string; dir: string; organize: string | undefined }): Promise<void> {
  const { src, session, id, work } = o;
  // 1. speech
  let words = session.words ?? [];
  const audio = session.audio ? join(src, session.audio) : null;
  if (!session.words && audio && existsSync(audio)) {
    ({ words } = await whisperWords(ctx, p, audio, { lang: p.file.language, name: `feedback-${id}` }));
  }
  const remarks = splitRemarks(words, session.audioStartMs ?? 0, p.file.language);
  // 2. items with frames and targets
  const total = tl.segments.reduce((mx, s) => Math.max(mx, s.range.end), 0);
  const items: FeedbackItem[] = buildItems(session, remarks, tl.canvas.fps).map((it, i) => {
    const frame = Math.max(0, Math.min(Math.max(0, total - 1), it.frame));
    return { ...it, index: i + 1, frame, targets: targetsAt(tl, frame, it.strokes, p.file.language) };
  });
  if (!items.length) {
    throw new CliError('empty', t(ctx, 'フィードバックに発話もペンもメモもありません', 'the session has no speech, strokes or notes'));
  }
  // 3. frame images
  const warnings: string[] = [];
  if (total > 0) {
    const m = await media();
    const ffmpeg = await m.toolPath('ffmpeg');
    const preview = await freshPreview(ctx, p, tl);
    for (const it of items) await frameImage(ffmpeg, preview, frameToSeconds(it.frame, tl.canvas.fps), it, tl, work, String(it.index).padStart(2, '0'));
  } else warnings.push(t(ctx, '区間がないため画像を作れませんでした', 'no segments: no images'));
  // 4. optional organizing by an agent
  let organizedBy: string | undefined;
  if (o.organize) {
    try {
      organizedBy = (await organize(ctx, work, items, p.file.language, o.organize === 'auto' ? true : o.organize)).agent;
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  copyFileSync(join(src, 'session.json'), join(work, 'session.json'));
  if (audio && existsSync(audio)) copyFileSync(audio, join(work, 'voice.wav'));
  writeAtomic(join(work, 'items.json'), JSON.stringify({ id, createdAt: session.createdAt ?? new Date().toISOString(), organizedBy, variant: p.variant ?? 'main', items }, null, 2));
  writeAtomic(join(work, 'feedback.md'), feedbackMarkdown(id, items, tl, p.file.language));
  rmSync(o.dir, { recursive: true, force: true });   // a leftover without items.json (checked above)
  renameSync(work, o.dir);
  await applyEdit(p, [{ op: 'setReview', patch: {
    feedback: [...tl.review.feedback.filter((f) => f.id !== id), { id: id as `fb_${string}`, status: 'open', items: items.length }],
    openItems: [...tl.review.openItems, { ref: id, kind: 'feedback', summary: t(ctx, `フィードバック ${items.length} 件（feedback/${id}/feedback.md）`, `${items.length} feedback item(s) (feedback/${id}/feedback.md)`) }],
  } }], { by: 'human', note: 'feedback import' });
  info(ctx, t(ctx, `エージェントへ: 「feedback/${id}/feedback.md を読んで対応して。終わったら ferret-video render --preview と ferret-video check」`, `to the agent: "Read feedback/${id}/feedback.md and address it. Then run ferret-video render --preview and ferret-video check"`));
  emit(ctx, { id, dir: `feedback/${id}`, path: `feedback/${id}/feedback.md`, variant: p.variant ?? 'main', count: items.length, items: appItems(id, items, tl), organizedBy: organizedBy ?? null, warnings }, () => [
    t(ctx, `フィードバックを ${items.length} 件に分けました: feedback/${id}/feedback.md`, `split into ${items.length} item(s): feedback/${id}/feedback.md`),
    ...items.map((it) => `  ${it.index}. [${frameToTimecode(it.frame, tl.canvas.fps)}] ${it.title ?? it.speech.slice(0, 30)}`),
    ...warnings.map((w) => `! ${w}`),
  ]);
}

/** Items in the shape the app shows (n, timecode, project-relative image). */
function appItems(id: string, items: FeedbackItem[], tl: Timeline) {
  return items.map((it) => {
    const nn = String(it.index).padStart(2, '0');
    return {
      n: it.index, frame: it.frame, timecode: frameToTimecode(it.frame, tl.canvas.fps), image: `feedback/${id}/${nn}.png`,
      spoken: it.speech, request: it.request ?? '', title: it.title ?? '', notes: it.notes, targets: it.targets.map(({ kind, id: tid, label }) => ({ kind, id: tid, label })),
    };
  });
}

/** `feedback set <id> --items file.json`: the app's edited items (edits / deletions) → reindex, images, items.json, feedback.md. */
async function cmdSet(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, { items: { type: 'string' } }, { min: 1, max: 1, usage: 'ferret-video feedback set <id> --items <file.json>' });
  const id = positionals[0]!;
  if (!/^fb_[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new CliError('usage', `invalid feedback id: ${id}`);
  if (!values.items) throw new CliError('usage', 'usage: ferret-video feedback set <id> --items <file.json>');
  const p = openProject(ctx);
  const dir = join(p.dir, 'feedback', id);
  const current = readJsonFile<{ id: string; createdAt?: string; organizedBy?: string; variant?: string; items: FeedbackItem[] }>(join(dir, 'items.json'));
  if (current.variant && current.variant !== 'main' && !p.variant) p.variant = current.variant as Project['variant'];
  const raw = readJsonFile<unknown>(resolve(ctx.io.cwd, values.items));
  const list = Array.isArray(raw) ? raw : (raw as { items?: unknown }).items;
  if (!Array.isArray(list)) throw new CliError('usage', 'the items file must be an array (or { items: [...] })');
  const byIndex = new Map(current.items.map((it) => [it.index, it]));
  const next: FeedbackItem[] = [];
  for (const x of list as Record<string, unknown>[]) {
    const idx = Number(x.index ?? x.n);
    const base = byIndex.get(idx);
    if (!base) throw new CliError('usage', `unknown item index: ${String(x.index ?? x.n)}`);
    next.push({
      ...base,
      ...(typeof x.title === 'string' ? { title: x.title } : {}),
      ...(typeof x.request === 'string' ? { request: x.request } : {}),
      ...(Array.isArray(x.notes) ? { notes: (x.notes as unknown[]).filter((n): n is string => typeof n === 'string') } : {}),
    });
  }
  // renumber 1..n and move the images along (via temporary names so swaps cannot clobber)
  const moves = next.map((it, i) => ({ from: it.index, to: i + 1 }));
  const img = (n: number) => join(dir, `${String(n).padStart(2, '0')}.png`);
  for (const m of moves) if (existsSync(img(m.from))) renameSync(img(m.from), join(dir, `.tmp-${m.from}.png`));
  for (const old of current.items) if (!moves.some((m) => m.from === old.index)) rmSync(img(old.index), { force: true });
  for (const m of moves) if (existsSync(join(dir, `.tmp-${m.from}.png`))) renameSync(join(dir, `.tmp-${m.from}.png`), img(m.to));
  next.forEach((it, i) => (it.index = i + 1));
  const tl = readTimeline(p);
  writeAtomic(join(dir, 'items.json'), JSON.stringify({ ...current, items: next }, null, 2));
  writeAtomic(join(dir, 'feedback.md'), feedbackMarkdown(id, next, tl, p.file.language));
  if (tl.review.feedback.some((f) => f.id === id)) {
    await applyEdit(p, [{ op: 'setReview', patch: { feedback: tl.review.feedback.map((f) => (f.id === id ? { ...f, items: next.length } : f)) } }], { by: 'human', note: 'feedback set' });
  }
  emit(ctx, { id, path: `feedback/${id}/feedback.md`, count: next.length, items: appItems(id, next, tl) }, () =>
    t(ctx, `フィードバック ${id} を ${next.length} 件で保存しました`, `saved ${id} with ${next.length} item(s)`));
}

function listFeedback(p: Project, tl: Timeline): { id: string; status: string; items: number; path: string }[] {
  const ids = new Set(tl.review.feedback.map((f) => f.id as string));
  const dir = join(p.dir, 'feedback');
  if (existsSync(dir)) for (const d of readdirSync(dir)) if (existsSync(join(dir, d, 'feedback.md'))) ids.add(d);
  return [...ids].sort().map((id) => {
    const r = tl.review.feedback.find((f) => f.id === id);
    return { id, status: r?.status ?? 'open', items: r?.items ?? 0, path: `feedback/${id}/feedback.md` };
  });
}

export async function cmdFeedback(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'import') return cmdImport(ctx, rest);
  if (sub === 'set' || sub === 'update') return cmdSet(ctx, rest);
  const p = openProject(ctx);
  const tl = readTimeline(p);
  if (sub === 'list' || sub === undefined) {
    const { values } = opts(rest, { open: { type: 'boolean' } }, { max: 0 });
    const list = listFeedback(p, tl).filter((f) => !values.open || f.status === 'open');
    emit(ctx, { feedback: list }, () => (list.length ? list.map((f) => `${f.status === 'open' ? '●' : '✓'} ${f.id}  ${f.items}  ${f.path}`) : [t(ctx, 'フィードバックはありません', 'no feedback')]));
    return;
  }
  if (sub === 'show') {
    const { positionals } = opts(rest, {}, { min: 1, max: 1, usage: 'ferret-video feedback show <id>' });
    const id = positionals[0]!;
    if (!/^fb_[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new CliError('usage', `invalid feedback id: ${id}`);
    const f = join(p.dir, 'feedback', id, 'feedback.md');
    if (!existsSync(f)) throw new CliError('not-found', t(ctx, `フィードバックがありません: ${id}`, `no feedback ${id}`));
    const data = existsSync(join(p.dir, 'feedback', id, 'items.json')) ? readJsonFile<{ items: FeedbackItem[]; variant?: string }>(join(p.dir, 'feedback', id, 'items.json')) : { items: [] as FeedbackItem[] };
    const md = readFileSync(f, 'utf8');
    const vtl = data.variant && data.variant !== 'main' ? readTimeline({ dir: p.dir, variant: data.variant as Project['variant'] }) : tl;
    emit(ctx, { id, variant: data.variant ?? 'main', markdown: md, items: data.items, view: appItems(id, data.items, vtl) }, () => md);
    return;
  }
  if (sub === 'done') {
    const { positionals } = opts(rest, {}, { min: 1, max: 1, usage: 'ferret-video feedback done <id>' });
    const id = positionals[0]!;
    const meta = join(p.dir, 'feedback', id, 'items.json');
    const v = existsSync(meta) ? readJsonFile<{ variant?: string }>(meta).variant : undefined;
    if (v && v !== 'main' && !p.variant) {
      p.variant = v as Project['variant'];
      return cmdFeedback({ ...ctx, variant: v }, args);
    }
    const cur = tl.review.feedback.find((f) => f.id === id);
    if (!cur) throw new CliError('not-found', t(ctx, `フィードバックがありません: ${id}`, `no feedback ${id}`));
    await applyEdit(p, [{ op: 'setReview', patch: {
      feedback: tl.review.feedback.map((f) => (f.id === id ? { ...f, status: 'done' as const } : f)),
      openItems: tl.review.openItems.filter((o) => !(o.kind === 'feedback' && o.ref === id)),
    } }], { by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}), note: 'feedback done' });
    emit(ctx, { id, status: 'done' }, () => t(ctx, `${id} を対応済みにしました`, `${id} marked done`));
    return;
  }
  throw new CliError('usage', 'usage: ferret-video feedback import <dir> [--organize claude|codex] [--variant v] | set <id> --items <file> | list [--open] | show <id> | done <id>');
}
