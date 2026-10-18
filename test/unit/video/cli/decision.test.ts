import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide } from '@video/decide';
import type { Ctx } from '@video/cli/ctx.js';
import { decisionProvider, decisionSetup, isSkip } from '@video/cli/decision.js';
import type { Project } from '@video/cli/project.js';
import { Sandbox, fakeNodeCli } from './helpers.js';

// decision.provider 'auto' → the user's agent CLI; budgets in calls; env override; consent only for cloud APIs.

let sb: Sandbox;
let bin: string;
let p: Project;
beforeEach(() => {
  sb = new Sandbox();
  bin = join(sb.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const dir = join(sb.root, 'proj');
  mkdirSync(join(dir, '.ferret-video'), { recursive: true });
  p = { dir, file: { schema: 1, id: 'prj_t', title: 't', template: { id: 'talk', version: '2' }, language: 'ja', created: '' }, variant: null };
});
afterEach(() => sb.dispose());

const ctx = (env: Record<string, string>): Ctx => ({ io: { env: { PATH: bin, ...env } } } as unknown as Ctx);
const settings = (decision: object) => writeFileSync(join(sb.home, 'settings.json'), JSON.stringify({ decision }));

describe('decision provider selection', () => {
  beforeEach(() => mkdirSync(sb.home, { recursive: true }));

  it('auto resolves to the first installed agent CLI; nothing installed → off', () => {
    settings({ provider: 'auto' });
    expect(decisionProvider(ctx({}))).toBe('off');
    fakeNodeCli(bin, 'gemini', '');
    expect(decisionProvider(ctx({}))).toBe('gemini-cli');
    fakeNodeCli(bin, 'codex', '');
    expect(decisionProvider(ctx({}))).toBe('codex-cli');
    fakeNodeCli(bin, 'claude', '');
    expect(decisionProvider(ctx({}))).toBe('claude-cli');
    expect(decisionProvider(ctx({ FERRET_VIDEO_DECISION_PROVIDER: 'off' }))).toBe('off');
    expect(decisionProvider(ctx({ FERRET_VIDEO_DECISION_PROVIDER: 'codex-cli' }))).toBe('codex-cli');
  });

  it('agent CLIs need no key or consent and are budgeted in calls; cloud APIs need consent', () => {
    fakeNodeCli(bin, 'claude', '');
    settings({ provider: 'auto', limits: { perProjectCalls: 5 } });
    writeFileSync(join(p.dir, '.ferret-video', 'decisions.jsonl'), [{ calls: 1 }, { calls: 0 }, { calls: 1 }, 'torn'].map((x) => JSON.stringify(x)).join('\n'));
    const s = decisionSetup(ctx({}), p, 'cut');
    expect(isSkip(s)).toBe(false);
    if (isSkip(s)) return;
    expect(s.options).toMatchObject({ provider: 'claude-cli', callBudget: { remaining: 3 } });
    expect(s.options.command).toContain('claude');
    expect(s.options.apiKey).toBeUndefined();
    expect(s.options.budget).toBeUndefined();
    settings({ provider: 'openai' });
    expect(decisionSetup(ctx({}), p, 'cut')).toEqual({ provider: 'openai', skip: 'consent' });
    settings({ provider: 'openai', cloudConsent: true });
    const o = decisionSetup(ctx({ FERRET_VIDEO_OPENAI_API_KEY: 'k' }), p, 'cut');
    expect(!isSkip(o) && o.options).toMatchObject({ apiKey: 'k', budget: { remainingUsd: 2 } });
    settings({ provider: 'ollama' });
    expect(isSkip(decisionSetup(ctx({}), p, 'cut'))).toBe(false);
    settings({ provider: 'off' });
    expect(decisionSetup(ctx({}), p, 'cut')).toEqual({ provider: 'off', skip: 'off' });
  });

  it('end to end with a fake claude: one call answers a batch, usage is logged with calls', async () => {
    fakeNodeCli(bin, 'claude', `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const ids=[...s.matchAll(/"id": "(c[0-9]+)"/g)].map(m=>m[1]);
      const uniq=[...new Set(ids)];
      process.stdout.write(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({answers:uniq.map(id=>({id,p:0.9,choice:null,score:null}))})}));
    });`);
    settings({ provider: 'auto' });
    const env = { PATH: [bin, process.env.PATH ?? ''].join(delimiter) };
    const s = decisionSetup(ctx(env), p, 'cut', { batch: 1 });
    if (isSkip(s)) throw new Error('skipped');
    const a = await decide({ state: { candidates: [] }, questions: [{ id: 'c0', kind: 'yesno', text: 'a' }, { id: 'c1', kind: 'yesno', text: 'b' }] }, s.options);
    expect(a).toEqual([{ id: 'c0', p: 0.9 }, { id: 'c1', p: 0.9 }]);
    const log = readFileSync(join(p.dir, '.ferret-video', 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({ kind: 'cut', batch: 1, provider: 'claude-cli', calls: 1, costUsd: 0 });
  }, 30_000);
});
