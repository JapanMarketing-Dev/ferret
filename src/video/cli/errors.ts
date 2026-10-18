import { CliError, type Lang } from './ctx.js';

// Every failure leaves the CLI as { code, message } where the message says what to do next (in the project /
// settings language). Library errors (ffmpeg, toolchain, decision model, templates, fs) are translated here; the
// original text stays in details.cause.

type L = { ja: string; en: string };
const pick = (lang: Lang, m: L) => (lang === 'ja' ? m.ja : m.en);

interface Rule { test: (e: Error & Record<string, unknown>, msg: string) => RegExpExecArray | boolean | null; code: string; msg: (m: RegExpExecArray | null, e: Error) => L }

const RULES: Rule[] = [
  {
    test: (_e, msg) => /No such filter: '(subtitles|ass)'/.exec(msg),
    code: 'ffmpeg-features',
    msg: () => ({
      ja: 'この ffmpeg は字幕の描画（libass）に対応していません。`ferret-video lib install ffmpeg` で対応版を入れてから、もう一度実行してください',
      en: 'This ffmpeg cannot draw captions (no libass). Run `ferret-video lib install ffmpeg` for a build that can, then try again',
    }),
  },
  {
    test: (_e, msg) => /No such filter: '([^']+)'/.exec(msg),
    code: 'ffmpeg-features',
    msg: (m) => ({
      ja: `この ffmpeg には ${m?.[1]} フィルタがありません。\`ferret-video lib install ffmpeg\` で Ferret 用の ffmpeg を入れてください`,
      en: `This ffmpeg has no ${m?.[1]} filter. Install Ferret's ffmpeg with \`ferret-video lib install ffmpeg\``,
    }),
  },
  {
    test: (_e, msg) => /Encoder not found|Error selecting an encoder|Unknown encoder/.exec(msg),
    code: 'ffmpeg-encoder',
    msg: () => ({
      ja: '動画のエンコーダーが使えません。`ferret-video config set export.hwEncodePreview false` でハードウェアエンコードを止めるか、`ferret-video lib install ffmpeg` を実行してください',
      en: 'The video encoder is not available. Turn hardware encoding off with `ferret-video config set export.hwEncodePreview false`, or run `ferret-video lib install ffmpeg`',
    }),
  },
  {
    test: (_e, msg) => /No space left on device|ENOSPC/.exec(msg),
    code: 'disk-full',
    msg: () => ({ ja: 'ディスクの空きがありません。renders/ や derived/cache/ の不要なファイルを消してから、もう一度実行してください', en: 'The disk is full. Free space (e.g. old files in renders/ or derived/cache/) and try again' }),
  },
  {
    test: (e, msg) => e.name === 'FfmpegError' || /^(ffmpeg|ffprobe) failed/.test(msg),
    code: 'ffmpeg-failed',
    msg: (_m, e) => ({
      ja: `ffmpeg が失敗しました: ${e.message}。素材ファイルが壊れていないか確認し、\`ferret-video doctor\` で環境を確かめてください（FERRET_VIDEO_DEBUG=1 で詳細）`,
      en: `ffmpeg failed: ${e.message}. Check that the media files are intact and run \`ferret-video doctor\` (FERRET_VIDEO_DEBUG=1 for details)`,
    }),
  },
  {
    test: (e, msg) => e.name === 'MediaError' && /cannot read media|No such file|does not exist/i.test(msg),
    code: 'not-found',
    msg: (_m, e) => ({ ja: `メディアファイルを読めません: ${e.message}。パスと、ファイルが壊れていないかを確認してください`, en: `Cannot read the media file: ${e.message}. Check the path and that the file is intact` }),
  },
  {
    test: (e) => e.name === 'MediaError',
    code: 'media',
    msg: (_m, e) => ({ ja: `メディアの処理に失敗しました: ${e.message}。\`ferret-video doctor\` で環境を確認してください`, en: `Media processing failed: ${e.message}. Check the setup with \`ferret-video doctor\`` }),
  },
  {
    test: (e) => e.name === 'ToolchainError',
    code: 'tool',
    msg: (_m, e) => ({
      ja: `ツールを用意できませんでした: ${e.message}。ネットワークを確認して \`ferret-video lib install all\` を実行するか、\`ferret-video doctor\` で状態を確認してください`,
      en: `Could not set up a tool: ${e.message}. Check the network and run \`ferret-video lib install all\`, or see \`ferret-video doctor\``,
    }),
  },
  {
    test: (e) => e.name === 'DecideError',
    code: 'decision',
    msg: (_m, e) => ({
      ja: `判定モデルが使えませんでした: ${e.message}。\`ferret-video config set decision.provider off\` で規則だけで進めることもできます`,
      en: `The decision model failed: ${e.message}. \`ferret-video config set decision.provider off\` continues with the rules only`,
    }),
  },
  {
    test: (e) => e.name === 'TemplateError',
    code: 'template-invalid',
    msg: (_m, e) => ({ ja: `テンプレートを読めません: ${e.message}。template.yaml を直すか、\`ferret-video templates\` で使えるものを確認してください`, en: `Cannot load the template: ${e.message}. Fix template.yaml or list the usable ones with \`ferret-video templates\`` }),
  },
  {
    test: (e) => e.name === 'SettingsError',
    code: 'invalid-setting',
    msg: (_m, e) => ({ ja: `設定が正しくありません: ${e.message}。\`ferret-video config schema\` で書式を確認してください`, en: `Invalid setting: ${e.message}. See \`ferret-video config schema\`` }),
  },
  {
    test: (e) => e.name === 'ArchiveError',
    code: 'archive',
    msg: (_m, e) => ({ ja: `アーカイブの処理に失敗しました: ${e.message}`, en: `Archive error: ${e.message}` }),
  },
  {
    test: (e) => e.code === 'ENOENT',
    code: 'not-found',
    msg: (_m, e) => ({ ja: `ファイルが見つかりません: ${(e as { path?: string }).path ?? e.message}。パスを確認してください`, en: `File not found: ${(e as { path?: string }).path ?? e.message}. Check the path` }),
  },
  {
    test: (e) => e.code === 'EACCES' || e.code === 'EPERM',
    code: 'permission',
    msg: (_m, e) => ({ ja: `ファイルにアクセスできません: ${(e as { path?: string }).path ?? e.message}。ほかのアプリが開いていないか、書き込み権限を確認してください`, en: `No access to ${(e as { path?: string }).path ?? e.message}. Close other apps using it and check write permission` }),
  },
];

/** Any thrown value → a CliError with a stable code and an actionable message. */
export function explainError(e: unknown, lang: Lang): CliError {
  if (e instanceof CliError) return e;
  const err = e instanceof Error ? (e as Error & Record<string, unknown>) : (new Error(String(e)) as Error & Record<string, unknown>);
  const msg = err.message ?? '';
  for (const r of RULES) {
    const m = r.test(err, msg);
    if (!m) continue;
    // toolchain / decision errors keep their own code as a suffix (tool-download, decision-budget, …)
    const sub = (r.code === 'tool' || r.code === 'decision') && typeof err.code === 'string' ? `${r.code}-${err.code}` : r.code;
    return new CliError(sub, pick(lang, r.msg(m === true ? null : m, err)), { cause: msg, ...(typeof err.detail === 'string' ? { detail: err.detail.slice(-2000) } : {}) });
  }
  return new CliError('internal', pick(lang, {
    ja: `予期しないエラーです: ${msg}。FERRET_VIDEO_DEBUG=1 を付けて再実行し、出力を添えて報告してください`,
    en: `Unexpected error: ${msg}. Re-run with FERRET_VIDEO_DEBUG=1 and report the output`,
  }), { cause: msg });
}

// ---------- Japanese for the CLI's English-only messages ----------

const NOUN: Record<string, string> = {
  op: '操作', step: '手順', state: '状態', target: '出力先', variant: '版', library: 'ライブラリ', part: '部分', provider: 'プロバイダー',
  source: '素材', setting: '設定', 'item index': '項目番号', 'caption style': '字幕のスタイル', option: 'オプション', condition: '条件',
};
const PHRASE: [RegExp, string][] = [
  [/\ban integer\b/g, '整数'], [/\ba number\b/g, '数値'], [/between (\S+) and (\S+)/g, '$1〜$2'], [/\bone of /g, ''], [/ or /g, ' か '],
];
const phr = (s: string) => PHRASE.reduce((x, [re, to]) => x.replace(re, to), s);

const JA: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^usage: ([\s\S]+)$/, (m) => `使い方: ${m[1]}`],
  [/^Unknown option '([^']+)'[\s\S]*$/, (m) => `不明なオプション: ${m[1]}（ferret-video help で確認してください）`],
  [/^Option '([^']+)' argument missing[\s\S]*$/, (m) => `${m[1]} に値がありません`],
  [/^Unexpected argument '([^']+)'[\s\S]*$/, (m) => `余分な引数があります: ${m[1]}`],
  [/^unrecognized time: ([\s\S]+)$/, (m) => `時刻を解釈できません: ${m[1]}（フレーム数か 00:01:02:03 の形で指定してください）`],
  [/^archive entry not found: ([\s\S]+)$/, (m) => `アーカイブにありません: ${m[1]}（ferret-video past list で確認してください）`],
  [/^invalid value for (\S+)$/, (m) => `${m[1]} の値が正しくありません（ferret-video config schema で範囲を確認してください）`],
  [/^([^:\n]+): ([^\n]*JSON[^\n]*)$/, (m) => `JSON として読めません（${m[1]}）: ${m[2]}`],
  [/^wrong number of arguments(?:\nusage: ([\s\S]+))?$/, (m) => `引数の数が違います${m[1] ? `\n使い方: ${m[1]}` : ''}`],
  [/^([\s\S]+?)\nusage: ([\s\S]+)$/, (m) => `${localize(m[1]!, 'ja')}\n使い方: ${m[2]}`],
  [/^unknown (op|step|state|target|variant|library|part|provider|source|setting|item index|caption style|option|condition):? ([\s\S]+)$/, (m) => `不明な${NOUN[m[1]!]}: ${m[2]}`],
  [/^unknown (op|step|state|target|variant|library|part|provider|source|setting|item index|caption style|option|condition) ("[^"]+")([\s\S]*)$/, (m) => `不明な${NOUN[m[1]!]}: ${m[2]}${m[3]}`],
  [/^(--[\w-]+) must be ([\s\S]+)$/, (m) => `${m[1]} は ${phr(m[2]!)} で指定してください`],
  [/^(--[\w-]+) is required (?:for|outside) ([\s\S]+)$/, (m) => `${m[1]} が必要です（${m[2]}）`],
  [/^(--[\w-]+) needs ([\s\S]+)$/, (m) => `${m[1]} には ${m[2]} が必要です`],
  [/^(\S+) needs a value$/, (m) => `${m[1]} に値がありません`],
  [/^choose (\S+) or (\S+)$/, (m) => `${m[1]} と ${m[2]} はどちらか一方だけ指定してください`],
  [/^(?:ops |reference image )?file not found: ([\s\S]+)$/, (m) => `ファイルがありません: ${m[1]}`],
  [/^reference image not found: ([\s\S]+)$/, (m) => `参照画像がありません: ${m[1]}`],
  [/^invalid ([\w -]+?): ([\s\S]+)$/, (m) => `${m[1]} が正しくありません: ${m[2]}`],
  [/^cannot parse query: ([\s\S]+)$/, (m) => `クエリを解釈できません: ${m[1]}（例: segments[role=demo]）`],
  [/^range must be "start-end": ([\s\S]+)$/, (m) => `範囲は「開始-終了」で指定してください: ${m[1]}（例: 00:01:00-00:02:00）`],
  [/^the project is locked by another ferret-video process \(([^)]+)\)$/, (m) => `ほかの ferret-video がこのプロジェクトを使っています（${m[1]}）。終わるのを待ってから、もう一度実行してください`],
  [/^timeline\.json is invalid \((\d+) issue\(s\)\); run `ferret-video validate`$/, (m) => `timeline.json に問題が ${m[1]} 件あります。\`ferret-video validate\` で確認して直してください`],
  [/^the edit would make timeline\.json invalid: ([\s\S]+)$/, (m) => `この編集を適用すると timeline.json が不正になります（何も変えていません）: ${m[1]}`],
  [/^([\w]+): (\w+) not found: (\S+) \(check the current ids with [^)]+\)$/, (m) => `${m[1]}: 見つかりません: ${m[3]}（ferret-video tl summary / ferret-video tl query で今の id を確認してください）`],
  [/^variant (\S+) does not exist \(projects make one 16:9 video; drop --variant\)$/, (m) => `${m[1]} の版はありません（動画は 16:9 の1本だけです。--variant を外してください）`],
  [/^variant (\S+) only has the \S+ output$/, (m) => `版 ${m[1]} の出力先は ${m[1]} だけです`],
  [/^no operations given$/, () => '操作が指定されていません'],
  [/^operation #(\d+) has no "op"$/, (m) => `${m[1]} 番目の操作に "op" がありません`],
  [/^use either --ops or an op name, not both$/, () => '--ops と操作名はどちらか一方だけ指定してください'],
  [/^stdin is not available$/, () => '標準入力が使えません（--ops にファイルか JSON を渡してください）'],
  [/^give the folder either as an argument or with --dir$/, () => 'フォルダは引数か --dir のどちらか一方で指定してください'],
  [/^no targets \(set meta\.targets or pass --target\)$/, () => '出力先がありません（meta.targets を設定するか --target を指定してください）'],
  [/^([\s\S]+) is not a style profile \(ferret-video bench profile writes one\)$/, (m) => `${m[1]} は参考動画の傾向ファイルではありません（ferret-video bench profile で作れます）`],
  [/^([\s\S]+) exists and is not machine-written; merge this by hand: ([\s\S]+)$/, (m) => `${m[1]} は手で書かれているので上書きしません。次の内容を手で反映してください: ${m[2]}`],
  [/^take (\S+) has no camera or screen source$/, (m) => `テイク ${m[1]} にカメラも画面の素材もありません`],
  [/^([\s\S]+) has no audio stream$/, (m) => `${m[1]} に音声がありません`],
  [/^(\S+) has no video stream; import audio-only files with --kind mic$/, (m) => `${m[1]} に映像がありません。音声だけのファイルは --kind mic で取り込んでください`],
  [/^the merged template does not validate: ([\s\S]+)$/, (m) => `反映後のテンプレートが正しくないため、元に戻しました: ${m[1]}`],
];

/** Japanese for an English-only CLI message (patterns above); messages that already have Japanese pass through. */
export function localize(msg: string, lang: Lang): string {
  if (lang !== 'ja' || /[\u3040-\u30ff\u4e00-\u9fff]/.test(msg)) return msg;
  for (const [re, f] of JA) {
    const m = re.exec(msg);
    if (m) return f(m);
  }
  return msg;
}
