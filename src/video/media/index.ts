export { FfmpegError, killTree, MediaError, parseProgressLine, resetToolCache, runFfmpeg, toolPath } from './run.js';
export type { ProbeResult, ProbeStream } from './probe.js';
export { parseProbe, parseRational, probe } from './probe.js';
export type { TimeRange } from './analyze.js';
export {
  detectBlack, detectFreeze, detectSilence, measuredLoudnorm, measureLoudness, parseBlackLog, parseFreezeLog, parseLoudnormLog, parseSilenceLog,
} from './analyze.js';
export { fft, nextPow2, xcorr } from './fft.js';
export type { SyncResult, XcorrResult } from './sync.js';
export { crossCorrelateOffset, extractAudioPcm, onsetEnvelope, robustLine, syncFiles } from './sync.js';
export { extractFrame, makeCfrProxy } from './proxy.js';
export type { SfxRecipe } from './sfxgen.js';
export { SFX_CATEGORIES, SFX_RECIPES, ensureBuiltinSfx, recipesVersion, sfxArgs, sfxSidecar } from './sfxgen.js';
export type { ExecuteOptions } from './render.js';
export { concatLine, defaultFontsDir, executeRenderPlan, inputsOf, parseEbur128Integrated, previewGainFilter, renderFrame, withFontsDir } from './render.js';
export { loudnessFinding, runMachineChecks, specFinding } from './checks.js';
export type { HwEncoder } from './hwenc.js';
export { cpuCount, detectHwEncoder, hwEncodeArgs, parseEncoders, renderConcurrency, resetHwEncoderCache, withEncoder } from './hwenc.js';
export type { AnalyzeOptions, CaptionBand } from './bench.js';
export { analyzeReference, captionBand, detectTransients, parseMomentary, parseSceneTimes } from './bench.js';
