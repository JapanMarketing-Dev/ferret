import { ensureTool, fontsDir } from '@video/toolchain';
import { progress, progressDone, t, type Ctx } from './ctx.js';
import { dirname } from 'node:path';

/**
 * The fonts folder for libass (captions, scenes, telops, thumbnail titles): $FERRET_VIDEO_FONTS, the managed install, or —
 * downloaded on first use (`ferret-video lib install fonts`). Offline or failed → null + a warning; system fonts are used.
 */
export async function ensureFonts(ctx: Ctx, warnings: string[]): Promise<string | null> {
  const env = ctx.io.env.FERRET_VIDEO_FONTS ?? process.env.FERRET_VIDEO_FONTS;
  if (env) return env;
  const have = fontsDir();
  if (have) return have;
  if (ctx.io.env.FERRET_VIDEO_OFFLINE === '1') return null;
  try {
    const p = await ensureTool('fonts', { onProgress: ({ received, total }) => progress(ctx, 'lib:fonts', total ? received / total : 0, t(ctx, 'フォントを準備しています', 'downloading fonts'), { tool: 'fonts', received, ...(total ? { total } : {}) }) });
    progressDone(ctx, 'lib:fonts');
    return dirname(p);
  } catch (e) {
    progressDone(ctx, 'lib:fonts');
    warnings.push(t(ctx, `フォントを用意できませんでした（システムのフォントを使います）: ${(e as Error).message}`, `fonts unavailable, using system fonts: ${(e as Error).message}`));
    return null;
  }
}
