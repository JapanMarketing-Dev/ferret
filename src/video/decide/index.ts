import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

// Decision model client (docs/05_decision_model.md). Typed questions in, probabilities out. The request shape follows
// TypeSafe System One (state + questions + images → typed answers).

export type Question =
  | { id: string; kind: 'yesno'; text: string }
  | { id: string; kind: 'choice'; text: string; options: string[] }
  | { id: string; kind: 'score'; text: string };

export interface DecisionRequest {
  state: Record<string, unknown>;
  questions: Question[];
  images?: { id: string; path: string; note?: string }[];
}

export interface DecisionAnswer { id: string; p?: number; choice?: Record<string, number>; score?: number }

export type Provider = 'ollama' | 'openai' | 'typesafe' | 'custom' | 'off' | CliProvider;

/** Providers that run through the user's own agent CLI (their subscription): no API key, budget counted in calls. */
export const CLI_PROVIDERS = ['claude-cli', 'codex-cli', 'gemini-cli'] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];
export const isCliProvider = (p: string): p is CliProvider => (CLI_PROVIDERS as readonly string[]).includes(p);
/** The executable each CLI provider runs. */
export const CLI_COMMANDS: Record<CliProvider, string> = { 'claude-cli': 'claude', 'codex-cli': 'codex', 'gemini-cli': 'gemini' };
const KNOWN_PROVIDERS: readonly Provider[] = ['ollama', 'openai', 'typesafe', 'custom', 'off', ...CLI_PROVIDERS];

/**
 * The decision model is optional and off by default (settings `decision.provider: 'off'`): callers fall back to the
 * agent's own judgement and the rules. `'auto'` → the first installed agent CLI (claude → codex → gemini), else 'off';
 * empty or unknown values → 'off'. `which` resolves a command on PATH (e.g. @video/toolchain whichSync).
 */
export function resolveProvider(setting: string | undefined | null, which: (cmd: string) => string | null): Provider {
  const s = (setting ?? '').trim();
  if (s !== 'auto') return (KNOWN_PROVIDERS as readonly string[]).includes(s) ? (s as Provider) : 'off';
  for (const p of CLI_PROVIDERS) if (which(CLI_COMMANDS[p])) return p;
  return 'off';
}

export interface Usage {
  provider: Provider; model: string; cached: boolean; costUsd: number; tokensIn?: number; tokensOut?: number; key: string;
  /** Agent CLI calls made (0 when cached); CLI providers are budgeted in calls. */
  calls?: number;
}

/** Runs an agent CLI: prompt on stdin, in `cwd`. Injected in tests. */
export type CliRunner = (file: string, args: string[], o: { cwd: string; input: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) =>
  Promise<{ code: number; stdout: string; stderr: string }>;

export interface DecideOptions {
  provider: Provider;
  model: string;
  endpoint?: string;
  apiKey?: string;
  cacheDir: string;
  budget?: { remainingUsd: number };
  /** Called after every request (cached or not), e.g. to append to .ferret-video/decisions.jsonl. */
  onUsage?: (u: Usage) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** CLI providers: the executable (default claude / codex / gemini on PATH). */
  command?: string;
  /** CLI providers: remaining calls (refused before running at < 1). */
  callBudget?: { remaining: number };
  runCli?: CliRunner;
  env?: NodeJS.ProcessEnv;
}

export class DecideError extends Error {
  constructor(public readonly code: 'off' | 'budget' | 'http' | 'malformed' | 'config' | 'image' | 'cli', message: string) {
    super(message);
    this.name = 'DecideError';
  }
}

/** yes when p ≥ autoAbove, no when p ≤ autoBelow, else ask a human. NaN/out of range → ask. */
export function band(p: number, t: { autoAbove: number; autoBelow: number }): 'yes' | 'no' | 'ask' {
  if (!Number.isFinite(p) || p < 0 || p > 1) return 'ask';
  if (p >= t.autoAbove) return 'yes';
  if (p <= t.autoBelow) return 'no';
  return 'ask';
}

// ---------- request canonicalization & cache ----------

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

interface LoadedImage { id: string; note?: string; mime: string; base64: string; sha256: string }

function loadImages(req: DecisionRequest): LoadedImage[] {
  return (req.images ?? []).map((img) => {
    let buf: Buffer;
    try {
      buf = readFileSync(img.path);
    } catch (e) {
      throw new DecideError('image', `cannot read image ${img.path}: ${(e as Error).message}`);
    }
    const ext = extname(img.path).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { id: img.id, ...(img.note ? { note: img.note } : {}), mime, base64: buf.toString('base64'), sha256: createHash('sha256').update(buf).digest('hex') };
  });
}

/** Cache key: sha256 of provider, model, endpoint, state, questions and image content hashes. */
export function requestKey(req: DecisionRequest, o: Pick<DecideOptions, 'provider' | 'model' | 'endpoint'>, images: { id: string; sha256: string }[]): string {
  const canon = stable({ v: 1, provider: o.provider, model: o.model, endpoint: o.endpoint, state: req.state, questions: req.questions, images: images.map((i) => ({ id: i.id, sha256: i.sha256 })) });
  return createHash('sha256').update(canon).digest('hex');
}

function cacheGet(dir: string, key: string): DecisionAnswer[] | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')) as { answers: DecisionAnswer[] };
    return Array.isArray(raw.answers) ? raw.answers : null;
  } catch {
    return null;
  }
}

function cachePut(dir: string, key: string, answers: DecisionAnswer[], meta: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${key}.json`);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ answers, ...meta, at: new Date().toISOString() }));
  renameSync(tmp, p);
}

// ---------- prompt & schema ----------

const SYSTEM = [
  'You are a decision model for a video editor. Answer each question with calibrated probabilities, not prose.',
  'Return JSON only: {"answers":[...]} with one entry per question id, in the same order.',
  'yesno → {"id","p"} where p is the probability that the answer is yes (0..1).',
  'choice → {"id","choice":[{"option","p"}...]} covering every option; probabilities sum to 1.',
  'score → {"id","score"} in 0..1.',
  'Use null for fields that do not apply to the question kind.',
].join('\n');

function userText(req: DecisionRequest, images: LoadedImage[]): string {
  const qs = req.questions.map((q) => (q.kind === 'choice' ? { id: q.id, kind: q.kind, text: q.text, options: q.options } : { id: q.id, kind: q.kind, text: q.text }));
  const parts = [`STATE:\n${JSON.stringify(req.state, null, 1)}`, `QUESTIONS:\n${JSON.stringify(qs, null, 1)}`];
  if (images.length) parts.push(`IMAGES (in order): ${images.map((i) => `${i.id}${i.note ? ` (${i.note})` : ''}`).join(', ')}`);
  return parts.join('\n\n');
}

/** Strict JSON schema shared by OpenAI-style structured outputs (all fields required, nullable where unused). */
export function answerJsonSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['answers'],
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'p', 'choice', 'score'],
          properties: {
            id: { type: 'string' },
            p: { type: ['number', 'null'] },
            score: { type: ['number', 'null'] },
            choice: {
              anyOf: [
                { type: 'null' },
                { type: 'array', items: { type: 'object', additionalProperties: false, required: ['option', 'p'], properties: { option: { type: 'string' }, p: { type: 'number' } } } },
              ],
            },
          },
        },
      },
    },
  };
}

const in01 = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Validate and normalize provider output against the questions. Throws DecideError('malformed'). */
export function parseAnswers(raw: unknown, questions: Question[]): DecisionAnswer[] {
  let obj = raw;
  if (typeof obj === 'string') {
    const s = obj.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      obj = JSON.parse(s);
    } catch {
      throw new DecideError('malformed', `provider returned non-JSON: ${s.slice(0, 120)}`);
    }
  }
  const list = (obj as { answers?: unknown })?.answers;
  if (!Array.isArray(list)) throw new DecideError('malformed', 'provider response has no answers array');
  const byId = new Map<string, Record<string, unknown>>();
  for (const a of list) if (a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string') byId.set((a as { id: string }).id, a as Record<string, unknown>);
  return questions.map((q) => {
    const a = byId.get(q.id);
    if (!a) throw new DecideError('malformed', `no answer for question ${q.id}`);
    if (q.kind === 'yesno') {
      if (!in01(a.p)) throw new DecideError('malformed', `answer ${q.id}: p must be a number in 0..1`);
      return { id: q.id, p: a.p };
    }
    if (q.kind === 'score') {
      const s = a.score ?? a.p;
      if (!in01(s)) throw new DecideError('malformed', `answer ${q.id}: score must be a number in 0..1`);
      return { id: q.id, score: s };
    }
    // choice: accept [{option,p}] or {option: p}
    const c = a.choice;
    const entries: [string, number][] = Array.isArray(c)
      ? c.map((x) => [String((x as { option?: unknown }).option), (x as { p?: unknown }).p as number])
      : c && typeof c === 'object' ? Object.entries(c as Record<string, number>) : [];
    const out: Record<string, number> = Object.fromEntries(q.options.map((o) => [o, 0]));
    let sum = 0;
    for (const [opt, p] of entries) {
      if (!q.options.includes(opt)) continue;
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) throw new DecideError('malformed', `answer ${q.id}: invalid probability for ${opt}`);
      out[opt] = p;
      sum += p;
    }
    if (sum <= 0) throw new DecideError('malformed', `answer ${q.id}: no probability for any option`);
    for (const k of Object.keys(out)) out[k] = out[k]! / sum;
    return { id: q.id, choice: out };
  });
}

// ---------- cost ----------

/** Rough USD per 1M tokens (input, output) for budget reservation. Unknown cloud models use a conservative default. */
const PRICES: [RegExp, number, number][] = [
  [/^gpt-5(\.\d+)?-nano/, 0.05, 0.4],
  [/^gpt-5(\.\d+)?-mini/, 0.25, 2],
  [/^gpt-5/, 1.25, 10],
  [/^gpt-4\.1-mini/, 0.4, 1.6],
  [/^gpt-4o-mini/, 0.15, 0.6],
];
const IMAGE_TOKENS = 1100;

export function estimateCost(provider: Provider, model: string, tokensIn: number, tokensOut: number): number {
  if (provider === 'ollama' || provider === 'off' || isCliProvider(provider)) return 0;
  const [, pin, pout] = PRICES.find(([re]) => re.test(model)) ?? [null, 2.5, 10];
  return (tokensIn * pin + tokensOut * pout) / 1e6;
}

function estimateTokens(text: string, images: number, questions: number): { tin: number; tout: number } {
  return { tin: Math.ceil(text.length / 3) + 300 + images * IMAGE_TOKENS, tout: 40 * questions + 20 };
}

// ---------- providers ----------

async function postJson(o: DecideOptions, url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const f = o.fetch ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 120_000);
  let res: Response;
  try {
    res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    throw new DecideError('http', `request to ${url} failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new DecideError('http', `${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new DecideError('malformed', `${url}: response is not JSON`);
  }
}

interface ProviderResult { raw: unknown; tokensIn?: number; tokensOut?: number }

const trimSlash = (s: string) => s.replace(/\/+$/, '');

async function callOllama(req: DecisionRequest, images: LoadedImage[], o: DecideOptions): Promise<ProviderResult> {
  const url = `${trimSlash(o.endpoint ?? 'http://127.0.0.1:11434')}/api/chat`;
  const res = (await postJson(o, url, {
    model: o.model,
    stream: false,
    format: answerJsonSchema(),
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userText(req, images), ...(images.length ? { images: images.map((i) => i.base64) } : {}) },
    ],
  })) as { message?: { content?: unknown }; prompt_eval_count?: number; eval_count?: number };
  if (typeof res?.message?.content !== 'string') throw new DecideError('malformed', 'ollama: response has no message.content');
  return { raw: res.message.content, ...(res.prompt_eval_count !== undefined ? { tokensIn: res.prompt_eval_count } : {}), ...(res.eval_count !== undefined ? { tokensOut: res.eval_count } : {}) };
}

async function callOpenAI(req: DecisionRequest, images: LoadedImage[], o: DecideOptions): Promise<ProviderResult> {
  if (!o.apiKey) throw new DecideError('config', 'openai: apiKey is required');
  const url = `${trimSlash(o.endpoint ?? 'https://api.openai.com/v1')}/responses`;
  const res = (await postJson(o, url, {
    model: o.model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: SYSTEM }] },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: userText(req, images) },
          ...images.map((i) => ({ type: 'input_image', image_url: `data:${i.mime};base64,${i.base64}`, detail: 'low' })),
        ],
      },
    ],
    text: { format: { type: 'json_schema', name: 'decision', schema: answerJsonSchema(), strict: true } },
  }, { authorization: `Bearer ${o.apiKey}` })) as {
    output_text?: string;
    output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  let text = typeof res?.output_text === 'string' ? res.output_text : undefined;
  if (text === undefined) {
    for (const item of res?.output ?? []) {
      for (const c of item.content ?? []) {
        if (c.type === 'refusal') throw new DecideError('malformed', `openai refused: ${c.refusal ?? ''}`);
        if (c.type === 'output_text' && typeof c.text === 'string') text = (text ?? '') + c.text;
      }
    }
  }
  if (text === undefined) throw new DecideError('malformed', 'openai: response has no output_text');
  return { raw: text, ...(res.usage?.input_tokens !== undefined ? { tokensIn: res.usage.input_tokens } : {}), ...(res.usage?.output_tokens !== undefined ? { tokensOut: res.usage.output_tokens } : {}) };
}

async function callCustom(req: DecisionRequest, images: LoadedImage[], o: DecideOptions): Promise<ProviderResult> {
  if (!o.endpoint) throw new DecideError('config', 'custom: endpoint is required (OpenAI-compatible base URL)');
  const url = `${trimSlash(o.endpoint)}/chat/completions`;
  const res = (await postJson(o, url, {
    model: o.model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText(req, images) },
          ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } })),
        ],
      },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'decision', schema: answerJsonSchema(), strict: true } },
  }, o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {})) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = res?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new DecideError('malformed', 'custom: response has no choices[0].message.content');
  return { raw: content, ...(res.usage?.prompt_tokens !== undefined ? { tokensIn: res.usage.prompt_tokens } : {}), ...(res.usage?.completion_tokens !== undefined ? { tokensOut: res.usage.completion_tokens } : {}) };
}

/**
 * TypeSafe (System One) — stub until the public API is fixed: sends the request as-is (state, questions, base64
 * images) and expects `{ answers: [...] }` back. Endpoint is configurable.
 */
async function callTypesafe(req: DecisionRequest, images: LoadedImage[], o: DecideOptions): Promise<ProviderResult> {
  if (!o.apiKey) throw new DecideError('config', 'typesafe: apiKey is required');
  const url = trimSlash(o.endpoint ?? 'https://api.typesafe.ai/v1/system-one/decide');
  const res = (await postJson(o, url, {
    model: o.model,
    state: req.state,
    questions: req.questions,
    images: images.map((i) => ({ id: i.id, mime: i.mime, data: i.base64, ...(i.note ? { note: i.note } : {}) })),
  }, { authorization: `Bearer ${o.apiKey}` })) as { answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
  return { raw: res, ...(res?.usage?.input_tokens !== undefined ? { tokensIn: res.usage.input_tokens } : {}), ...(res?.usage?.output_tokens !== undefined ? { tokensOut: res.usage.output_tokens } : {}) };
}

// ---------- agent CLI providers (the user's subscription) ----------

/** Default runner: spawn without a shell; Windows .cmd/.bat shims go through cmd.exe (Node refuses them directly). */
export const defaultCliRunner: CliRunner = (file, args, o) => new Promise((res) => {
  let cmd = file;
  let argv = args;
  let verbatim = false;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const q = (a: string) => (/^[A-Za-z0-9_\-.:\\/=@]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
    cmd = (o.env ?? process.env).ComSpec ?? 'cmd.exe';
    argv = ['/d', '/s', '/c', `"${[file, ...args].map(q).join(' ')}"`];
    verbatim = true;
  }
  const child = spawn(cmd, argv, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: verbatim, windowsHide: true });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill(), o.timeoutMs);
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  child.on('error', (e) => {
    clearTimeout(timer);
    res({ code: 127, stdout, stderr: stderr + e.message });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    res({ code: code ?? 1, stdout, stderr });
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(o.input);
});

/** A model name only goes to the CLI that understands it (settings.decision.model may name an Ollama model). */
function cliModel(p: CliProvider, model: string): string | null {
  const m = model.trim();
  if (!m) return null;
  if (p === 'claude-cli') return /^(claude|opus|sonnet|haiku)/i.test(m) ? m : null;
  if (p === 'codex-cli') return /^(gpt|o\d|codex)/i.test(m) ? m : null;
  return /^gemini/i.test(m) ? m : null;
}

function cliPrompt(req: DecisionRequest, images: { id: string; note?: string; file: string }[]): string {
  return [
    SYSTEM,
    userText(req, []),
    ...(images.length ? [`IMAGES: read each file before answering — ${images.map((i) => `${i.file} = ${i.id}${i.note ? ` (${i.note})` : ''}`).join(', ')}`] : []),
    `Reply with the JSON object only (no prose, no code fence), matching this JSON Schema:\n${JSON.stringify(answerJsonSchema())}`,
  ].join('\n\n');
}

/** The last {...} block in a text (agent CLIs sometimes add a sentence around the JSON). */
function lastJsonObject(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (t.startsWith('{')) return t;
  const end = t.lastIndexOf('}');
  for (let i = t.lastIndexOf('{', end); i >= 0; i = t.lastIndexOf('{', i - 1)) {
    try {
      JSON.parse(t.slice(i, end + 1));
      return t.slice(i, end + 1);
    } catch {
      /* try an earlier brace */
    }
  }
  return t;
}

async function callCli(req: DecisionRequest, o: DecideOptions & { provider: CliProvider }): Promise<ProviderResult> {
  const work = mkdtempSync(join(tmpdir(), 'ferret-video-decide-'));
  try {
    // images are copied next to the prompt so the agent can read them with its file tool (and nothing else)
    const images = (req.images ?? []).map((img, i) => {
      const file = `img_${i + 1}${extname(img.path).toLowerCase() || '.png'}`;
      try {
        copyFileSync(img.path, join(work, file));
      } catch (e) {
        throw new DecideError('image', `cannot read image ${img.path}: ${(e as Error).message}`);
      }
      return { id: img.id, ...(img.note ? { note: img.note } : {}), file };
    });
    const prompt = cliPrompt(req, images);
    const model = cliModel(o.provider, o.model);
    const exe = o.command ?? CLI_COMMANDS[o.provider];
    let args: string[];
    if (o.provider === 'claude-cli') {
      args = ['-p', '--output-format', 'json', '--strict-mcp-config', '--allowedTools', 'Read',
        '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', '--max-turns', String(images.length + 2), ...(model ? ['--model', model] : [])];
    } else if (o.provider === 'codex-cli') {
      writeFileSync(join(work, 'schema.json'), JSON.stringify(answerJsonSchema()));
      args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-schema', 'schema.json', '--output-last-message', 'answer.json',
        ...(model ? ['--model', model] : []), ...images.map((i) => `--image=${i.file}`), '-'];
    } else {
      args = ['--output-format', 'json', ...(model ? ['--model', model] : []), '-p', `Follow the instructions on stdin and answer with the JSON object only.${images.length ? ` ${images.map((i) => `@${i.file}`).join(' ')}` : ''}`];
    }
    const run = o.runCli ?? defaultCliRunner;
    const baseEnv = o.env ?? process.env;
    const opts = (env: NodeJS.ProcessEnv) => ({ cwd: work, input: prompt, timeoutMs: o.timeoutMs ?? 300_000, env });
    // claude prefers ANTHROPIC_API_KEY (pay-as-you-go) over the subscription login when the variable is set: run on the
    // subscription first, and only fall back to the key when that fails (e.g. no login)
    let r;
    if (o.provider === 'claude-cli' && baseEnv.ANTHROPIC_API_KEY) {
      const { ANTHROPIC_API_KEY: _key, ...subscription } = baseEnv;
      r = await run(exe, args, opts(subscription));
      if (r.code !== 0 || /"is_error"\s*:\s*true/.test(r.stdout)) r = await run(exe, args, opts(baseEnv));
    } else r = await run(exe, args, opts(baseEnv));
    if (r.code === 127) throw new DecideError('cli', `${exe} is not installed or not runnable (${r.stderr.trim().slice(-200)})`);
    if (o.provider === 'codex-cli') {
      if (r.code !== 0) throw new DecideError('cli', `codex exec failed (${r.code}): ${r.stderr.trim().slice(-300)}`);
      const f = join(work, 'answer.json');
      return { raw: lastJsonObject(existsSync(f) ? readFileSync(f, 'utf8') : r.stdout) };
    }
    let env: Record<string, unknown>;
    try {
      env = JSON.parse(lastJsonObject(r.stdout)) as Record<string, unknown>;
    } catch {
      throw new DecideError(r.code === 0 ? 'malformed' : 'cli', `${exe} (${r.code}): ${(r.stdout.trim() || r.stderr.trim()).slice(-300)}`);
    }
    if (o.provider === 'claude-cli') {
      // { type: 'result', subtype, is_error, result: "<text>", usage: { input_tokens, output_tokens } }
      if (env.is_error === true || typeof env.result !== 'string') throw new DecideError('cli', `claude -p failed: ${String(env.result ?? env.subtype ?? r.stderr).slice(0, 300)}`);
      const u = env.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return { raw: lastJsonObject(env.result), ...(u?.input_tokens !== undefined ? { tokensIn: u.input_tokens } : {}), ...(u?.output_tokens !== undefined ? { tokensOut: u.output_tokens } : {}) };
    }
    // gemini: { response: "<text>", stats, error? }
    if (env.error || typeof env.response !== 'string') throw new DecideError('cli', `gemini -p failed: ${JSON.stringify(env.error ?? env).slice(0, 300)}`);
    return { raw: lastJsonObject(env.response) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Ask the decision model. Cached by request hash; refuses (before sending) when the estimated cost exceeds the budget. */
export async function decide(req: DecisionRequest, o: DecideOptions): Promise<DecisionAnswer[]> {
  if (o.provider === 'off') throw new DecideError('off', 'decision model is off (settings: decision.provider)');
  if (!req.questions.length) return [];
  const ids = new Set<string>();
  for (const q of req.questions) {
    if (ids.has(q.id)) throw new DecideError('config', `duplicate question id: ${q.id}`);
    ids.add(q.id);
    if (q.kind === 'choice' && q.options.length < 2) throw new DecideError('config', `choice question ${q.id} needs at least 2 options`);
  }
  if ((o.provider as string) === 'auto') throw new DecideError('config', "provider 'auto' must be resolved first (resolveProvider)");
  if ((o.provider === 'openai' || o.provider === 'typesafe') && !o.apiKey) throw new DecideError('config', `${o.provider}: apiKey is required`);
  if (o.provider === 'custom' && !o.endpoint) throw new DecideError('config', 'custom: endpoint is required (OpenAI-compatible base URL)');
  const cli = isCliProvider(o.provider);
  // CLI providers read the image files themselves: hash them for the cache key only
  const images = cli ? (req.images ?? []).map((img) => {
    try {
      return { id: img.id, sha256: createHash('sha256').update(readFileSync(img.path)).digest('hex') } as LoadedImage;
    } catch (e) {
      throw new DecideError('image', `cannot read image ${img.path}: ${(e as Error).message}`);
    }
  }) : loadImages(req);
  const key = requestKey(req, o, images);
  const cached = cacheGet(o.cacheDir, key);
  if (cached) {
    try {
      const answers = parseAnswers({ answers: cached }, req.questions);
      o.onUsage?.({ provider: o.provider, model: o.model, cached: true, costUsd: 0, key, ...(cli ? { calls: 0 } : {}) });
      return answers;
    } catch {
      /* stale or corrupt cache entry: ask again */
    }
  }
  if (cli) {
    if (o.callBudget && o.callBudget.remaining < 1) throw new DecideError('budget', `decision budget exceeded: no ${o.provider} calls left`);
    const r = await callCli(req, o as DecideOptions & { provider: CliProvider });
    const answers = parseAnswers(r.raw, req.questions);
    if (o.callBudget) o.callBudget.remaining -= 1;
    cachePut(o.cacheDir, key, answers, { provider: o.provider, model: o.model, costUsd: 0 });
    o.onUsage?.({ provider: o.provider, model: o.model, cached: false, costUsd: 0, key, calls: 1, ...(r.tokensIn !== undefined ? { tokensIn: r.tokensIn } : {}), ...(r.tokensOut !== undefined ? { tokensOut: r.tokensOut } : {}) });
    return answers;
  }
  const est = estimateTokens(userText(req, images) + SYSTEM, images.length, req.questions.length);
  const reserve = estimateCost(o.provider, o.model, est.tin, est.tout);
  if (o.budget && reserve > o.budget.remainingUsd) {
    throw new DecideError('budget', `decision budget exceeded: needs ~$${reserve.toFixed(4)}, remaining $${o.budget.remainingUsd.toFixed(4)}`);
  }
  const call = ({ ollama: callOllama, openai: callOpenAI, custom: callCustom, typesafe: callTypesafe } as Partial<Record<Provider, typeof callOllama>>)[o.provider];
  if (!call) throw new DecideError('config', `unknown provider: ${o.provider}`);
  const r = await call(req, images, o);
  const answers = parseAnswers(r.raw, req.questions);
  const tokensIn = r.tokensIn ?? est.tin;
  const tokensOut = r.tokensOut ?? est.tout;
  const costUsd = estimateCost(o.provider, o.model, tokensIn, tokensOut);
  cachePut(o.cacheDir, key, answers, { provider: o.provider, model: o.model, costUsd });
  o.onUsage?.({ provider: o.provider, model: o.model, cached: false, costUsd, tokensIn, tokensOut, key });
  return answers;
}
