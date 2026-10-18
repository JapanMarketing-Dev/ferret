import { parseArgs, type ParseArgsConfig } from 'node:util';

export const CLI_VERSION = '0.2.1';

export interface IO {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: NodeJS.ProcessEnv;
  /** stdin text for `--ops -` (tests inject it). */
  readStdin?: () => Promise<string>;
  /** stdin as lines (for `ferret-video mcp`). */
  stdinLines?: () => AsyncIterable<string>;
  /** stderr is a terminal: progress may redraw one line with \r. */
  isTTY?: boolean;
}

export class CliError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'CliError';
  }
}

export type Lang = 'ja' | 'en';

export interface Ctx {
  io: IO;
  json: boolean;
  projectFlag?: string;
  /** --variant: an older project's derived vertical video (tiktok | youtube-shorts); new projects make one video. */
  variant?: string;
  lang: Lang;
  /** 全体の --lang で決めた画面の言語。あればプロジェクトの言語より優先する（メッセージだけ。字幕などは p.file.language） */
  uiLang?: Lang;
  /** Who is acting (history `by`). */
  by: 'human' | 'agent';
  agent?: string;
}

/** Print the result: JSON (`{ ok: true, ...data }`) with --json, else the human text. */
export function emit(ctx: Ctx, data: Record<string, unknown>, human: () => string | string[]): void {
  if (ctx.json) {
    ctx.io.stdout(JSON.stringify({ ok: true, ...data }, null, 2) + '\n');
    return;
  }
  const h = human();
  const text = Array.isArray(h) ? h.filter((l) => l !== undefined).join('\n') : h;
  if (text) ctx.io.stdout(text.endsWith('\n') ? text : text + '\n');
}

/** Human-only progress/info line on stderr (silent in --json mode). */
export function info(ctx: Ctx, s: string): void {
  if (!ctx.json) ctx.io.stderr(s.endsWith('\n') || s.endsWith('\r') ? s : s + '\n');
}

const lastBucket = new Map<string, number>();

/**
 * Progress on stderr. TTY: one redrawn line. Not a TTY (logs): at most one line per 10 %. With --json: NDJSON lines
 * `{"progress":{"task","fraction","label",…extra}}` at most once per 1 %, for the app's progress bars.
 */
export function progress(ctx: Ctx, key: string, fraction: number, label: string, extra: Record<string, unknown> = {}): void {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const pct = Math.floor(f * 100);
  if (ctx.json) {
    if ((lastBucket.get(key) ?? -1) >= pct) return;
    lastBucket.set(key, pct);
    ctx.io.stderr(JSON.stringify({ progress: { task: key, fraction: Math.round(f * 1000) / 1000, label, ...extra } }) + '\n');
    return;
  }
  if (ctx.io.isTTY) {
    const bar = `[${'#'.repeat(Math.round(f * 24)).padEnd(24, '.')}]`;
    ctx.io.stderr(`\r${label} ${bar} ${pct}%   `);
    return;
  }
  const bucket = Math.floor(pct / 10);
  if ((lastBucket.get(key) ?? -1) >= bucket) return;
  lastBucket.set(key, bucket);
  ctx.io.stderr(`${label} ${pct}%\n`);
}

export function progressDone(ctx: Ctx, key: string): void {
  lastBucket.delete(key);
  if (!ctx.json && ctx.io.isTTY) ctx.io.stderr('\n');
}

export const t = (ctx: Pick<Ctx, 'lang'>, ja: string, en: string): string => (ctx.lang === 'ja' ? ja : en);

type Options = NonNullable<ParseArgsConfig['options']>;

/** node:util parseArgs with usage errors turned into CliError. */
export function opts<O extends Options>(args: string[], options: O, o: { min?: number; max?: number; usage?: string } = {}) {
  let r;
  try {
    r = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new CliError('usage', `${(e as Error).message}${o.usage ? `\nusage: ${o.usage}` : ''}`);
  }
  const n = r.positionals.length;
  if ((o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) {
    throw new CliError('usage', `wrong number of arguments${o.usage ? `\nusage: ${o.usage}` : ''}`);
  }
  return r;
}

export function intOpt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new CliError('usage', `--${name} must be an integer`);
  return Number(v);
}
