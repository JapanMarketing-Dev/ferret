import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { videoHome } from '@video/toolchain';
import { TemplateFileSchema, type TemplateFile } from './schema.js';

export interface Template extends Omit<TemplateFile, 'abstract' | 'alias'> {
  /** Folder of the template (the child, when it extends another). */
  dir: string;
  /** rules.md of the whole extends chain, base first. */
  rules: string;
  /** prompts/<name>.md contents by name (child overrides parent). */
  prompts: Record<string, string>;
  /** Absolute path of each prompt file. */
  promptFiles: Record<string, string>;
  /** Ids from this template up to the root base. */
  chain: string[];
  abstract: boolean;
  alias: boolean;
}

export class TemplateError extends Error {
  constructor(message: string, public readonly file?: string, public readonly issues: { path: string; message: string }[] = []) {
    super(message);
    this.name = 'TemplateError';
  }
}

const here = dirname(fileURLToPath(import.meta.url));

/** 組み込みテンプレートの環境変数（アプリが out/video-cli/templates を渡す） */
export const TEMPLATES_DIR_ENV = 'FERRET_VIDEO_TEMPLATES_DIR';

/**
 * Built-in templates: $FERRET_VIDEO_TEMPLATES_DIR, next to the bundled CLI (out/video-cli/templates),
 * or the source tree's src/video/builtin-templates (development and unit tests).
 */
export function builtinTemplatesDir(): string {
  const env = process.env[TEMPLATES_DIR_ENV];
  if (env && env.trim()) return resolve(env);
  const candidates = [join(here, 'templates'), join(here, '..', 'builtin-templates')];
  return candidates.find((c) => existsSync(c) && statSync(c).isDirectory()) ?? candidates[candidates.length - 1]!;
}

export function userTemplatesDir(): string {
  return join(videoHome(), 'templates');
}

/** Search order: extra dirs (e.g. <project>/templates) → ~/.ferret/video/templates → built-in. */
export function templateSearchDirs(extraDirs: string[] = []): string[] {
  return [...extraDirs, userTemplatesDir(), builtinTemplatesDir()];
}

export interface LoadOptions { extraDirs?: string[] }

interface RawTemplate { dir: string; raw: Record<string, unknown> }

function readRaw(dir: string): RawTemplate {
  const file = join(dir, 'template.yaml');
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new TemplateError(`cannot read ${file}: ${(e as Error).message}`, file);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TemplateError(`${file} must be a YAML mapping`, file);
  return { dir, raw: raw as Record<string, unknown> };
}

function findDir(id: string, dirs: string[], skip?: string): string | null {
  for (const d of dirs) {
    const candidate = join(d, id);
    if (skip && resolve(candidate) === resolve(skip)) continue;
    if (existsSync(join(candidate, 'template.yaml'))) return candidate;
  }
  return null;
}

/** Objects merge key by key; arrays and scalars from the child replace the parent's. */
export function deepMerge(parent: unknown, child: unknown): unknown {
  if (isPlain(parent) && isPlain(child)) {
    const out: Record<string, unknown> = { ...parent };
    for (const [k, v] of Object.entries(child)) out[k] = k in out ? deepMerge(out[k], v) : v;
    return out;
  }
  return child === undefined ? parent : child;
}
function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readPrompts(dir: string): Record<string, string> {
  const p = join(dir, 'prompts');
  const out: Record<string, string> = {};
  if (!existsSync(p)) return out;
  for (const f of readdirSync(p).sort()) if (f.endsWith('.md')) out[f.slice(0, -3)] = join(p, f);
  return out;
}

function readText(p: string): string {
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
}

/** Resolve the extends chain of the template in `dir`. */
function loadFromDir(dir: string, dirs: string[]): Template {
  const chain: RawTemplate[] = [];
  const seen = new Set<string>();
  let cur: RawTemplate = readRaw(dir);
  for (;;) {
    const id = String(cur.raw.id ?? '');
    const key = resolve(cur.dir);
    if (seen.has(key)) throw new TemplateError(`extends cycle: ${[...chain.map((c) => String(c.raw.id)), id].join(' → ')}`, join(dir, 'template.yaml'));
    seen.add(key);
    chain.push(cur);
    const parentId = cur.raw.extends;
    if (parentId === undefined || parentId === null) break;
    if (typeof parentId !== 'string') throw new TemplateError(`extends must be a template id`, join(cur.dir, 'template.yaml'));
    // a template may extend one with the same id from a lower-priority dir (user override of a built-in)
    // (search only the dirs after the current one, so project → user → built-in overrides chain without a cycle)
    const below = parentId === id ? dirs.slice(dirs.findIndex((d) => resolve(join(d, id)) === resolve(cur.dir)) + 1) : dirs;
    const parentDir = findDir(parentId, below, parentId === id ? cur.dir : undefined);
    if (!parentDir) throw new TemplateError(`template "${id}" extends unknown template "${parentId}"`, join(cur.dir, 'template.yaml'));
    if (chain.length > 16) throw new TemplateError('extends chain too deep', join(dir, 'template.yaml'));
    cur = readRaw(parentDir);
  }
  // merge root → leaf
  let merged: unknown = {};
  for (const t of [...chain].reverse()) {
    const { extends: _e, abstract: _a, alias: _al, ...rest } = t.raw;
    merged = deepMerge(merged, rest);
  }
  const leaf = chain[0]!;
  if (leaf.raw.id !== basename(leaf.dir)) {
    throw new TemplateError(`template id "${String(leaf.raw.id)}" must match its folder name "${basename(leaf.dir)}"`, join(leaf.dir, 'template.yaml'));
  }
  (merged as Record<string, unknown>).abstract = leaf.raw.abstract ?? false;
  (merged as Record<string, unknown>).alias = leaf.raw.alias ?? false;
  (merged as Record<string, unknown>).id = leaf.raw.id;
  const parsed = TemplateFileSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
    throw new TemplateError(
      `invalid template ${join(leaf.dir, 'template.yaml')}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      join(leaf.dir, 'template.yaml'),
      issues,
    );
  }
  const promptFiles: Record<string, string> = {};
  const rules: string[] = [];
  for (const t of [...chain].reverse()) {
    Object.assign(promptFiles, readPrompts(t.dir));
    const r = readText(join(t.dir, 'rules.md'));
    if (r) rules.push(r);
  }
  const prompts: Record<string, string> = {};
  for (const [k, p] of Object.entries(promptFiles)) prompts[k] = readText(p);
  return {
    ...parsed.data,
    dir: leaf.dir,
    rules: rules.join('\n\n'),
    prompts,
    promptFiles,
    chain: chain.map((c) => String(c.raw.id)),
  };
}

export function loadTemplate(id: string, o: LoadOptions = {}): Template {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new TemplateError(`invalid template id: ${id}`);
  const dirs = templateSearchDirs(o.extraDirs);
  const dir = findDir(id, dirs);
  if (!dir) throw new TemplateError(`template not found: ${id}`);
  return loadFromDir(dir, dirs);
}

export function listTemplatesWithErrors(o: LoadOptions & { includeAbstract?: boolean } = {}): { templates: Template[]; errors: TemplateError[] } {
  const dirs = templateSearchDirs(o.extraDirs);
  const seen = new Set<string>();
  const templates: Template[] = [];
  const errors: TemplateError[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d).sort()) {
      if (seen.has(name) || !existsSync(join(d, name, 'template.yaml'))) continue;
      seen.add(name);
      try {
        const t = loadFromDir(join(d, name), dirs);
        if ((!t.abstract && !t.alias) || o.includeAbstract) templates.push(t);
      } catch (e) {
        errors.push(e instanceof TemplateError ? e : new TemplateError(String(e)));
      }
    }
  }
  return { templates, errors };
}

/** Usable templates (abstract bases and aliases excluded); a user template shadows a built-in with the same id. */
export function listTemplates(o: LoadOptions = {}): Template[] {
  return listTemplatesWithErrors(o).templates;
}
