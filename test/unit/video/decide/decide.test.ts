import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DecideError, answerJsonSchema, band, decide, defaultCliRunner, estimateCost, isCliProvider, parseAnswers, requestKey, resolveProvider, type DecideOptions, type DecisionRequest, type Question, type Usage,
} from '@video/decide';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ferret-video-dec-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const questions: Question[] = [
  { id: 'cut', kind: 'yesno', text: 'この部分を切っても自然につながるか' },
  { id: 'take', kind: 'choice', text: 'どちらのテイクを残すか', options: ['first', 'second'] },
  { id: 'fun', kind: 'score', text: '単体で面白いか' },
];
const req: DecisionRequest = { state: { before: '設定画面を開いて', candidate: 'えー、あの', after: '右上の歯車' }, questions };
const good = { answers: [{ id: 'cut', p: 0.9, choice: null, score: null }, { id: 'take', p: null, choice: [{ option: 'first', p: 1 }, { option: 'second', p: 3 }], score: null }, { id: 'fun', p: null, choice: null, score: 0.4 }] };

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
function mockFetch(respond: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    calls.push(c);
    const r = respond(c);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const opts = (o: Partial<DecideOptions>): DecideOptions => ({ provider: 'ollama', model: 'qwen3-vl', cacheDir: join(dir, 'cache'), ...o });

describe('band', () => {
  const t = { autoAbove: 0.7, autoBelow: 0.3 };
  it.each([
    [0.7, 'yes'], [0.71, 'yes'], [1, 'yes'], [0.3, 'no'], [0, 'no'], [0.29, 'no'], [0.5, 'ask'], [0.69, 'ask'], [0.31, 'ask'],
    [Number.NaN, 'ask'], [-0.1, 'ask'], [1.1, 'ask'], [Number.POSITIVE_INFINITY, 'ask'],
  ] as const)('%s → %s', (p, want) => {
    expect(band(p, t)).toBe(want);
  });
  it('equal thresholds never ask except at invalid input', () => {
    expect(band(0.5, { autoAbove: 0.5, autoBelow: 0.5 })).toBe('yes');
  });
});

describe('parseAnswers', () => {
  it('normalizes choice probabilities and accepts object or array form', () => {
    const a = parseAnswers(good, questions);
    expect(a).toEqual([{ id: 'cut', p: 0.9 }, { id: 'take', choice: { first: 0.25, second: 0.75 } }, { id: 'fun', score: 0.4 }]);
    const b = parseAnswers({ answers: [{ id: 'cut', p: 0 }, { id: 'take', choice: { first: 0.5, second: 0.5, other: 9 } }, { id: 'fun', p: 1 }] }, questions);
    expect(b[1]).toEqual({ id: 'take', choice: { first: 0.5, second: 0.5 } });
    expect(b[2]).toEqual({ id: 'fun', score: 1 });
  });

  it('accepts JSON strings, including fenced code blocks', () => {
    expect(parseAnswers('```json\n' + JSON.stringify(good) + '\n```', questions)[0]).toEqual({ id: 'cut', p: 0.9 });
  });

  it.each([
    ['not json', /non-JSON/],
    [{}, /no answers array/],
    [{ answers: [] }, /no answer for question cut/],
    [{ answers: [{ id: 'cut', p: 1.5 }, ...good.answers.slice(1)] }, /0\.\.1/],
    [{ answers: [{ id: 'cut', p: '0.5' }, ...good.answers.slice(1)] }, /0\.\.1/],
    [{ answers: [good.answers[0], { id: 'take', choice: [{ option: 'first', p: 0 }] }, good.answers[2]] }, /no probability/],
    [{ answers: [good.answers[0], { id: 'take', choice: [{ option: 'first', p: -1 }] }, good.answers[2]] }, /invalid probability/],
    [{ answers: [good.answers[0], { id: 'take', choice: 'first' }, good.answers[2]] }, /no probability/],
    [{ answers: [...good.answers.slice(0, 2), { id: 'fun', score: null }] }, /score/],
  ])('rejects %j', (raw, re) => {
    expect(() => parseAnswers(raw, questions)).toThrow(re);
  });
});

describe('decide', () => {
  it('off provider refuses', async () => {
    await expect(decide(req, opts({ provider: 'off' }))).rejects.toMatchObject({ code: 'off' });
  });

  it('no questions → no call', async () => {
    const m = mockFetch(() => ({ body: good }));
    expect(await decide({ state: {}, questions: [] }, opts({ fetch: m.f }))).toEqual([]);
    expect(m.calls).toHaveLength(0);
  });

  it('rejects duplicate ids and too-few options', async () => {
    await expect(decide({ state: {}, questions: [questions[0]!, questions[0]!] }, opts({}))).rejects.toThrow(/duplicate/);
    await expect(decide({ state: {}, questions: [{ id: 'x', kind: 'choice', text: '', options: ['a'] }] }, opts({}))).rejects.toThrow(/2 options/);
  });

  it('ollama: /api/chat with base64 images and JSON schema format; cache hit on repeat', async () => {
    const img = join(dir, 'f.png');
    writeFileSync(img, Buffer.from([1, 2, 3]));
    const m = mockFetch(() => ({ body: { message: { content: JSON.stringify(good) }, prompt_eval_count: 100, eval_count: 20 } }));
    const usages: Usage[] = [];
    const r = { ...req, images: [{ id: 'frame1', path: img }] };
    const a = await decide(r, opts({ fetch: m.f, onUsage: (u) => usages.push(u) }));
    expect(a[0]).toEqual({ id: 'cut', p: 0.9 });
    expect(m.calls).toHaveLength(1);
    const c = m.calls[0]!;
    expect(c.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(c.body.format).toEqual(answerJsonSchema());
    expect(c.body.stream).toBe(false);
    const msgs = c.body.messages as { role: string; images?: string[] }[];
    expect(msgs[1]!.images).toEqual([Buffer.from([1, 2, 3]).toString('base64')]);
    // cache hit
    const b = await decide(r, opts({ fetch: m.f, onUsage: (u) => usages.push(u) }));
    expect(b).toEqual(a);
    expect(m.calls).toHaveLength(1);
    expect(usages.map((u) => u.cached)).toEqual([false, true]);
    expect(usages[0]).toMatchObject({ costUsd: 0, tokensIn: 100, tokensOut: 20 });
  });

  it('cache miss when the image content, model or state changes', async () => {
    const img = join(dir, 'f.png');
    writeFileSync(img, 'a');
    const m = mockFetch(() => ({ body: { message: { content: JSON.stringify(good) } } }));
    const r = { ...req, images: [{ id: 'f', path: img }] };
    await decide(r, opts({ fetch: m.f }));
    writeFileSync(img, 'b');
    await decide(r, opts({ fetch: m.f }));
    await decide(r, opts({ fetch: m.f, model: 'other' }));
    await decide({ ...r, state: { x: 1 } }, opts({ fetch: m.f }));
    expect(m.calls).toHaveLength(4);
    expect(readdirSync(join(dir, 'cache'))).toHaveLength(4);
  });

  it('key is stable regardless of object key order', () => {
    const a = requestKey({ state: { a: 1, b: { c: 2, d: 3 } }, questions }, { provider: 'ollama', model: 'm' }, []);
    const b = requestKey({ state: { b: { d: 3, c: 2 }, a: 1 }, questions }, { provider: 'ollama', model: 'm' }, []);
    expect(a).toBe(b);
  });

  it('a corrupt cache entry is ignored and replaced', async () => {
    const m = mockFetch(() => ({ body: { message: { content: JSON.stringify(good) } } }));
    await decide(req, opts({ fetch: m.f }));
    const f = readdirSync(join(dir, 'cache'))[0]!;
    writeFileSync(join(dir, 'cache', f), '{"answers":[{"id":"cut","p":7}]}');
    await decide(req, opts({ fetch: m.f }));
    expect(m.calls).toHaveLength(2);
  });

  it('openai: responses API with strict json_schema, bearer key, parses output[] content', async () => {
    const m = mockFetch(() => ({ body: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(good) }] }], usage: { input_tokens: 1000, output_tokens: 100 } } }));
    const usages: Usage[] = [];
    const a = await decide(req, opts({ provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk-test', fetch: m.f, onUsage: (u) => usages.push(u) }));
    expect(a[2]).toEqual({ id: 'fun', score: 0.4 });
    const c = m.calls[0]!;
    expect(c.url).toBe('https://api.openai.com/v1/responses');
    expect(c.headers.authorization).toBe('Bearer sk-test');
    expect((c.body.text as { format: { type: string; strict: boolean } }).format).toMatchObject({ type: 'json_schema', strict: true });
    expect(usages[0]!.costUsd).toBeCloseTo((1000 * 0.25 + 100 * 2) / 1e6, 9);
  });

  it('openai: output_text shortcut, refusal and missing key', async () => {
    const m1 = mockFetch(() => ({ body: { output_text: JSON.stringify(good) } }));
    expect((await decide(req, opts({ provider: 'openai', model: 'gpt-5', apiKey: 'k', fetch: m1.f })))[0]).toEqual({ id: 'cut', p: 0.9 });
    const m2 = mockFetch(() => ({ body: { output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] } }));
    await expect(decide({ ...req, state: { r: 2 } }, opts({ provider: 'openai', model: 'gpt-5', apiKey: 'k', fetch: m2.f }))).rejects.toThrow(/refused/);
    await expect(decide(req, opts({ provider: 'openai', model: 'gpt-5' }))).rejects.toMatchObject({ code: 'config' });
  });

  it('custom: OpenAI-compatible chat completions', async () => {
    const m = mockFetch(() => ({ body: { choices: [{ message: { content: JSON.stringify(good) } }] } }));
    await decide(req, opts({ provider: 'custom', model: 'local', endpoint: 'http://localhost:8080/v1/', fetch: m.f }));
    expect(m.calls[0]!.url).toBe('http://localhost:8080/v1/chat/completions');
    expect(m.calls[0]!.headers.authorization).toBeUndefined();
    expect((m.calls[0]!.body.response_format as { type: string }).type).toBe('json_schema');
    await expect(decide(req, opts({ provider: 'custom', model: 'x' }))).rejects.toThrow(/endpoint is required/);
  });

  it('typesafe stub: configurable endpoint, answers passthrough', async () => {
    const m = mockFetch(() => ({ body: good }));
    await decide(req, opts({ provider: 'typesafe', model: 'jev', apiKey: 'k', endpoint: 'https://ts.example/decide', fetch: m.f }));
    expect(m.calls[0]!.url).toBe('https://ts.example/decide');
    expect(m.calls[0]!.body.questions).toEqual(questions);
  });

  it('budget: refuses before sending when the estimate exceeds the remaining budget', async () => {
    const m = mockFetch(() => ({ body: { output_text: JSON.stringify(good) } }));
    await expect(decide(req, opts({ provider: 'openai', model: 'gpt-5', apiKey: 'k', fetch: m.f, budget: { remainingUsd: 0 } }))).rejects.toMatchObject({ code: 'budget' });
    expect(m.calls).toHaveLength(0);
    // local models cost nothing
    const m2 = mockFetch(() => ({ body: { message: { content: JSON.stringify(good) } } }));
    await decide(req, opts({ fetch: m2.f, budget: { remainingUsd: 0 } }));
    expect(m2.calls).toHaveLength(1);
    // a cached answer is free even with no budget
    await decide(req, opts({ provider: 'openai', model: 'gpt-5', apiKey: 'k', fetch: m.f, budget: { remainingUsd: 1 } }));
    await expect(decide(req, opts({ provider: 'openai', model: 'gpt-5', apiKey: 'k', fetch: m.f, budget: { remainingUsd: 0 } }))).resolves.toHaveLength(3);
  });

  it('malformed provider responses', async () => {
    const cases: [unknown, RegExp][] = [
      [{ nothing: true }, /no message.content/],
      [{ message: { content: 'sorry, I cannot' } }, /non-JSON/],
      [{ message: { content: '{"answers":[{"id":"cut","p":2}]}' } }, /0\.\.1/],
    ];
    for (const [i, [body, re]] of cases.entries()) {
      const m = mockFetch(() => ({ body }));
      await expect(decide({ ...req, state: { i } }, opts({ fetch: m.f }))).rejects.toThrow(re);
    }
    const m = mockFetch(() => ({ body: '<html>' }));
    await expect(decide(req, opts({ fetch: m.f }))).rejects.toMatchObject({ code: 'malformed' });
    expect(() => readdirSync(join(dir, 'cache'))).toThrow(); // nothing cached
  });

  it('HTTP errors and network failures', async () => {
    const m = mockFetch(() => ({ status: 429, body: { error: 'rate limited' } }));
    await expect(decide(req, opts({ fetch: m.f }))).rejects.toMatchObject({ code: 'http' });
    const broken = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(decide(req, opts({ fetch: broken }))).rejects.toThrow(/fetch failed/);
  });

  it('missing image file', async () => {
    await expect(decide({ ...req, images: [{ id: 'x', path: join(dir, 'nope.png') }] }, opts({}))).rejects.toMatchObject({ code: 'image' });
  });

  it('estimateCost: free locally, conservative default for unknown cloud models', () => {
    expect(estimateCost('ollama', 'anything', 1e6, 1e6)).toBe(0);
    expect(estimateCost('custom', 'mystery', 1e6, 0)).toBe(2.5);
    expect(estimateCost('openai', 'gpt-5-nano', 1e6, 0)).toBe(0.05);
  });

  it('DecideError is an Error', () => {
    expect(new DecideError('off', 'x')).toBeInstanceOf(Error);
  });
});

describe('agent CLI providers (the user subscription)', () => {
  type Run = { file: string; args: string[]; cwd: string; input: string; files: string[] };
  const runner = (reply: (r: Run) => { code?: number; stdout?: string; stderr?: string; answerFile?: string }) => {
    const runs: Run[] = [];
    const runCli: DecideOptions['runCli'] = async (file, args, o) => {
      const r: Run = { file, args, cwd: o.cwd, input: o.input, files: readdirSync(o.cwd).sort() };
      runs.push(r);
      const x = reply(r);
      if (x.answerFile !== undefined) writeFileSync(join(o.cwd, 'answer.json'), x.answerFile);
      return { code: x.code ?? 0, stdout: x.stdout ?? '', stderr: x.stderr ?? '' };
    };
    return { runs, runCli };
  };
  const img = () => {
    const f = join(dir, 'frame.png');
    writeFileSync(f, 'PNGDATA');
    return f;
  };

  it('resolveProvider: auto picks the first installed CLI, else off; explicit settings pass through', () => {
    expect(resolveProvider('auto', (c) => (c === 'codex' || c === 'gemini' ? `/bin/${c}` : null))).toBe('codex-cli');
    expect(resolveProvider('auto', (c) => (c === 'claude' ? '/bin/claude' : `/bin/${c}`))).toBe('claude-cli');
    expect(resolveProvider('auto', () => null)).toBe('off');
    expect(resolveProvider('ollama', () => null)).toBe('ollama');
    expect(resolveProvider('gemini-cli', () => null)).toBe('gemini-cli');
    expect(isCliProvider('claude-cli')).toBe(true);
    expect(isCliProvider('openai')).toBe(false);
  });

  it('resolveProvider: the model is optional — off, empty, missing or unknown settings resolve to off', () => {
    const which = (c: string) => `/bin/${c}`;
    expect(resolveProvider('off', which)).toBe('off');
    expect(resolveProvider('', which)).toBe('off');
    expect(resolveProvider('  ', which)).toBe('off');
    expect(resolveProvider(undefined, which)).toBe('off');
    expect(resolveProvider(null, which)).toBe('off');
    expect(resolveProvider('chatgpt-web', which)).toBe('off');
    expect(resolveProvider(' codex-cli ', () => null)).toBe('codex-cli');
    expect(resolveProvider('custom', () => null)).toBe('custom');
  });

  it('decide refuses with code off (callers fall back to the rules) before touching the cache', async () => {
    await expect(decide({ state: {}, questions: [{ id: 'a', kind: 'yesno', text: 'x' }] }, { provider: 'off', model: 'm', cacheDir: join(dir, 'never') })).rejects.toMatchObject({ code: 'off' });
    expect(existsSync(join(dir, 'never'))).toBe(false);
  });

  it('claude-cli: print mode JSON, Read only, images copied next to the prompt, usage in calls, cached', async () => {
    const { runs, runCli } = runner(() => ({ stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `Here you go:\n${JSON.stringify(good)}`, usage: { input_tokens: 900, output_tokens: 60 } }) }));
    const usage: Usage[] = [];
    const budget = { remaining: 2 };
    const o = opts({ provider: 'claude-cli', model: 'qwen3-vl', runCli, callBudget: budget, onUsage: (u) => usage.push(u) });
    const a = await decide({ ...req, images: [{ id: 'frame', path: img(), note: 'the take' }] }, o);
    expect(a[0]).toEqual({ id: 'cut', p: 0.9 });
    const r = runs[0]!;
    expect(r.file).toBe('claude');
    expect(r.args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(r.args).toContain('--strict-mcp-config');
    expect(r.args[r.args.indexOf('--allowedTools') + 1]).toBe('Read');
    expect(r.args).toContain('Bash');
    expect(r.args).not.toContain('--model');   // an Ollama model name is not passed to claude
    expect(r.files).toEqual(['img_1.png']);
    expect(r.input).toContain('img_1.png = frame (the take)');
    expect(r.input).toContain('"answers"');
    expect(usage[0]).toMatchObject({ provider: 'claude-cli', cached: false, costUsd: 0, calls: 1, tokensIn: 900 });
    expect(budget.remaining).toBe(1);
    expect(existsSync(r.cwd)).toBe(false);   // the work folder is removed
    await decide({ ...req, images: [{ id: 'frame', path: join(dir, 'frame.png'), note: 'the take' }] }, o);
    expect(runs).toHaveLength(1);
    expect(usage[1]).toMatchObject({ cached: true, calls: 0 });
    // a claude model name is passed through
    await decide({ ...req, state: { x: 1 } }, { ...o, model: 'sonnet' });
    expect(runs[1]!.args.slice(-2)).toEqual(['--model', 'sonnet']);
  });

  it('codex-cli: exec with --output-schema, read-only sandbox, --image=, answer file', async () => {
    const { runs, runCli } = runner((r) => {
      expect(r.files).toEqual(['img_1.png', 'schema.json']);
      return { answerFile: JSON.stringify(good), stdout: 'log noise' };
    });
    const a = await decide({ ...req, images: [{ id: 'frame', path: img() }] }, opts({ provider: 'codex-cli', model: 'gpt-5-mini', command: '/opt/bin/codex', runCli }));
    expect(a[2]).toEqual({ id: 'fun', score: 0.4 });
    const r = runs[0]!;
    expect(r.file).toBe('/opt/bin/codex');
    expect(r.args).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-schema', 'schema.json', '--output-last-message', 'answer.json', '--model', 'gpt-5-mini', '--image=img_1.png', '-']);
  });

  it('gemini-cli: -p with @image refs and JSON output', async () => {
    const { runs, runCli } = runner(() => ({ stdout: JSON.stringify({ response: '```json\n' + JSON.stringify(good) + '\n```', stats: {} }) }));
    const a = await decide({ ...req, images: [{ id: 'frame', path: img() }] }, opts({ provider: 'gemini-cli', model: 'gemini-2.5-pro', runCli }));
    expect(a[1]!.choice).toEqual({ first: 0.25, second: 0.75 });
    const r = runs[0]!;
    expect(r.args.slice(0, 4)).toEqual(['--output-format', 'json', '--model', 'gemini-2.5-pro']);
    expect(r.args.at(-1)).toContain('@img_1.png');
  });

  it('failures: not installed, non-zero exit, is_error, prose without JSON, call budget, auto unresolved', async () => {
    const run = (x: { code?: number; stdout?: string; stderr?: string }) => runner(() => x).runCli;
    const err = async (o: Partial<DecideOptions>) => {
      try {
        await decide(req, opts(o));
        return 'resolved';
      } catch (e) {
        return (e as DecideError).code;
      }
    };
    expect(await err({ provider: 'claude-cli', runCli: run({ code: 127, stderr: 'ENOENT' }) })).toBe('cli');
    expect(await err({ provider: 'codex-cli', runCli: run({ code: 1, stderr: 'not logged in' }) })).toBe('cli');
    expect(await err({ provider: 'claude-cli', runCli: run({ stdout: JSON.stringify({ is_error: true, result: 'Credit balance is too low' }) }) })).toBe('cli');
    expect(await err({ provider: 'claude-cli', runCli: run({ stdout: JSON.stringify({ is_error: false, result: 'I think yes.' }) }) })).toBe('malformed');
    expect(await err({ provider: 'gemini-cli', runCli: run({ stdout: 'not json at all' }) })).toBe('malformed');
    expect(await err({ provider: 'gemini-cli', runCli: run({ code: 1, stdout: '', stderr: 'auth' }) })).toBe('cli');
    expect(await err({ provider: 'gemini-cli', runCli: run({ stdout: JSON.stringify({ error: { message: 'quota' } }) }) })).toBe('cli');
    expect(await err({ provider: 'claude-cli', callBudget: { remaining: 0 }, runCli: run({}) })).toBe('budget');
    expect(await err({ provider: 'auto' as never })).toBe('config');
    expect(await err({ provider: 'claude-cli', runCli: run({ stdout: '{}' }) })).toBe('cli');
    expect(estimateCost('claude-cli', 'x', 1e6, 1e6)).toBe(0);
  });

  it('missing image is reported before running the CLI', async () => {
    const { runs, runCli } = runner(() => ({}));
    await expect(decide({ ...req, images: [{ id: 'x', path: join(dir, 'nope.png') }] }, opts({ provider: 'claude-cli', runCli }))).rejects.toMatchObject({ code: 'image' });
    expect(runs).toHaveLength(0);
  });

  it('the default runner runs a real process with the prompt on stdin', async () => {
    const script = join(dir, 'echo.mjs');
    writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({is_error:false,result:JSON.stringify({answers:[{id:'cut',p:s.includes('QUESTIONS')?0.8:0.1,choice:null,score:null}]})})));");
    const r = await defaultCliRunner(process.execPath, [script], { cwd: dir, input: 'QUESTIONS: …', timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(JSON.parse(JSON.parse(r.stdout).result).answers[0].p).toBe(0.8);
    const missing = await defaultCliRunner(join(dir, 'no-such-binary'), [], { cwd: dir, input: '', timeoutMs: 5_000 });
    expect(missing.code).toBe(127);
  });
});

describe('claude-cli and ANTHROPIC_API_KEY', () => {
  it('runs on the subscription first and falls back to the key only when that fails', async () => {
    const envs: (string | undefined)[] = [];
    const ok = JSON.stringify({ is_error: false, result: JSON.stringify(good) });
    let first = true;
    const runCli: DecideOptions['runCli'] = async (_f, _a, o) => {
      envs.push(o.env?.ANTHROPIC_API_KEY);
      if (first) {
        first = false;
        return { code: 1, stdout: JSON.stringify({ is_error: true, result: 'Not logged in' }), stderr: '' };
      }
      return { code: 0, stdout: ok, stderr: '' };
    };
    await decide(req, opts({ provider: 'claude-cli', runCli, env: { ANTHROPIC_API_KEY: 'sk-x', PATH: '/bin' } }));
    expect(envs).toEqual([undefined, 'sk-x']);
    const envs2: (string | undefined)[] = [];
    await decide({ ...req, state: { other: 1 } }, opts({ provider: 'claude-cli', env: { ANTHROPIC_API_KEY: 'sk-x' }, runCli: async (_f, _a, o) => {
      envs2.push(o.env?.ANTHROPIC_API_KEY);
      return { code: 0, stdout: ok, stderr: '' };
    } }));
    expect(envs2).toEqual([undefined]);   // the subscription worked: the key is never used
  });
});
