import { z } from 'zod';

// template.yaml (docs/04_templates_and_agents.md). Numbers that are hard to express in prose live here; how to edit
// lives in rules.md and prompts/*.md.

export const STEP_IDS = [
  'ingest', 'sync', 'transcribe', 'rough-cut', 'multicam', 'captions', 'sfx', 'layout', 'preview', 'check', 'review',
  'final', 'thumbnail', 'metadata', 'analyze', 'masks',
] as const;
export type StepId = (typeof STEP_IDS)[number];

export const TARGETS = ['youtube', 'youtube-shorts', 'tiktok', 'instagram-reels'] as const;
export type Target = (typeof TARGETS)[number];

export const CHECK_IDS = [
  'black-frames', 'freeze', 'loudness', 'spec', 'audio-clicks', 'cut-boundaries', 'caption-safe-area',
  'caption-face-overlap', 'pii-on-screen', 'mosaic-tracking', 'camera-switch',
] as const;

export const LAYOUT_IDS = ['camera-full', 'screen-full', 'screen-with-wipe', 'split-v', 'scene'] as const;

const Rational = z.object({ num: z.number().int().positive(), den: z.number().int().positive() });
/** fps may be written as 30, 29.97 or { num: 30000, den: 1001 }. */
const Fps = z.union([z.number().positive(), Rational]).transform((v) => (typeof v === 'number' ? toRational(v) : v));

export function toRational(fps: number): { num: number; den: number } {
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  for (const [num, den] of [[24000, 1001], [30000, 1001], [60000, 1001]] as const) {
    if (Math.abs(fps - num / den) < 0.01) return { num, den };
  }
  return { num: Math.round(fps * 1000), den: 1000 };
}

const Threshold = z
  .object({ autoAbove: z.number().min(0).max(1), autoBelow: z.number().min(0).max(1) })
  .refine((t) => t.autoBelow <= t.autoAbove, { message: 'autoBelow must be ≤ autoAbove' });

export const TemplateFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id: lowercase letters, digits and -'),
  version: z.union([z.string(), z.number()]).transform(String),
  name: z.object({ ja: z.string().min(1), en: z.string().min(1) }),
  description: z.object({ ja: z.string(), en: z.string() }).optional(),
  kind: z.enum(['tech', 'talk']),
  abstract: z.boolean().default(false),
  /** An old id kept for existing projects: loadable, hidden from listTemplates. */
  alias: z.boolean().default(false),
  targets: z.array(z.enum(TARGETS)).min(1),
  canvas: z.object({ width: z.number().int().positive().multipleOf(2), height: z.number().int().positive().multipleOf(2), fps: Fps }),
  record: z.object({
    tracks: z.array(z.enum(['screen', 'camera', 'mic', 'system'])).min(1),
    camera: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive() }).optional(),
    screen: z.object({ fps: z.number().positive() }).optional(),
    cursorLog: z.boolean().default(false),
    keyLog: z.boolean().default(false),
  }),
  layouts: z.object({
    default: z.enum(LAYOUT_IDS),
    allowed: z.array(z.enum(LAYOUT_IDS)).min(1),
    wipe: z.object({ shape: z.enum(['circle', 'rounded']), corner: z.enum(['tl', 'tr', 'bl', 'br']), style: z.string() }).optional(),
  }).refine((l) => l.allowed.includes(l.default), { message: 'layouts.default must be in layouts.allowed' }),
  cut: z.object({
    silence: z.object({ minMs: z.number().int().min(50), padMs: z.number().int().min(0), noiseDb: z.number().max(0).default(-35) }),
    fillers: z.array(z.string()),
    retakes: z.enum(['keep-last', 'keep-first', 'ask', 'off']),
    ngMarkers: z.enum(['cut', 'mark', 'off']),
    minKeepMs: z.number().int().min(0).default(250),
    maxDurationSec: z.number().positive().optional(),
    jumpZoom: z.object({ every: z.number().int().min(0), scale: z.number().min(1).max(2) }).optional(),
  }),
  captions: z.object({
    style: z.string(),
    highlight: z.enum(['word', 'line', 'none']),
    maxCharsPerLine: z.number().int().min(4).max(60),
    maxLines: z.number().int().min(1).max(3),
    emphasis: z.enum(['auto', 'off']),
    position: z.object({ anchor: z.enum(['bottom', 'top', 'center']), y: z.number().min(0).max(1) }),
    safeArea: z.enum(['youtube', 'tiktok', 'none']).default('none'),
    burnIn: z.boolean(),
    srt: z.boolean().default(false),
    /** Each caption stays at least this long when the next one leaves room (ms). */
    minDurationMs: z.number().int().min(100).max(5000).optional(),
    /** A caption never spans more than this (ms); longer speech is split between words. */
    maxDurationMs: z.number().int().min(500).max(15000).optional(),
  }).refine((c) => c.minDurationMs === undefined || c.maxDurationMs === undefined || c.minDurationMs <= c.maxDurationMs, { message: 'captions.minDurationMs must be ≤ maxDurationMs' }),
  audio: z.object({
    loudness: z.number().min(-70).max(0),
    truePeak: z.number().min(-9).max(0),
    denoise: z.enum(['off', 'light', 'strong']),
    bgm: z.object({ gainDb: z.number().default(-22), duckDb: z.number().max(0) }),
    sfx: z.object({ maxPerMinute: z.number().min(0), gainDb: z.number().default(-12) }).optional(),
  }),
  decisions: z.object({
    cutKeep: Threshold,
    frameCheck: z.object({ passAbove: z.number().min(0).max(1) }),
    retakeChoice: Threshold.optional(),
  }),
  /** Terms whisper should hear and captions should spell this way (product names, file names). */
  glossary: z.array(z.object({ term: z.string().min(1), reading: z.string().optional() })).optional(),
  multicam: z.object({ maxShotSec: z.number().positive(), minShotSec: z.number().positive() }).optional(),
  /** docs/09 sfx rules: where effects fire (core sfxFromRules). The cap falls back to audio.sfx.maxPerMinute. */
  sfx: z.object({
    rules: z.array(z.object({
      on: z.enum(['emphasis', 'section', 'cut', 'scene-in', 'caption-in', 'zoom-in']),
      kind: z.string().min(1),
      probability: z.number().min(0).max(1).optional(),
      gainDb: z.number().optional(),
    })),
    maxPerMin: z.number().min(0).optional(),
    gainDb: z.number().optional(),
    minSpacingMs: z.number().int().min(0).optional(),
  }).optional(),
  /** Tracked zoom (core applyTracks): punch in toward clicks on screen segments. */
  zoom: z.object({
    followClicks: z.union([z.boolean(), z.object({
      scale: z.number().min(1).max(3).optional(), holdSec: z.number().positive().optional(), rampSec: z.number().min(0).optional(),
    })]).default(false),
  }).optional(),
  /** Caption look measured from a benchmark video (core profileToTemplatePatch). */
  captionLook: z.object({
    size: z.number().positive(),
    fill: z.string().optional(),
    stroke: z.object({ color: z.string(), widthRatio: z.number().min(0) }).optional(),
    box: z.boolean(),
    emphasisColor: z.string().optional(),
    emphasisScale: z.number().positive().optional(),
  }).optional(),
  /** The one video a project makes (16:9). Older templates listed vertical variants here; extra keys are ignored. */
  outputs: z.partialRecord(z.enum(TARGETS), z.object({ enabled: z.boolean().default(true) })).optional(),
  features: z.object({
    autoZoom: z.boolean().default(false),
    keystrokes: z.boolean().default(false),
    cursorHighlight: z.boolean().default(false),
    piiMask: z.boolean().default(false),
    /** Keep the person's face centred in the camera's frame (ferret-video tracks apply, core centerPerson). */
    faceReframe: z.boolean().default(false),
    highlightPicker: z.boolean().default(false),
  }).prefault({}),
  checks: z.array(z.enum(CHECK_IDS)),
  pipeline: z.array(z.enum(STEP_IDS)).min(1)
    .refine((p) => new Set(p).size === p.length, { message: 'pipeline has duplicate steps' }),
});

export type TemplateFile = z.infer<typeof TemplateFileSchema>;
