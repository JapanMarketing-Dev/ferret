import type { Rational, Target } from './schema.js';

export interface ExportPreset {
  id: Target | 'preview';
  label: string;
  /** Output frame size. `null` = keep the timeline canvas (YouTube follows the source: 1080p or 4K). */
  size: { width: number; height: number } | null;
  /** Max output height for preview renders (keeps aspect). */
  maxHeight?: number;
  /** `null` = timeline fps. */
  fps: Rational | null;
  video: {
    codec: 'libx264';
    profile: 'high';
    pixFmt: 'yuv420p';
    preset: string;
    /** Constant quality (preview) or target bitrate (final). */
    crf?: number;
    bitrateKbps?: number;
    /** Bitrate when fps > 30 (YouTube 60fps). */
    bitrateKbpsHighFps?: number;
    /** Bitrate for 4K (height ≥ 2160). */
    bitrateKbps4k?: number;
    bframes: number;
    /** GOP length in seconds (closed GOP). */
    gopSec: number;
    colorSpace: 'bt709';
  };
  audio: { codec: 'aac'; sampleRate: 48000; channels: 2; bitrateKbps: number };
  loudness: { integrated: number; truePeak: number; lra: number };
  captions: 'srt' | 'burn';
  /** Safe area: insets in output pixels, or a title-safe fraction. */
  safeArea: { top: number; bottom: number; left: number; right: number } | { titleSafe: number };
  maxDurationSec?: number;
}

const H264 = { codec: 'libx264', profile: 'high', pixFmt: 'yuv420p', bframes: 2, gopSec: 0.5, colorSpace: 'bt709' } as const;
const LOUD = { integrated: -14, truePeak: -1, lra: 11 };
const VERTICAL_SAFE = { top: 220, bottom: 440, left: 80, right: 180 };

/** Export presets (docs/06_libraries.md 書き出しのプリセット). */
export const PRESETS: Record<Target | 'preview', ExportPreset> = {
  youtube: {
    id: 'youtube', label: 'YouTube (16:9)', size: null, fps: null,
    video: { ...H264, preset: 'medium', bitrateKbps: 8000, bitrateKbpsHighFps: 12000, bitrateKbps4k: 40000 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, bitrateKbps: 384 },
    loudness: LOUD, captions: 'srt', safeArea: { titleSafe: 0.9 },
  },
  'youtube-shorts': {
    id: 'youtube-shorts', label: 'YouTube Shorts (9:16)', size: { width: 1080, height: 1920 }, fps: null,
    video: { ...H264, preset: 'medium', bitrateKbps: 10000 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, bitrateKbps: 256 },
    loudness: LOUD, captions: 'burn', safeArea: VERTICAL_SAFE, maxDurationSec: 180,
  },
  tiktok: {
    id: 'tiktok', label: 'TikTok (9:16)', size: { width: 1080, height: 1920 }, fps: null,
    video: { ...H264, preset: 'medium', bitrateKbps: 10000 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, bitrateKbps: 256 },
    loudness: LOUD, captions: 'burn', safeArea: VERTICAL_SAFE, maxDurationSec: 600,
  },
  'instagram-reels': {
    id: 'instagram-reels', label: 'Instagram Reels (9:16)', size: { width: 1080, height: 1920 }, fps: null,
    video: { ...H264, preset: 'medium', bitrateKbps: 10000 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, bitrateKbps: 256 },
    loudness: LOUD, captions: 'burn', safeArea: VERTICAL_SAFE, maxDurationSec: 180,
  },
  preview: {
    id: 'preview', label: 'Preview (540p)', size: null, maxHeight: 540, fps: null,
    video: { ...H264, preset: 'veryfast', crf: 28, gopSec: 1 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, bitrateKbps: 128 },
    loudness: LOUD, captions: 'burn', safeArea: { titleSafe: 0.9 },
  },
};

/** Video bitrate for a preset at a given output size and fps (kbps), or undefined for CRF presets. */
export function presetBitrate(p: ExportPreset, height: number, fps: number): number | undefined {
  if (p.video.bitrateKbps === undefined) return undefined;
  if (height >= 2160 && p.video.bitrateKbps4k) return p.video.bitrateKbps4k;
  if (fps > 30.5 && p.video.bitrateKbpsHighFps) return p.video.bitrateKbpsHighFps;
  return p.video.bitrateKbps;
}
