import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicOutput } from './proxy.js';
import { runFfmpeg } from './run.js';

// Built-in sound effects (request: "効果音もない"): a small, license-free set synthesized with ffmpeg on first use —
// nothing is downloaded. Every recipe is a fixed lavfi expression (noise uses a fixed seed), so the same ffmpeg makes
// the same files. Written to <dir>/<category>/<name>.wav (48 kHz mono s16) with a <name>.json sidecar (docs/16) that
// the sfx library reads. Our own synthesis: CC0, no credit needed.

export interface SfxRecipe {
  category: 'pop' | 'whoosh' | 'ding' | 'click' | 'typing' | 'swoosh-in' | 'impact';
  name: string;
  durationSec: number;
  /** lavfi source (aevalsrc / anoisesrc …). */
  source: string;
  /** Optional -af chain (filters, envelope, fades). */
  filter?: string;
}

const SR = 48000;
const n = (v: number) => String(Math.round(v * 1e6) / 1e6);

/** A short sine blip that falls in pitch: f(t) = f0 · (1 − drop·t/d). */
function pop(name: string, f0: number, d: number, drop: number): SfxRecipe {
  const k = (f0 * drop) / (2 * d);
  return {
    category: 'pop', name, durationSec: d,
    source: `aevalsrc='0.8*sin(2*PI*(${n(f0)}*t-${n(k)}*t*t))*exp(-t*${n(6 / d)})*min(1,t*400)':s=${SR}:d=${n(d)}`,
  };
}

/** A tiny high click. */
function click(name: string, f: number, d: number): SfxRecipe {
  return { category: 'click', name, durationSec: d, source: `aevalsrc='0.7*sin(2*PI*${n(f)}*t)*exp(-t*${n(8 / d)})':s=${SR}:d=${n(d)}` };
}

/** A bell: three inharmonic partials with exponential decay. */
function ding(name: string, f: number, d: number): SfxRecipe {
  return {
    category: 'ding', name, durationSec: d,
    source: `aevalsrc='(0.5*sin(2*PI*${n(f)}*t)+0.25*sin(2*PI*${n(f * 2.76)}*t)+0.12*sin(2*PI*${n(f * 5.4)}*t))*exp(-t*${n(4 / d)})*min(1,t*300)':s=${SR}:d=${n(d)}`,
  };
}

/** Filtered noise swelling in and out (a pass-by). */
function whoosh(name: string, d: number, seed: number, lo: number, hi: number): SfxRecipe {
  return {
    category: 'whoosh', name, durationSec: d,
    source: `anoisesrc=color=pink:seed=${seed}:sample_rate=${SR}:amplitude=0.9:d=${n(d)}`,
    filter: `highpass=f=${lo},lowpass=f=${hi},volume='2.6*pow(sin(PI*t/${n(d)}),2)':eval=frame,afade=t=out:st=${n(d * 0.85)}:d=${n(d * 0.15)}`,
  };
}

/** Noise that rises toward the end (leads into a cut or a zoom-in). */
function swooshIn(name: string, d: number, seed: number, hi: number): SfxRecipe {
  return {
    category: 'swoosh-in', name, durationSec: d,
    source: `anoisesrc=color=white:seed=${seed}:sample_rate=${SR}:amplitude=0.7:d=${n(d)}`,
    filter: `highpass=f=800,lowpass=f=${hi},volume='1.5*pow(t/${n(d)},2)':eval=frame,afade=t=out:st=${n(d * 0.9)}:d=${n(d * 0.1)}`,
  };
}

/** A low thump with a falling pitch and a short noise transient. */
function impact(name: string, f0: number, d: number): SfxRecipe {
  return {
    category: 'impact', name, durationSec: d,
    source: `aevalsrc='0.65*sin(2*PI*(${n(f0)}*t-${n(f0 * 0.6)}*t*t))*exp(-t*${n(5 / d)})+0.2*sin(2*PI*${n(f0 * 7.1)}*t)*exp(-t*60)':s=${SR}:d=${n(d)}`,
  };
}

/** Key presses: a click every `period` s whose loudness varies with a slow pattern (not a metronome). */
function typing(name: string, period: number, d: number): SfxRecipe {
  return {
    category: 'typing', name, durationSec: d,
    source: `aevalsrc='(0.35+0.25*sin(t*7.3)*sin(t*3.1))*sin(2*PI*3200*t)*exp(-mod(t,${n(period)})*260)+0.1*sin(2*PI*900*t)*exp(-mod(t,${n(period)})*120)':s=${SR}:d=${n(d)}`,
  };
}

export const SFX_RECIPES: readonly SfxRecipe[] = [
  pop('pop-1', 900, 0.12, 0.5), pop('pop-2', 650, 0.14, 0.45), pop('pop-3', 1200, 0.1, 0.6),
  click('click-1', 3000, 0.03), click('click-2', 2400, 0.04), click('click-3', 4200, 0.025),
  ding('ding-1', 1318.5, 1.2), ding('ding-2', 1046.5, 1), ding('ding-3', 1568, 0.9),
  whoosh('whoosh-1', 0.6, 11, 300, 4000), whoosh('whoosh-2', 0.45, 23, 500, 6000), whoosh('whoosh-3', 0.8, 37, 200, 3000),
  swooshIn('swoosh-in-1', 0.5, 41, 7000), swooshIn('swoosh-in-2', 0.35, 53, 9000), swooshIn('swoosh-in-3', 0.7, 67, 5000),
  impact('impact-1', 90, 0.6), impact('impact-2', 70, 0.8), impact('impact-3', 120, 0.45),
  typing('typing-1', 0.11, 1.5), typing('typing-2', 0.09, 1.2), typing('typing-3', 0.14, 2),
];

export const SFX_CATEGORIES = [...new Set(SFX_RECIPES.map((r) => r.category))];

/** ffmpeg arguments that render one recipe to `out`. */
export function sfxArgs(r: SfxRecipe, out: string): string[] {
  return ['-f', 'lavfi', '-i', r.source, ...(r.filter ? ['-af', r.filter] : []), '-t', n(r.durationSec), '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', out];
}

/** Sidecar for the library (docs/16): id, category, duration, license. No author: nothing to credit. */
export function sfxSidecar(r: SfxRecipe): Record<string, unknown> {
  return {
    id: `sfx_${r.category}_builtin_${r.name.split('-').pop()}`, kind: 'sfx', category: r.category, title: r.name,
    features: { durationMs: Math.round(r.durationSec * 1000) }, license: { spdx: 'CC0-1.0' }, generatedBy: 'ferret-video',
  };
}

/** Fingerprint of the recipe set: a change regenerates every file. */
export function recipesVersion(recipes: readonly SfxRecipe[] = SFX_RECIPES): string {
  return createHash('sha256').update(JSON.stringify(recipes)).digest('hex').slice(0, 16);
}

/**
 * Make sure the built-in set exists in `dir` (missing files, or all of them when the recipes changed). Returns the
 * files written. `run` is injectable for tests.
 */
export async function ensureBuiltinSfx(dir: string, o: { run?: (args: string[]) => Promise<void>; recipes?: readonly SfxRecipe[] } = {}): Promise<string[]> {
  const recipes = o.recipes ?? SFX_RECIPES;
  const run = o.run ?? ((args: string[]) => runFfmpeg(args));
  const version = recipesVersion(recipes);
  const marker = join(dir, '.version');
  const stale = !existsSync(marker) || readFileSync(marker, 'utf8').trim() !== version;
  const written: string[] = [];
  for (const r of recipes) {
    const out = join(dir, r.category, `${r.name}.wav`);
    if (!stale && existsSync(out)) continue;
    mkdirSync(join(dir, r.category), { recursive: true });
    await atomicOutput(out, (tmp) => run(sfxArgs(r, tmp)));
    writeFileSync(join(dir, r.category, `${r.name}.json`), JSON.stringify(sfxSidecar(r), null, 2) + '\n');
    written.push(out);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, version + '\n');
  return written;
}
