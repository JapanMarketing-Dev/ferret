import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '@video/cli';

export interface Run { code: number; stdout: string; stderr: string; json: any }

export class Sandbox {
  root = mkdtempSync(join(tmpdir(), 'ferret-video-cli-'));
  home = join(this.root, 'home');
  saved = { ...process.env };

  constructor() {
    process.env.FERRET_VIDEO_HOME = this.home;
    delete process.env.FERRET_VIDEO_TEMPLATES_DIR;
    // never download fonts in tests: an (empty) fonts folder means "use system fonts"
    mkdirSync(join(this.root, 'fonts'), { recursive: true });
    process.env.FERRET_VIDEO_FONTS = join(this.root, 'fonts');
    // never call a real agent CLI as the decision model (default 'auto' would find claude/codex on a dev machine)
    process.env.FERRET_VIDEO_DECISION_PROVIDER = 'off';
  }

  async run(args: string[], o: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}): Promise<Run> {
    let stdout = '';
    let stderr = '';
    const env: NodeJS.ProcessEnv = { ...process.env, FERRET_VIDEO_HOME: this.home, FERRET_VIDEO_FONTS: join(this.root, 'fonts'), FERRET_VIDEO_DECISION_PROVIDER: 'off' };
    // one PATH key only (Windows copies it as "Path")
    if (o.env && Object.keys(o.env).some((k) => k.toUpperCase() === 'PATH')) for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
    Object.assign(env, o.env);
    for (const k of ['CLAUDECODE', 'CODEX_SANDBOX', 'GEMINI_CLI', 'FERRET_VIDEO_AGENT', 'FERRET_VIDEO_BY', 'FERRET_VIDEO_AUTOPILOT']) if (!o.env?.[k]) delete env[k];
    const code = await main(args, {
      cwd: o.cwd ?? this.root,
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      env,
      readStdin: async () => o.stdin ?? '',
    });
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      json = undefined;
    }
    return { code, stdout, stderr, json };
  }

  dispose(): void {
    // restore in place: assigning a plain object to process.env breaks Windows' case-insensitive env
    for (const k of Object.keys(process.env)) if (!(k in this.saved)) delete process.env[k];
    for (const [k, v] of Object.entries(this.saved)) process.env[k] = v;
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** A fake command-line tool implemented in JavaScript: `name` (shebang) on POSIX, `name.cmd` → node on Windows. */
export function fakeNodeCli(binDir: string, name: string, js: string): void {
  writeFileSync(join(binDir, `${name}.js`), js);
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, `${name}.cmd`), `@echo off\r\nnode "%~dp0${name}.js" %*\r\n`);
  } else {
    writeFileSync(join(binDir, name), `#!/usr/bin/env node\n${js}`);
    chmodSync(join(binDir, name), 0o755);
  }
}
