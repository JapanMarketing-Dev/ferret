import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { videoHome } from '@video/toolchain';
import { SETTINGS_SECTIONS, SettingsSchema, type Settings } from './schema.js';

export const SETTINGS_SCHEMA_URL = 'urn:ferret:video:settings:v1';

export function settingsPath(): string {
  return join(videoHome(), 'settings.json');
}
export function settingsHistoryPath(): string {
  return join(videoHome(), 'settings.history.jsonl');
}

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

export interface SettingsIssue { path: string; message: string }

export class SettingsError extends Error {
  constructor(message: string, public readonly issues: SettingsIssue[] = []) {
    super(message);
    this.name = 'SettingsError';
  }
}

function issuesOf(e: z.ZodError, prefix: string[] = []): SettingsIssue[] {
  return e.issues.map((i) => ({ path: [...prefix, ...i.path.map(String)].join('.') || '(root)', message: i.message }));
}

/** Atomic write: temp file in the same directory + rename. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Parse raw settings JSON text. Invalid JSON → defaults + one error. A section with invalid values falls back to its
 * defaults (the rest is kept), and every problem is reported, so a broken file never stops the app.
 */
export function parseSettings(text: string | null): { settings: Settings; errors: SettingsIssue[] } {
  if (text === null) return { settings: defaultSettings(), errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (e) {
    return { settings: defaultSettings(), errors: [{ path: '(file)', message: `invalid JSON: ${(e as Error).message}` }] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings: defaultSettings(), errors: [{ path: '(root)', message: 'settings must be a JSON object' }] };
  }
  const whole = SettingsSchema.safeParse(raw);
  if (whole.success) return { settings: whole.data, errors: [] };
  const obj = { ...(raw as Record<string, unknown>) };
  const errors: SettingsIssue[] = [];
  for (const key of [...SETTINGS_SECTIONS, '$schema'] as const) {
    if (!(key in obj)) continue;
    const field = SettingsSchema.shape[key];
    const r = field.safeParse(obj[key]);
    if (!r.success) {
      errors.push(...issuesOf(r.error, [key]));
      delete obj[key];
    }
  }
  const retry = SettingsSchema.safeParse(obj);
  if (retry.success) return { settings: retry.data, errors };
  return { settings: defaultSettings(), errors: [...errors, ...issuesOf(retry.error)] };
}

/** Allow `//` and `/* *\/` comments (jsonc) outside strings. */
export function stripJsonComments(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out;
}

export function loadSettingsWithErrors(): { settings: Settings; errors: SettingsIssue[] } {
  const p = settingsPath();
  return parseSettings(existsSync(p) ? readFileSync(p, 'utf8') : null);
}

/** Defaults merged with ~/.ferret/video/settings.json. Invalid parts fall back to defaults (see loadSettingsWithErrors). */
export function loadSettings(): Settings {
  return loadSettingsWithErrors().settings;
}

/** Flatten to dot paths (arrays are leaves) for the change log. */
function flatten(v: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = v;
  return out;
}

export function diffSettings(a: unknown, b: unknown): { key: string; from: unknown; to: unknown }[] {
  const fa = flatten(a);
  const fb = flatten(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const out: { key: string; from: unknown; to: unknown }[] = [];
  for (const k of [...keys].sort()) {
    if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) out.push({ key: k, from: fa[k], to: fb[k] });
  }
  return out;
}

/** Validate, write atomically and append the change to settings.history.jsonl. */
export function saveSettings(s: Settings, o: { by?: string } = {}): void {
  const r = SettingsSchema.safeParse(s);
  if (!r.success) throw new SettingsError('invalid settings', issuesOf(r.error));
  const before = loadSettings();
  const next = { $schema: SETTINGS_SCHEMA_URL, ...r.data };
  writeFileAtomic(settingsPath(), JSON.stringify(next, null, 2) + '\n');
  const changes = diffSettings({ ...before, $schema: undefined }, { ...next, $schema: undefined });
  if (changes.length) {
    appendFileSync(settingsHistoryPath(), JSON.stringify({ at: new Date().toISOString(), by: o.by ?? 'user', changes }) + '\n');
  }
}

export function splitKey(key: string): string[] {
  if (!key || key.startsWith('.') || key.endsWith('.') || key.includes('..')) throw new SettingsError(`invalid key: "${key}"`);
  return key.split('.');
}

export function getPath(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(p)) return undefined;
      cur = cur[Number(p)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
  }
  return cur;
}

function setPath(obj: unknown, parts: string[], value: unknown): unknown {
  const [head, ...rest] = parts;
  if (head === undefined) return value;
  if (head === '__proto__' || head === 'constructor' || head === 'prototype') throw new SettingsError(`invalid key segment: ${head}`);
  if (Array.isArray(obj)) {
    if (!/^\d+$/.test(head)) throw new SettingsError(`"${head}" is not an array index`);
    const copy = [...obj];
    copy[Number(head)] = setPath(copy[Number(head)], rest, value);
    return copy;
  }
  const base = obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {};
  return { ...base, [head]: setPath(base[head], rest, value) };
}

/** Read a setting by dot path ("decision.limits.perDayUsd"). Unknown keys → undefined. */
export function getSetting(key: string): unknown {
  return getPath(loadSettings(), splitKey(key));
}

/** Validate a dot-path change against the schema without saving. Throws SettingsError with the issues. */
export function applySetting(current: Settings, key: string, value: unknown): Settings {
  const parts = splitKey(key);
  if (parts[0] === '$schema') throw new SettingsError('"$schema" cannot be set');
  if (!(SETTINGS_SECTIONS as string[]).includes(parts[0]!)) throw new SettingsError(`unknown setting: ${key}`);
  const candidate = setPath(current, parts, value);
  const r = SettingsSchema.safeParse(candidate);
  if (!r.success) throw new SettingsError(`invalid value for ${key}`, issuesOf(r.error));
  // zod strips unknown keys: if the value did not survive, the key does not exist in the schema
  if (JSON.stringify(getPath(r.data, parts)) !== JSON.stringify(value)) {
    const got = getPath(r.data, parts);
    if (got === undefined) throw new SettingsError(`unknown setting: ${key}`);
  }
  return r.data;
}

export function setSetting(key: string, value: unknown, o: { by?: string } = {}): Settings {
  const next = applySetting(loadSettings(), key, value);
  saveSettings(next, o);
  return next;
}

/** CLI helper: parse a command-line value as JSON when possible ("true", "3", "[\"a\"]"), else as a string. */
export function parseCliValue(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function settingsJsonSchema(): object {
  const s = z.toJSONSchema(SettingsSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return { $id: SETTINGS_SCHEMA_URL, title: 'Ferret video settings', ...s };
}
