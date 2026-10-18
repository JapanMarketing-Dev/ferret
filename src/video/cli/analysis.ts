import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonl, type CursorEvent, type FaceTrack, type KeyEvent, type PiiAnalysis, type Timeline, type Tracks } from '@video/core';

// Analysis files the desktop app (and `ferret-video analyze`) writes under derived/analysis/ (CONTRACTS.md, core tracking):
//   faces.<sourceId>.json   FaceTrack            cursor.<takeId>.jsonl  CursorEvent per line
//   pii.<sourceId>.json     PiiAnalysis          keys.<takeId>.jsonl    KeyEvent per line
//   cuts.<sourceId>.json    number[] (source seconds of shot changes)
// Cursor/key logs are also looked up where the recorder left them: the screen source's cursorLog/keyLog and
// media/takes/<take>/{cursor,keys}.jsonl.

export interface LoadedAnalysis {
  tracks: Tracks;
  pii: Record<string, PiiAnalysis>;
  /** Project-relative files that were read. */
  files: string[];
  /** Files that exist but could not be read. */
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function validFaces(v: unknown): v is FaceTrack {
  return isObj(v) && typeof v.fps === 'number' && v.fps > 0 && Array.isArray(v.frames);
}

function validPii(v: unknown): v is PiiAnalysis {
  return isObj(v) && Array.isArray(v.frames) && v.frames.every((f) => isObj(f) && typeof f.f === 'number' && Array.isArray(f.boxes));
}

export function loadAnalysis(dir: string, tl: Timeline): LoadedAnalysis {
  const out: LoadedAnalysis = { tracks: {}, pii: {}, files: [], warnings: [] };
  const analysis = join(dir, 'derived', 'analysis');
  const readJson = (rel: string, check: (v: unknown) => boolean): unknown => {
    const f = join(dir, rel);
    if (!existsSync(f)) return undefined;
    try {
      const v = JSON.parse(readFileSync(f, 'utf8')) as unknown;
      if (!check(v)) throw new Error('unexpected shape');
      out.files.push(rel);
      return v;
    } catch (e) {
      out.warnings.push(`${rel}: ${(e as Error).message}`);
      return undefined;
    }
  };
  const readLog = <T>(rels: (string | undefined)[], valid: (x: unknown) => boolean): T[] | undefined => {
    for (const rel of rels) {
      if (!rel || !existsSync(join(dir, rel))) continue;
      const list = parseJsonl<unknown>(readFileSync(join(dir, rel), 'utf8')).filter(valid) as T[];
      out.files.push(rel);
      return list;
    }
    return undefined;
  };
  const a = (name: string) => `derived/analysis/${name}`;
  if (!existsSync(analysis) && !Object.values(tl.sources).some((s) => s.kind === 'screen')) return out;

  for (const [id, s] of Object.entries(tl.sources)) {
    if (s.kind !== 'camera' && s.kind !== 'screen') continue;
    const faces = readJson(a(`faces.${id}.json`), validFaces);
    if (faces) (out.tracks.faces ??= {})[id] = faces as FaceTrack;
    const pii = readJson(a(`pii.${id}.json`), validPii);
    if (pii) out.pii[id] = pii as PiiAnalysis;
    const cuts = readJson(a(`cuts.${id}.json`), (v) => Array.isArray(v) && v.every((x) => typeof x === 'number'));
    if (cuts) (out.tracks.cuts ??= {})[id] = cuts as number[];
  }
  const takes = [...new Set(Object.values(tl.sources).map((s) => ('take' in s ? s.take : undefined)).filter((x): x is string => !!x))].sort();
  const cursorOk = (x: unknown) => isObj(x) && typeof x.t_ms === 'number' && typeof x.x === 'number' && typeof x.y === 'number';
  const keyOk = (x: unknown) => isObj(x) && typeof x.t_ms === 'number' && Array.isArray(x.keys);
  for (const take of takes) {
    const screen = Object.values(tl.sources).find((s) => s.kind === 'screen' && s.take === take) as { cursorLog?: string; keyLog?: string } | undefined;
    const cursor = readLog<CursorEvent>([a(`cursor.${take}.jsonl`), screen?.cursorLog, `media/takes/${take}/cursor.jsonl`], cursorOk);
    if (cursor?.length) (out.tracks.cursor ??= {})[take] = cursor;
    const keys = readLog<KeyEvent>([a(`keys.${take}.jsonl`), screen?.keyLog, `media/takes/${take}/keys.jsonl`], keyOk);
    if (keys?.length) (out.tracks.keys ??= {})[take] = keys;
  }
  return out;
}

/** Camera sources a segment could switch between (multicam needs at least two). */
export function cameraCount(tl: Timeline): number {
  return Object.values(tl.sources).filter((s) => s.kind === 'camera').length;
}
