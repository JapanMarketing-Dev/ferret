import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OP_NAMES, frameToTimecode, parseFrameRange, query, splitForSwitch, summarize, type Decided, type Op, type QueryResult, type Timeline,
} from '@video/core';
import { CliError, emit, opts, t, type Ctx } from '../ctx.js';
import { applyEdit, historyStacks, openProject, readHistory, readTimeline, type HistoryEntry, type Project } from '../project.js';

/** Ops that carry a `decided` record (the CLI fills it from --reason). */
const DECIDED_OPS = new Set(['removeSegment', 'trimSegment', 'setVideo', 'setCamera', 'cutText', 'setDecided']);

const EDIT_FLAGS = new Set(['reason', 'by', 'agent', 'confidence', 'needs-review', 'feedback', 'rule', 'dry-run', 'ops']);

function decidedFrom(ctx: Ctx, flags: Record<string, unknown>): Decided | undefined {
  const reason = flags.reason;
  if (typeof reason !== 'string' || !reason.trim()) return undefined;
  const d: Decided = { by: ctx.by, reason: reason.trim() };
  if (ctx.agent && ctx.by === 'agent') d.agent = ctx.agent;
  if (flags.confidence !== undefined) {
    const c = Number(flags.confidence);
    if (!(c >= 0 && c <= 1)) throw new CliError('usage', '--confidence must be between 0 and 1');
    d.confidence = c;
  }
  if (flags['needs-review'] === true) d.needsReview = true;
  if (typeof flags.feedback === 'string') d.feedbackRef = flags.feedback;
  if (typeof flags.rule === 'string') d.ruleRef = flags.rule;
  return d;
}

/** `--key value`, `--key=value`, `--flag` → record; values parsed as JSON when possible. */
export function parseFlags(args: string[]): { flags: Record<string, unknown>; positionals: string[] } {
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    let key: string;
    let raw: string | true;
    if (eq > 0) {
      key = a.slice(2, eq);
      raw = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const nxt = args[i + 1];
      if (nxt === undefined || (nxt.startsWith('--') && nxt.length > 2)) raw = true;
      else {
        raw = nxt;
        i++;
      }
    }
    if (!key) throw new CliError('usage', `invalid option: ${a}`);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new CliError('usage', `invalid option: ${a}`);
    const value = raw === true ? true : EDIT_FLAGS.has(key) ? raw : parseValue(raw);
    flags[key] = value;
  }
  return { flags, positionals };
}

function parseValue(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

async function readOpsArg(ctx: Ctx, v: string): Promise<unknown> {
  const s = v.trim();
  if (s.startsWith('[') || s.startsWith('{')) return parseJsonArg(s, '--ops');
  if (s === '-') {
    if (!ctx.io.readStdin) throw new CliError('usage', 'stdin is not available');
    return parseJsonArg(await ctx.io.readStdin(), 'stdin');
  }
  let text: string;
  try {
    text = readFileSync(resolve(ctx.io.cwd, s), 'utf8');
  } catch {
    throw new CliError('not-found', `ops file not found: ${s}`);
  }
  return parseJsonArg(text, s);
}

function parseJsonArg(s: string, where: string): unknown {
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new CliError('invalid-json', `${where}: ${(e as Error).message}`);
  }
}

function normalizeOps(ctx: Ctx, raw: unknown, flags: Record<string, unknown>): Op[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { ops?: unknown }).ops) ? (raw as { ops: unknown[] }).ops : [raw];
  if (!list.length) throw new CliError('usage', 'no operations given');
  const fallback = decidedFrom(ctx, flags);
  return list.map((o, i) => {
    if (!o || typeof o !== 'object' || typeof (o as { op?: unknown }).op !== 'string') throw new CliError('invalid-op', `operation #${i + 1} has no "op"`);
    const op = { ...(o as Record<string, unknown>) };
    const name = op.op as string;
    if (!(OP_NAMES as readonly string[]).includes(name)) throw new CliError('invalid-op', `unknown op "${name}" (${OP_NAMES.join(', ')})`);
    if (DECIDED_OPS.has(name) && op.decided === undefined) {
      if (!fallback) throw new CliError('reason-required', t(ctx, `${name} には理由が必要です（--reason "<なぜ>"）`, `${name} needs a reason (--reason "<why>")`));
      op.decided = fallback;
    }
    return op as unknown as Op;
  });
}

const SPLIT = Symbol('split-for-switch');

/** `edit split-for-switch --segment <id> --at <sourceFrame,…>`: core splitForSwitch → chained splitSegment ops. */
function splitOps(ctx: Ctx, p: Project, flags: Record<string, unknown>): Op[] {
  const seg = flags.segment ?? flags.id;
  if (typeof seg !== 'string') throw new CliError('usage', 'usage: ferret-video edit split-for-switch --segment <id> --at <sourceFrame,…> --reason "<why>"');
  const raw = flags.at;
  const at = (Array.isArray(raw) ? raw : typeof raw === 'number' ? [raw] : typeof raw === 'string' ? raw.split(',') : []).map((x) => Number(String(x).trim()));
  if (!at.length || at.some((x) => !Number.isInteger(x) || x < 0)) throw new CliError('usage', '--at needs source frames (integers ≥ 0), e.g. --at 1200,1530');
  const tl = readTimeline(p);
  if (!tl.segments.some((s) => s.id === seg)) throw new CliError('not-found', t(ctx, `区間がありません: ${seg}`, `no such segment: ${seg}`));
  let ops: Op[];
  try {
    ops = splitForSwitch(tl, seg, at);
  } catch (e) {
    throw new CliError('invalid-op', (e as Error).message);
  }
  if (!ops.length) throw new CliError('invalid-op', t(ctx, `${seg} の中に分ける位置がありません（--at は素材のフレーム）`, `no split point inside ${seg} (--at takes source frames)`));
  return ops;
}

export async function cmdEdit(ctx: Ctx, args: string[]): Promise<void> {
  const { flags, positionals } = parseFlags(args);
  const p = openProject(ctx);
  let raw: unknown;
  if (typeof flags.ops === 'string') {
    if (positionals.length) throw new CliError('usage', 'use either --ops or an op name, not both');
    raw = await readOpsArg(ctx, flags.ops);
  } else if (positionals.length === 1 && /^\s*[[{]/.test(positionals[0]!)) {
    raw = parseJsonArg(positionals[0]!, 'argument');
  } else if (positionals.length === 1 && positionals[0] === 'split-for-switch') {
    raw = SPLIT;
  } else if (positionals.length === 1) {
    const op: Record<string, unknown> = { op: positionals[0] };
    for (const [k, v] of Object.entries(flags)) if (!EDIT_FLAGS.has(k)) op[k] = v;
    raw = op;
  } else {
    throw new CliError('usage', 'usage: ferret-video edit <op> --<field> <value> … --reason "<why>" | ferret-video edit --ops <file|json|->');
  }
  const ops = raw === SPLIT ? splitOps(ctx, p, flags) : normalizeOps(ctx, raw, flags);
  const r = await applyEdit(p, ops, { by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}), dryRun: flags['dry-run'] === true });
  const s = summarize(r.timeline);
  emit(ctx, { applied: ops.length, changed: r.changed, dryRun: flags['dry-run'] === true, warnings: r.issues, summary: { duration: s.duration, segments: s.counts.segments, captions: s.counts.captions } }, () => [
    flags['dry-run'] === true
      ? t(ctx, `確認のみ: ${ops.length} 件の操作は有効です（書き込んでいません）`, `dry run: ${ops.length} operation(s) are valid (nothing written)`)
      : r.changed ? t(ctx, `${ops.length} 件の操作を適用しました（長さ ${s.duration}、区間 ${s.counts.segments}）`, `applied ${ops.length} operation(s) (length ${s.duration}, ${s.counts.segments} segments)`)
        : t(ctx, '変更はありませんでした', 'nothing changed'),
    ...r.issues.map((i) => `  ${i.level}: ${i.path}: ${i.message}`),
  ]);
}

export async function cmdUndo(ctx: Ctx, args: string[], redo = false): Promise<void> {
  opts(args, {}, { max: 0 });
  const p = openProject(ctx);
  const h = readHistory(p);
  const stacks = historyStacks(h);
  const idx = redo ? stacks.redo.at(-1) : stacks.undo.at(-1);
  if (idx === undefined) {
    throw new CliError(redo ? 'nothing-to-redo' : 'nothing-to-undo', redo ? t(ctx, 'やり直す操作がありません', 'nothing to redo') : t(ctx, '取り消す操作がありません', 'nothing to undo'));
  }
  const entry = h[idx]!;
  const ops = redo ? entry.ops : entry.inverse;
  const r = await applyEdit(p, ops, { by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}), kind: redo ? 'redo' : 'undo', ref: idx });
  emit(ctx, { [redo ? 'redone' : 'undone']: { index: idx, at: entry.at, by: entry.by, ops: entry.ops.map((o) => o.op) }, changed: r.changed }, () =>
    redo ? t(ctx, `やり直しました: ${entry.ops.map((o) => o.op).join(', ')}`, `redone: ${entry.ops.map((o) => o.op).join(', ')}`)
      : t(ctx, `取り消しました: ${entry.ops.map((o) => o.op).join(', ')}`, `undone: ${entry.ops.map((o) => o.op).join(', ')}`));
}

export async function cmdHistory(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { limit: { type: 'string' }, full: { type: 'boolean' } }, { max: 0 });
  const p = openProject(ctx);
  const h = readHistory(p);
  const limit = values.limit ? Number(values.limit) : 20;
  if (!(limit >= 0)) throw new CliError('usage', '--limit must be a number');
  const { undo, redo } = historyStacks(h);
  const rows = h.map((e, i) => ({ index: i, ...e })).slice(-limit);
  const view = values.full ? rows : rows.map(({ ops, inverse: _inv, ...rest }) => ({ ...rest, ops: ops.map((o) => o.op), reasons: ops.map((o) => (o as { decided?: Decided }).decided?.reason).filter(Boolean) }));
  emit(ctx, { entries: view, canUndo: undo.length > 0, canRedo: redo.length > 0 }, () =>
    rows.map((e) => `${String(e.index).padStart(3)} ${e.at.slice(0, 19)} ${e.kind.padEnd(4)} ${(e.agent ?? e.by).padEnd(8)} ${e.ops.map((o) => o.op).join(', ')}`));
}

// ---------- tl ----------

/** `segments[role=demo]`, `captions`, `segment[id=seg_1]` */
export function parseQuery(q: string): { kind?: string; role?: string; id?: string } {
  const m = /^\s*([a-z]+)?\s*(?:\[(.*)\])?\s*$/i.exec(q);
  if (!m) throw new CliError('usage', `cannot parse query: ${q}`);
  const out: { kind?: string; role?: string; id?: string } = {};
  if (m[1]) out.kind = m[1];
  for (const cond of (m[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const kv = /^(role|id)\s*=\s*['"]?([^'"]+)['"]?$/.exec(cond);
    if (!kv) throw new CliError('usage', `unsupported condition: ${cond} (use role=… or id=…)`);
    out[kv[1] as 'role' | 'id'] = kv[2]!;
  }
  return out;
}

function brief(t: Timeline, r: QueryResult): string {
  const fps = t.canvas.fps;
  const range = r.range ? `${frameToTimecode(r.range[0], fps)}-${frameToTimecode(r.range[1], fps)}` : '';
  const item = r.item as { text?: string; role?: string; title?: string; label?: string; kind?: string };
  const what = item.text ?? item.title ?? item.label ?? item.role ?? item.kind ?? '';
  return `${r.kind.padEnd(8)} ${(r.id ?? '').padEnd(10)} ${range}  ${String(what).slice(0, 60)}`;
}

export async function cmdTl(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const fps = tl.canvas.fps;
  if (sub === 'summary' || sub === undefined) {
    const s = summarize(tl);
    emit(ctx, { summary: s }, () => [
      `${s.title}  ${s.canvas}  ${s.duration}`,
      t(ctx, `区間 ${s.counts.segments}・字幕 ${s.counts.captions}・シーン ${s.counts.scenes}・効果音 ${s.counts.sfx}`, `${s.counts.segments} segments · ${s.counts.captions} captions · ${s.counts.scenes} scenes · ${s.counts.sfx} sfx`),
      ...s.chapters.map((c) => `  ${c.start} ${c.title} (${c.segments})`),
      ...(s.needsReview.length + s.openItems.length ? [t(ctx, `要確認: ${[...s.needsReview.map((x) => x.ref), ...s.openItems.map((x) => x.ref)].join(', ')}`, `to review: ${[...s.needsReview.map((x) => x.ref), ...s.openItems.map((x) => x.ref)].join(', ')}`)] : []),
    ]);
    return;
  }
  if (sub === 'show') {
    const { positionals } = opts(rest, {}, { min: 1, max: 1, usage: 'ferret-video tl show <id>' });
    const id = positionals[0]!;
    const found = query(tl, { id });
    if (!found.length) throw new CliError('not-found', t(ctx, `要素がありません: ${id}`, `no element with id ${id}`));
    const el = found[0]!;
    const around = el.range ? query(tl, { range: [Math.max(0, el.range[0] - 1), el.range[1] + 1] }).filter((x) => x.id !== id && x.kind !== 'chapter') : [];
    emit(ctx, { element: el, around }, () => [JSON.stringify(el.item, null, 2), ...around.map((x) => brief(tl, x))]);
    return;
  }
  if (sub === 'range') {
    const { values, positionals } = opts(rest, { kind: { type: 'string' } }, { min: 1, max: 1, usage: 'ferret-video tl range <start-end> [--kind segments]' });
    let range: [number, number];
    try {
      range = parseFrameRange(positionals[0]!, fps);
    } catch (e) {
      throw new CliError('usage', (e as Error).message);
    }
    const items = query(tl, { range, ...(values.kind ? { kind: values.kind } : {}) });
    emit(ctx, { range, items }, () => items.map((x) => brief(tl, x)));
    return;
  }
  if (sub === 'query') {
    const { positionals } = opts(rest, {}, { min: 1, max: 1, usage: 'ferret-video tl query "segments[role=demo]"' });
    let items: QueryResult[];
    try {
      items = query(tl, parseQuery(positionals[0]!));
    } catch (e) {
      throw e instanceof CliError ? e : new CliError('usage', (e as Error).message);
    }
    emit(ctx, { items }, () => items.map((x) => brief(tl, x)));
    return;
  }
  if (sub === 'why') {
    const { positionals } = opts(rest, {}, { min: 1, max: 1, usage: 'ferret-video tl why <id>' });
    const id = positionals[0]!;
    const found = query(tl, { id });
    if (!found.length) throw new CliError('not-found', t(ctx, `要素がありません: ${id}`, `no element with id ${id}`));
    const decided = (found[0]!.item as { decided?: Decided }).decided ?? null;
    const removed = (found[0]!.item as { removedNeighbors?: unknown[] }).removedNeighbors ?? [];
    const needle = JSON.stringify(id);
    const history = readHistory(p).map((e, i) => ({ index: i, ...e })).filter((e) => JSON.stringify(e.ops).includes(needle))
      .map((e: HistoryEntry & { index: number }) => ({ index: e.index, at: e.at, by: e.by, agent: e.agent, kind: e.kind, ops: e.ops.map((o) => o.op), reasons: e.ops.map((o) => (o as { decided?: Decided }).decided?.reason).filter(Boolean) }));
    emit(ctx, { id, decided, removedNeighbors: removed, history }, () => [
      decided ? `${decided.by}${decided.agent ? `(${decided.agent})` : ''}: ${decided.reason}${decided.confidence !== undefined ? ` [${decided.confidence}]` : ''}${decided.needsReview ? t(ctx, '（要確認）', ' (needs review)') : ''}` : t(ctx, '判断の記録はありません', 'no decision recorded'),
      ...history.map((h) => `  #${h.index} ${h.at.slice(0, 19)} ${h.agent ?? h.by}: ${h.ops.join(', ')} ${h.reasons.join(' / ')}`),
    ]);
    return;
  }
  throw new CliError('usage', 'usage: ferret-video tl summary | show <id> | range <a-b> | query <q> | why <id>');
}
