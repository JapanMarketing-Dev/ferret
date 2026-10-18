import { createInterface } from 'node:readline';
import { loadSettings } from '@video/settings';
import { createMcpServer } from './mcp.js';
import { parseVariant } from './project.js';
import { CliError, CLI_VERSION, type Ctx, type IO, type Lang } from './ctx.js';
import {
  cmdConfig, cmdDoctor, cmdInit, cmdLib, cmdNext, cmdPrompts, cmdStatus, cmdStep, cmdTemplates, cmdValidate, cmdVersion,
} from './commands/basic.js';
import { cmdEdit, cmdHistory, cmdTl, cmdUndo } from './commands/edit.js';
import {
  cmdAnalyze, cmdCaptions, cmdCheck, cmdFrame, cmdImport, cmdIngest, cmdPropose, cmdRender, cmdSync, cmdTakes, cmdTranscribe,
} from './commands/media.js';
import { cmdPast } from './commands/past.js';
import { cmdMeta } from './commands/meta.js';
import { cmdThumb } from './commands/thumb.js';
import { cmdFeedback } from './commands/feedback.js';
import { cmdPublish } from './commands/publish.js';
import { cmdMigrate } from './commands/migrate.js';
import { explainError, localize } from './errors.js';
import { cmdBench, cmdMasks, cmdMulticam, cmdSfx, cmdTracks } from './commands/assist.js';

export { CliError, CLI_VERSION } from './ctx.js';
export type { IO } from './ctx.js';

type Handler = (ctx: Ctx, args: string[]) => Promise<void>;

/** `ferret-video mcp`: serve the CLI as MCP tools over stdio until stdin closes. */
async function cmdMcp(ctx: Ctx, args: string[]): Promise<void> {
  if (args.length) throw new CliError('usage', 'usage: ferret-video mcp [--project <dir>]');
  if (!ctx.io.stdinLines) throw new CliError('usage', 'stdin is not available');
  const server = createMcpServer(async (argv) => {
    let stdout = '';
    let stderr = '';
    const code = await main(argv, { cwd: ctx.io.cwd, env: ctx.io.env, stdout: (x) => (stdout += x), stderr: (x) => (stderr += x) });
    return { code, stdout, stderr };
  }, ctx.projectFlag ? { defaultProject: ctx.projectFlag } : {});
  for await (const line of ctx.io.stdinLines()) {
    const out = await server.handleLine(line);
    if (out) ctx.io.stdout(out + '\n');
  }
}

const COMMANDS: Record<string, Handler> = {
  init: cmdInit,
  status: cmdStatus,
  next: cmdNext,
  step: cmdStep,
  takes: cmdTakes,
  ingest: cmdIngest,
  import: cmdImport,
  sync: cmdSync,
  transcribe: cmdTranscribe,
  analyze: cmdAnalyze,
  propose: cmdPropose,
  edit: cmdEdit,
  undo: (c, a) => cmdUndo(c, a, false),
  redo: (c, a) => cmdUndo(c, a, true),
  history: cmdHistory,
  validate: cmdValidate,
  captions: cmdCaptions,
  render: cmdRender,
  frame: cmdFrame,
  check: cmdCheck,
  tl: cmdTl,
  past: cmdPast,
  meta: cmdMeta,
  thumb: cmdThumb,
  feedback: cmdFeedback,
  sfx: cmdSfx,
  masks: cmdMasks,
  multicam: cmdMulticam,
  tracks: cmdTracks,
  bench: cmdBench,
  publish: cmdPublish,
  config: cmdConfig,
  prompts: cmdPrompts,
  templates: cmdTemplates,
  lib: cmdLib,
  doctor: cmdDoctor,
  version: cmdVersion,
  mcp: cmdMcp,
  migrate: cmdMigrate,
};

const HELP: Record<Lang, string> = {
  ja: `ferret-video ${CLI_VERSION} — テンプレートで動画を編集する CLI（エージェント向け。どのコマンドも --json 可）

はじめに
  init [dir] [--template tech]   プロジェクトを作る（AGENTS.md / CLAUDE.md も生成）
  status / next                  進み具合 / 次にやること（まずこれ）
  step <step> done|skipped       手作業の手順を終えた印
素材
  ingest / takes                 収録したテイクを登録 / 一覧
  import <file> [--take] [--role]  別撮りの素材を取り込む
  sync / transcribe / analyze    同期 / 文字起こし / 解析
編集
  propose cuts [--replace]       カットの候補から区間を作る
  edit <op> --<field> <v> --reason "<なぜ>" | edit --ops <file|json|->
  undo / redo / history / validate
  captions build                 字幕を作る
  multicam material              カメラ切り替えの材料 → edit split-for-switch --segment <id> --at <素材フレーム,…>
  sfx apply                      テンプレートの効果音ルールで効果音を入れる
  tracks apply                   人物の顔を中央に保つ切り抜き、カーソルを追うズーム、クリック・キー表示
  masks from-analysis            画面の個人情報にモザイク（要確認）
  tl summary|show|range|query|why  timeline.json を必要な分だけ読む
書き出しと確認
  render --preview | --final [--target youtube]
  frame --at <frame|timecode>    1フレームの静止画
  check                          機械的チェック（checks/<run>/report.md）
  thumb pick <画像> | thumb candidates | thumb gen --provider codex|frame --title "見出し"   サムネイル（publish.json）
  meta set --title … --description … --tags a,b | meta show | meta check   投稿の内容（publish.json）
  publish upload [--target youtube|tiktok]   publish.json の内容でアプリに投稿を頼み、結果を待つ（人が OK してから）
  publish record --target t --status published --url <url>   投稿の結果を記録
  feedback import <dir> | list | show <id> | done <id>        動画フィードバック
そのほか
  past list|search|show|timeline|compare|reuse|register   過去の動画
  bench profile <samples.json> | bench apply <profile> --template <id>   参考動画の傾向をテンプレートへ
  mcp                            MCP サーバー（stdio）
  migrate [dir]                  旧 Solocut の動画フォルダ（solocut.json・.solocut/）を新しい名前へ移す
  config get|set|schema   prompts list|show   templates   lib list|install   doctor   version

共通: --json（機械向けの出力） --project <dir>（プロジェクトの場所） --lang ja|en（メッセージの言語。init ではプロジェクトの言語） --by human|agent --agent <名前>`,
  en: `ferret-video ${CLI_VERSION} — edit videos by template (built for agents; every command accepts --json)

Start
  init [dir] [--template tech]   create a project (also AGENTS.md / CLAUDE.md)
  status / next                  progress / the next thing to do (start here)
  step <step> done|skipped       mark a manual step finished
Media
  ingest / takes                 register recorded takes / list them
  import <file> [--take] [--role]  import separately recorded media
  sync / transcribe / analyze
Edit
  propose cuts [--replace]       build segments from cut candidates
  edit <op> --<field> <v> --reason "<why>" | edit --ops <file|json|->
  undo / redo / history / validate
  captions build
  multicam material              camera-switch material → edit split-for-switch --segment <id> --at <sourceFrame,…>
  sfx apply                      sound effects from the template rules
  tracks apply                   keep the person's face centred, cursor-following zoom, click and keystroke overlays
  masks from-analysis            mask private text on screen (for review)
  tl summary|show|range|query|why  read only what you need of timeline.json
Render and check
  render --preview | --final [--target youtube]
  frame --at <frame|timecode>
  check                          machine checks (checks/<run>/report.md)
  thumb pick <image> | thumb candidates | thumb gen --provider codex|frame --title "…"   thumbnail (publish.json)
  meta set --title … --description … --tags a,b | meta show | meta check   the post (publish.json)
  publish upload [--target youtube|tiktok]   ask the app to post what publish.json says and wait (after the human's OK)
  publish record --target t --status published --url <url>   record a post
  feedback import <dir> | list | show <id> | done <id>
More
  past list|search|show|timeline|compare|reuse|register
  bench profile <samples.json> | bench apply <profile> --template <id>
  mcp                            MCP server over stdio
  migrate [dir]                  move old Solocut video folders (solocut.json, .solocut/) to the new names
  config get|set|schema   prompts list|show   templates   lib list|install   doctor   version

Global: --json  --project <dir>  --lang ja|en (message language; for init, the project language)  --by human|agent  --agent <name>`,
};

const AGENT_ENV: [string, string][] = [['CLAUDECODE', 'claude'], ['CODEX_SANDBOX', 'codex'], ['GEMINI_CLI', 'gemini']];

/** Split global flags (anywhere in argv) from the command's own args. */
function globals(argv: string[]): { json: boolean; help: boolean; project?: string; by?: string; agent?: string; variant?: string; lang?: string; langArgs: string[]; rest: string[] } {
  const rest: string[] = [];
  /** --lang の元の語（init では init 自身の --lang＝プロジェクトの言語なので、そのまま init へ返す） */
  const langArgs: string[] = [];
  let lang: string | undefined;
  let json = false;
  let help = false;
  let project: string | undefined;
  let by: string | undefined;
  let agent: string | undefined;
  let variant: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--lang') {
      const v = argv[++i];
      if (v === undefined) throw new CliError('usage', '--lang needs a value');
      lang = v;
      langArgs.push(a, v);
    } else if (a.startsWith('--lang=')) {
      lang = a.slice(7);
      langArgs.push(a);
    } else if (a === '--project' || a === '--by' || a === '--agent' || a === '--variant') {
      const v = argv[++i];
      if (v === undefined) throw new CliError('usage', `${a} needs a value`);
      if (a === '--project') project = v;
      else if (a === '--by') by = v;
      else if (a === '--variant') variant = v;
      else agent = v;
    } else if (a.startsWith('--variant=')) variant = a.slice(10);
    else if (a.startsWith('--project=')) project = a.slice(10);
    else if (a.startsWith('--by=')) by = a.slice(5);
    else if (a.startsWith('--agent=')) agent = a.slice(8);
    else rest.push(a);
  }
  return { json, help, ...(project ? { project } : {}), ...(by ? { by } : {}), ...(agent ? { agent } : {}), ...(variant ? { variant } : {}), ...(lang !== undefined ? { lang } : {}), langArgs, rest };
}

function defaultIO(): IO {
  return {
    cwd: process.cwd(),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    isTTY: !!process.stderr.isTTY,
    stdinLines: () => createInterface({ input: process.stdin, crlfDelay: Infinity }),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/** Entry point. Returns the exit code (0 ok, 1 error, 2 usage). */
export async function main(argv: string[], io: IO = defaultIO()): Promise<number> {
  let json = argv.includes('--json');
  let lang: Lang = 'ja';
  try {
    lang = loadSettings().language;
  } catch {
    /* defaults */
  }
  try {
    const g = globals(argv);
    json = g.json;
    const [name, ...args] = g.rest;
    // 全体の --lang ja|en: メッセージ・next の why / do の言語（画面の言語）。プロジェクトの言語（字幕・文字起こし）は変えない。
    // init の --lang はプロジェクトの言語を決めるので、init にはそのまま渡す
    let uiLang: Lang | undefined;
    if (name === 'init') args.push(...g.langArgs);
    else if (g.lang !== undefined) {
      if (g.lang !== 'ja' && g.lang !== 'en') throw new CliError('usage', '--lang must be ja or en');
      uiLang = g.lang;
      lang = uiLang;
    }
    if (!name || name === 'help' || (g.help && !name)) {
      if (json) io.stdout(JSON.stringify({ ok: true, version: CLI_VERSION, commands: Object.keys(COMMANDS) }) + '\n');
      else io.stdout(HELP[lang] + '\n');
      return 0;
    }
    if (name === '--version' || name === '-v') {
      io.stdout(json ? JSON.stringify({ ok: true, version: CLI_VERSION }) + '\n' : `ferret-video ${CLI_VERSION}\n`);
      return 0;
    }
    const handler = COMMANDS[name];
    if (!handler) throw new CliError('usage', lang === 'ja' ? `不明なコマンド: ${name}（ferret-video help）` : `unknown command: ${name} (see ferret-video help)`);
    if (g.help) {
      io.stdout(HELP[lang] + '\n');
      return 0;
    }
    const envAgent = io.env.FERRET_VIDEO_AGENT ?? AGENT_ENV.find(([k]) => io.env[k])?.[1];
    const byRaw = g.by ?? io.env.FERRET_VIDEO_BY ?? (g.agent || envAgent ? 'agent' : 'human');
    if (byRaw !== 'human' && byRaw !== 'agent') throw new CliError('usage', '--by must be human or agent');
    const agent = g.agent ?? envAgent;
    if (g.variant !== undefined) parseVariant(g.variant);
    const ctx: Ctx = { io, json, lang, ...(uiLang ? { uiLang } : {}), by: byRaw, ...(g.project ? { projectFlag: g.project } : {}), ...(agent ? { agent } : {}), ...(g.variant ? { variant: g.variant } : {}) };
    await handler(ctx, args);
    return 0;
  } catch (e) {
    const raw = explainError(e, lang);
    const err = new CliError(raw.code, localize(raw.message, lang), raw.details);
    if (json) {
      io.stdout(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }, null, 2) + '\n');
    } else {
      io.stderr(`ferret-video: ${err.message}\n`);
      const issues = Array.isArray(err.details) ? err.details : (err.details as { issues?: unknown[] } | undefined)?.issues;
      if (Array.isArray(issues)) {
        for (const i of issues.slice(0, 20) as { level?: string; path?: string; message?: string }[]) io.stderr(`  ${i.level ?? 'error'}: ${i.path ?? ''}: ${i.message ?? ''}\n`);
      }
      if (!(e instanceof CliError) && io.env.FERRET_VIDEO_DEBUG) io.stderr(`${(e as Error)?.stack ?? ''}\n`);
    }
    return err.code === 'usage' ? 2 : 1;
  }
}
