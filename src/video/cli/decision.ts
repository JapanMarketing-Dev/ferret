import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCliProvider, resolveProvider, type DecideOptions, type Provider } from '@video/decide';
import { loadSettings } from '@video/settings';
import { whichSync } from '@video/toolchain';
import type { Ctx } from './ctx.js';
import { apiKeyFor } from './keys.js';
import { paths, type Project } from './project.js';

// The optional decision model for CLI judgements (cut candidates, thumbnail frames). Default `off`: every step works
// without it (rules + the agent's own judgement, unsure results marked needsReview). `auto` uses the user's own agent
// CLI (claude → codex → gemini), so it never needs an API key. Env FERRET_VIDEO_DECISION_PROVIDER overrides the setting.

export interface DecisionSetup {
  provider: Provider;
  options: DecideOptions;
}

interface LogLine { at?: string; costUsd?: number; calls?: number }

function spent(p: Project): { usd: number; todayUsd: number; calls: number } {
  const today = new Date().toISOString().slice(0, 10);
  const out = { usd: 0, todayUsd: 0, calls: 0 };
  try {
    for (const line of readFileSync(paths(p.dir).decisions, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as LogLine;
      out.usd += e.costUsd ?? 0;
      out.calls += e.calls ?? 0;
      if (e.at?.startsWith(today)) out.todayUsd += e.costUsd ?? 0;
    }
  } catch {
    /* no log yet */
  }
  return out;
}

/** The configured provider with `auto` resolved against PATH. */
export function decisionProvider(ctx: Ctx): Provider {
  const s = loadSettings();
  const setting = ctx.io.env.FERRET_VIDEO_DECISION_PROVIDER?.trim() || s.decision.provider;
  return resolveProvider(setting, (cmd) => whichSync(cmd, ctx.io.env));
}

/**
 * Options for @video/decide, or null with a reason when no model can be used (off, no consent for a cloud API,
 * missing key). Usage is appended to .ferret-video/decisions.jsonl with `kind`.
 */
export function decisionSetup(ctx: Ctx, p: Project, kind: string, extra: Record<string, unknown> = {}): DecisionSetup | { provider: Provider; skip: string } {
  const s = loadSettings();
  const provider = decisionProvider(ctx);
  if (provider === 'off') return { provider, skip: 'off' };
  const cli = isCliProvider(provider);
  const local = provider === 'ollama' || (!!s.decision.endpoint && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(s.decision.endpoint));
  // an agent CLI is the user's own subscription (the same agent already reads this project): no separate consent
  if (!cli && !local && !s.decision.cloudConsent) return { provider, skip: 'consent' };
  const key = cli ? undefined : apiKeyFor(ctx.io.env, s.decision.apiKeyRef, provider);
  const used = spent(p);
  const options: DecideOptions = {
    provider, model: s.decision.model, cacheDir: join(paths(p.dir).cache, 'decisions'), env: ctx.io.env,
    ...(s.decision.endpoint && !cli ? { endpoint: s.decision.endpoint } : {}),
    ...(key ? { apiKey: key } : {}),
    ...(cli
      ? { command: whichSync(provider.replace(/-cli$/, ''), ctx.io.env) ?? undefined, callBudget: { remaining: Math.max(0, s.decision.limits.perProjectCalls - used.calls) } }
      : { budget: { remainingUsd: Math.max(0, Math.min(s.decision.limits.perProjectUsd - used.usd, s.decision.limits.perDayUsd - used.todayUsd, s.autopilot.budget.decisionUsd - used.usd)) } }),
    onUsage: (u) => appendFileSync(paths(p.dir).decisions, JSON.stringify({ at: new Date().toISOString(), kind, ...extra, ...u }) + '\n'),
  };
  if (options.command === undefined) delete options.command;
  return { provider, options };
}

export const isSkip = (x: DecisionSetup | { skip: string }): x is { provider: Provider; skip: string } => 'skip' in x;
