import { describe, expect, it } from 'vitest';
import { CliError } from '@video/cli/ctx.js';
import { explainError, localize } from '@video/cli/errors.js';

// every failure leaves the CLI with a stable code and a message that says what to do, in the project language

const named = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });

describe('explainError', () => {
  it('keeps CliErrors as they are', () => {
    const e = new CliError('usage', 'x');
    expect(explainError(e, 'ja')).toBe(e);
  });

  it.each([
    [new Error("ffmpeg failed (exit 8): [AVFilterGraph @ 0x1] No such filter: 'subtitles' | Error : Filter not found"), 'ffmpeg-features', /lib install ffmpeg/],
    [new Error("No such filter: 'drawtext'"), 'ffmpeg-features', /drawtext/],
    [new Error('Error selecting an encoder | Encoder not found'), 'ffmpeg-encoder', /hwEncodePreview/],
    [new Error('write failed: No space left on device'), 'disk-full', /renders/],
    [named('FfmpegError', 'ffmpeg failed (exit 1): Invalid data found when processing input', { code: 1, detail: 'args: -i x' }), 'ffmpeg-failed', /doctor/],
    [named('MediaError', 'cannot read media: /x.mp4'), 'not-found', /パス|path/],
    [named('MediaError', 'something odd'), 'media', /doctor/],
    [named('ToolchainError', 'checksum mismatch', { code: 'checksum' }), 'tool-checksum', /lib install all/],
    [named('DecideError', 'claude -p failed', { code: 'cli' }), 'decision-cli', /decision\.provider off/],
    [named('TemplateError', 'template not found: x'), 'template-invalid', /ferret-video templates/],
    [named('SettingsError', 'invalid value'), 'invalid-setting', /config schema/],
    [named('ArchiveError', 'broken index'), 'archive', /broken index/],
    [Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT', path: '/a/b' }), 'not-found', /\/a\/b/],
    [Object.assign(new Error('EACCES'), { code: 'EACCES', path: '/a/b' }), 'permission', /\/a\/b/],
    [new Error('boom'), 'internal', /FERRET_VIDEO_DEBUG=1/],
    ['a string', 'internal', /a string/],
  ])('%s → %s', (e, code, re) => {
    for (const lang of ['ja', 'en'] as const) {
      const r = explainError(e, lang);
      expect(r.code).toBe(code);
      expect(r.message).toMatch(re);
      expect(r.message.trim()).not.toBe('');
      expect((r.details as { cause: string }).cause).toBeDefined();
    }
    expect(explainError(e, 'ja').message).toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  it('keeps the long ffmpeg detail in details, not in the message', () => {
    const r = explainError(named('FfmpegError', 'ffmpeg failed (exit 1): x', { code: 1, detail: 'y'.repeat(5000) }), 'en');
    expect((r.details as { detail: string }).detail.length).toBe(2000);
  });
});

describe('localize (Japanese for English-only CLI messages)', () => {
  it.each([
    ['usage: ferret-video tl summary', '使い方: ferret-video tl summary'],
    ['wrong number of arguments\nusage: ferret-video x <a>', '引数の数が違います\n使い方: ferret-video x <a>'],
    ['unknown target: myspace', '不明な出力先: myspace'],
    ['unknown op "frob" (a, b)', '不明な操作: "frob" (a, b)'],
    ['--n must be 1..6', '--n は 1..6 で指定してください'],
    ['--confidence must be between 0 and 1', '--confidence は 0〜1 で指定してください'],
    ['--by must be human or agent', '--by は human か agent で指定してください'],
    ['--url is required for published / scheduled', '--url が必要です（published / scheduled）'],
    ['choose --preview or --final', '--preview と --final はどちらか一方だけ指定してください'],
    ['file not found: /x', 'ファイルがありません: /x'],
    ['invalid take id: x (take_…)', 'take id が正しくありません: x (take_…)'],
    ["Unknown option '--x'. To specify …", '不明なオプション: --x（ferret-video help で確認してください）'],
    ['the project is locked by another ferret-video process (/p/.ferret-video/lock)', 'ほかの ferret-video がこのプロジェクトを使っています（/p/.ferret-video/lock）。終わるのを待ってから、もう一度実行してください'],
    ['variant tiktok does not exist (projects make one 16:9 video; drop --variant)', 'tiktok の版はありません（動画は 16:9 の1本だけです。--variant を外してください）'],
    ["argument: Expected property name or '}' in JSON at position 1", "JSON として読めません（argument）: Expected property name or '}' in JSON at position 1"],
  ])('%s', (en, ja) => {
    expect(localize(en, 'ja')).toBe(ja);
    expect(localize(en, 'en')).toBe(en);
  });

  it('passes Japanese and unknown messages through', () => {
    expect(localize('すでに日本語です: x', 'ja')).toBe('すでに日本語です: x');
    expect(localize('some rare thing', 'ja')).toBe('some rare thing');
  });
});
