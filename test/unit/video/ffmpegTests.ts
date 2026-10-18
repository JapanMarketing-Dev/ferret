/**
 * ffmpeg で本当に書き出す・解析する結合テスト（数秒〜十数秒かかる）は、FERRET_VIDEO_FFMPEG_TESTS=1 のときだけ動かす。
 * ふだんの `pnpm test:unit` を速く保つため（Ferret のテスト方針）。動画の書き出しを変えたら手元で
 * `FERRET_VIDEO_FFMPEG_TESTS=1 npx vitest run test/unit/video/` を流す。ffmpeg が無ければ、付けても飛ばす。
 */
export const FFMPEG_TESTS = process.env.FERRET_VIDEO_FFMPEG_TESTS === '1';
