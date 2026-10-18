import { z } from 'zod';

// Timeline schema (docs/15_timeline_schema.md). zod is the source of truth; JSON Schema is generated from it.
// Every time value is an integer frame number: `Frame` = timeline frame (canvas fps),
// `SourceFrame` = frame in a source's own clock (see `takeFps` / `sourceFps` in timeline.ts).

export const SCHEMA_VERSION = 1 as const;

const int = () => z.number().int();
const nonNegInt = () => z.number().int().min(0);
export const FrameSchema = nonNegInt();
/** Source frames may be negative only in `offset` (a source can start before the take's clock). */
export const SourceFrameSchema = nonNegInt();

/** `${kind}_${rest}` ids. The kind can be read from the id. */
export function idSchema<K extends string>(kind: K) {
  return z.string().regex(new RegExp(`^${kind}_[A-Za-z0-9][A-Za-z0-9_.-]*$`), `id must look like "${kind}_…"`);
}
export const ID_KINDS = ['seg', 'cap', 'ov', 'scn', 'mask', 'bgm', 'sfx', 'ch', 'take', 'arc', 'fb', 'chk'] as const;
export type IdKind = (typeof ID_KINDS)[number];

/** Source ids are free-form keys of `sources` (e.g. "t1.screen", "cam_front"). */
export const SourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'invalid source id');

export const RationalSchema = z.strictObject({ num: z.number().int().positive(), den: z.number().int().positive() });
export const SizeSchema = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() });
export const PointSchema = z.strictObject({ x: z.number(), y: z.number() });
/** Pixel rectangle (x, y = top-left). */
export const RectSchema = z.strictObject({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() });
export const RangeSchema = z.strictObject({ start: FrameSchema, end: FrameSchema });
export const CornerSchema = z.enum(['tl', 'tr', 'bl', 'br']);

export const TargetSchema = z.enum(['youtube', 'youtube-shorts', 'tiktok', 'instagram-reels']);

export const CanvasSchema = z.strictObject({
  width: z.number().int().positive().multipleOf(2),
  height: z.number().int().positive().multipleOf(2),
  fps: RationalSchema,
  colorSpace: z.enum(['bt709', 'bt2020']).default('bt709'),
});

export const DecidedSchema = z.strictObject({
  by: z.enum(['human', 'agent', 'decision-model', 'rule', 'template']),
  agent: z.string().optional(),
  reason: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  ruleRef: z.string().optional(),
  feedbackRef: idSchema('fb').optional(),
  needsReview: z.boolean().optional(),
});

export const ReferenceUseSchema = z.enum(['pacing', 'scenes', 'captions', 'sfx', 'multicam', 'thumbnail-style', 'structure']);

export const MetaSchema = z.strictObject({
  title: z.string(),
  kind: z.enum(['tech', 'talk']),
  template: z.strictObject({ id: z.string(), version: z.string() }),
  audience: z.string(),
  goal: z.string(),
  language: z.enum(['ja', 'en']),
  targets: z.array(TargetSchema),
  glossary: z.array(z.strictObject({ term: z.string(), reading: z.string().optional(), note: z.string().optional() })),
  references: z.array(
    z.strictObject({ archive: idSchema('arc'), use: z.array(ReferenceUseSchema), note: z.string().optional() }),
  ),
  /** Set on derived variants (docs/18): which main timeline and which parts of it this was made from. */
  derivedFrom: z.strictObject({
    variantOf: z.literal('main'),
    at: z.string(),
    mainHash: z.string(),
    selection: z.array(z.strictObject({ segment: idSchema('seg'), from: SourceFrameSchema.optional(), to: SourceFrameSchema.optional() })),
    rules: z.string(),
  }).optional(),
});

export const LicenseRefSchema = z.strictObject({
  id: z.string(),
  credit: z.string().optional(),
  limitKey: z.string().optional(),
  sourceUrl: z.string().optional(),
});

const SyncSchema = z.strictObject({ method: z.enum(['clock', 'xcorr', 'manual']), confidence: z.number().min(0).max(1) });

// `offset` (source frames, may be negative): the source's local frame = take frame (converted to the source fps) + offset.
// `durationFrames`: length of the source in its own frames, when known (enables bounds checks).
// `audio: false` marks a video source without a usable audio track (never picked as voice).
export const SourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('screen'), path: z.string().min(1), take: idSchema('take'), display: z.string(), fps: RationalSchema,
    size: SizeSchema, offset: int(), durationFrames: nonNegInt().optional(), audio: z.boolean().optional(),
    cursorLog: z.string().optional(), keyLog: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('camera'), path: z.string().min(1), take: idSchema('take').optional(),
    role: z.enum(['front', 'close', 'wide', 'side', 'other']), fps: RationalSchema, size: SizeSchema, offset: int(),
    durationFrames: nonNegInt().optional(), audio: z.boolean().optional(),
    drift: z.number().positive().optional(), sync: SyncSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('mic'), path: z.string().min(1), take: idSchema('take').optional(), sampleRate: z.number().int().positive(),
    offset: int(),
  }),
  z.strictObject({ kind: z.literal('asset'), path: z.string().min(1), assetId: z.string(), license: LicenseRefSchema }),
]);

export const TranscriptRefSchema = z.strictObject({
  path: z.string(),
  engine: z.string(),
  model: z.string(),
  summary: z.string(),
});

export const ChapterSchema = z.strictObject({
  id: idSchema('ch'),
  title: z.string(),
  start: FrameSchema,
  end: FrameSchema,
  points: z.array(z.string()),
  importance: z.enum(['core', 'support', 'aside']),
});

export const WipeSchema = z.strictObject({
  shape: z.enum(['circle', 'rounded']),
  corner: CornerSchema,
  /** 'ring-gradient' (orange→red ring), 'shadow' (soft drop shadow), 'plain'; other values render as plain. */
  style: z.string(),
  /** Diameter / side as a fraction of the canvas short side (default 0.3). */
  size: z.number().min(0.15).max(0.5).optional(),
});

/** Where a cover crop sits in the source: fractions 0..1 of the cropped-away margin (0.5, 0.5 = centre). */
export const FocusSchema = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
/** A moving focus: keyframes at segment-relative frames (from tracksets: face / cursor paths). */
export const FocusKeySchema = z.strictObject({ at: nonNegInt(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const FocusValueSchema = z.union([FocusSchema, z.array(FocusKeySchema).min(1)]);

/**
 * Extra magnification of a cover crop (1 = plain cover). Lets the crop move on an axis the aspect ratio would not crop
 * (a 16:9 camera in a 16:9 frame), so the person's face can be centred (core centerPerson).
 */
export const CropScaleSchema = z.number().min(1).max(2);

export const VideoChoiceSchema = z.discriminatedUnion('layout', [
  z.strictObject({ layout: z.literal('camera-full'), camera: SourceIdSchema, focus: FocusValueSchema.optional(), scale: CropScaleSchema.optional() }),
  z.strictObject({ layout: z.literal('screen-full'), screen: SourceIdSchema }),
  z.strictObject({
    layout: z.literal('screen-with-wipe'), screen: SourceIdSchema, camera: SourceIdSchema, wipe: WipeSchema,
    /** Where the camera's cover crop inside the wipe sits (and its magnification): the face centred in the wipe. */
    cameraFocus: FocusValueSchema.optional(), cameraScale: CropScaleSchema.optional(),
  }),
  z.strictObject({
    layout: z.literal('split-v'), top: SourceIdSchema, bottom: SourceIdSchema,
    topFocus: FocusValueSchema.optional(), bottomFocus: FocusValueSchema.optional(),
  }),
  z.strictObject({ layout: z.literal('scene'), scene: idSchema('scn') }),
]);

/** Zoom focus: face / cursor (resolved at render time) or a canvas pixel point. */
export const ZoomValueSchema = z.strictObject({
  scale: z.number().min(1).max(8),
  focus: z.union([z.enum(['face', 'cursor']), PointSchema]),
});
/** Keyframe `at` is relative to the segment's start (so keyframes survive re-packing). */
export const ZoomKeyframeSchema = z.strictObject({
  at: nonNegInt(),
  value: ZoomValueSchema,
  ease: z.enum(['linear', 'hold']).optional(),
});

export const CheckKindSchema = z.enum([
  'black-frames', 'freeze', 'loudness', 'spec', 'audio-clicks', 'cut-boundaries', 'caption-safe-area',
  'caption-face-overlap', 'pii-on-screen', 'mosaic-tracking', 'camera-switch',
]);
export const CheckResultSchema = z.strictObject({
  check: CheckKindSchema,
  status: z.enum(['pass', 'fail', 'needs-human']),
  score: z.number().optional(),
  frames: z.array(FrameSchema).optional(),
  note: z.string().optional(),
  run: idSchema('chk'),
});

export const RemovedKindSchema = z.enum(['silence', 'filler', 'retake', 'ng-marker', 'off-topic']);

export const SegmentSchema = z.strictObject({
  id: idSchema('seg'),
  range: RangeSchema,
  src: z.strictObject({ from: SourceFrameSchema, to: SourceFrameSchema, take: idSchema('take') }),
  text: z.string(),
  chapter: idSchema('ch'),
  role: z.enum(['hook', 'explain', 'demo', 'example', 'summary', 'cta', 'aside']),
  video: VideoChoiceSchema,
  zoom: z.array(ZoomKeyframeSchema).optional(),
  transitionIn: z.strictObject({ kind: z.enum(['cut', 'jump-zoom', 'whoosh', 'fade']), frames: nonNegInt() }).optional(),
  decided: DecidedSchema,
  removedNeighbors: z
    .array(z.strictObject({
      kind: RemovedKindSchema,
      src: z.strictObject({ from: SourceFrameSchema, to: SourceFrameSchema }),
      decided: DecidedSchema,
    }))
    .optional(),
  checks: z.array(CheckResultSchema).optional(),
});

export const SlotValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string(), emphasis: z.array(z.string()).optional() }),
  z.strictObject({ kind: z.literal('image'), asset: SourceIdSchema }),
  z.strictObject({ kind: z.literal('video'), source: SourceIdSchema, from: SourceFrameSchema }),
  z.strictObject({ kind: z.literal('code'), language: z.string(), code: z.string(), highlight: z.array(int()).optional() }),
  z.strictObject({ kind: z.literal('list'), items: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('number'), value: z.number(), unit: z.string().optional() }),
]);

export const SceneSchema = z.strictObject({
  id: idSchema('scn'),
  pattern: z.strictObject({ id: z.string(), version: z.string() }),
  range: RangeSchema,
  /** Optional: keep the scene at `offset` frames into a segment; its range moves when segments move or are trimmed. */
  anchor: z.strictObject({ segment: idSchema('seg'), offset: nonNegInt() }).optional(),
  slots: z.record(z.string(), SlotValueSchema),
  animation: z.strictObject({ in: z.string(), out: z.string() }).optional(),
  decided: DecidedSchema,
});

export const CaptionSchema = z.strictObject({
  id: idSchema('cap'),
  range: RangeSchema,
  text: z.string(),
  spoken: z.string(),
  words: z.array(z.strictObject({ text: z.string(), start: FrameSchema, end: FrameSchema })),
  lines: z.array(z.string()),
  emphasis: z.array(z.strictObject({ word: z.string(), style: z.enum(['color', 'scale', 'box']) })),
  style: z.string(),
  /** `y` is a fraction of the canvas height (0 = top, 1 = bottom) for the anchor point. */
  position: z.strictObject({ anchor: z.enum(['bottom', 'top', 'center']), y: z.number().min(0).max(1) }),
  corrections: z.array(z.strictObject({ from: z.string(), to: z.string(), decided: DecidedSchema })).optional(),
  decided: DecidedSchema,
});

export const OverlaySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('telop'), id: idSchema('ov'), range: RangeSchema, text: z.string(), style: z.string(),
    position: PointSchema, decided: DecidedSchema,
  }),
  z.strictObject({
    kind: z.literal('image'), id: idSchema('ov'), range: RangeSchema, asset: SourceIdSchema, position: RectSchema,
    animation: z.string().optional(), decided: DecidedSchema,
  }),
  z.strictObject({ kind: z.literal('keystroke'), id: idSchema('ov'), range: RangeSchema, keys: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal('click-ring'), id: idSchema('ov'), at: FrameSchema, position: PointSchema }),
  z.strictObject({ kind: z.literal('logo'), id: idSchema('ov'), range: RangeSchema, asset: SourceIdSchema, corner: CornerSchema }),
]);

export const BgmSchema = z.strictObject({
  id: idSchema('bgm'), asset: SourceIdSchema, range: RangeSchema, gainDb: z.number(), duckDb: z.number().max(0),
  fadeIn: nonNegInt(), fadeOut: nonNegInt(), decided: DecidedSchema,
});
export const SfxSchema = z.strictObject({
  id: idSchema('sfx'), asset: SourceIdSchema, at: FrameSchema, gainDb: z.number(),
  trigger: z.enum(['emphasis', 'section', 'cut', 'scene-in', 'caption-in', 'zoom-in', 'manual']), ruleRef: z.string().optional(), decided: DecidedSchema,
});
export const VoiceSchema = z.strictObject({
  denoise: z.enum(['off', 'light', 'strong']),
  eq: z.string(),
  loudness: z.number().min(-70).max(0),
  truePeak: z.number().min(-9).max(0),
});
export const AudioPlanSchema = z.strictObject({
  voice: VoiceSchema,
  bgm: z.array(BgmSchema),
  sfx: z.array(SfxSchema),
});

export const MaskSchema = z.strictObject({
  id: idSchema('mask'),
  kind: z.enum(['pixelate', 'blur', 'fill']),
  source: SourceIdSchema,
  reason: z.enum(['pii:email', 'pii:phone', 'pii:token', 'pii:address', 'notification', 'face', 'plate', 'manual']),
  /** Box in source pixels at a source frame. Active from the first to the last keyframe; boxes are interpolated. */
  track: z.array(z.strictObject({ frame: SourceFrameSchema, box: RectSchema, confidence: z.number().min(0).max(1) })).min(1),
  decided: DecidedSchema,
});

export const MarkerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chapter'), at: FrameSchema, label: z.string() }),
  z.strictObject({ kind: z.literal('ng'), at: FrameSchema, srcAt: SourceFrameSchema, from: z.literal('hotkey') }),
  z.strictObject({ kind: z.literal('important'), at: FrameSchema, srcAt: SourceFrameSchema, from: z.literal('hotkey') }),
  z.strictObject({ kind: z.literal('note'), at: FrameSchema, text: z.string(), by: DecidedSchema.shape.by }),
]);

export const OutputSchema = z.strictObject({
  target: TargetSchema,
  canvas: CanvasSchema,
  preset: z.string(),
  range: RangeSchema.optional(),
  thumbnail: z.strictObject({ path: z.string(), frame: FrameSchema, generatedBy: z.string().optional() }).optional(),
  metadata: z.strictObject({
    title: z.string(), titleCandidates: z.array(z.string()), description: z.string(), tags: z.array(z.string()),
    chapters: z.boolean(),
  }),
  render: z.strictObject({
    path: z.string(), hash: z.string(), at: z.string(), toolVersions: z.record(z.string(), z.string()),
  }).optional(),
  publish: z.strictObject({
    status: z.enum(['draft', 'scheduled', 'published', 'failed']), url: z.string().optional(), at: z.string().optional(),
  }).optional(),
});

export const ReviewStateSchema = z.strictObject({
  lastCheck: z.strictObject({
    run: idSchema('chk'), passed: nonNegInt(), failed: nonNegInt(), needsHuman: nonNegInt(), at: z.string(),
  }).optional(),
  openItems: z.array(z.strictObject({ ref: z.string(), kind: z.enum(['decision', 'check', 'feedback']), summary: z.string() })),
  feedback: z.array(z.strictObject({ id: idSchema('fb'), status: z.enum(['open', 'done']), items: nonNegInt() })),
});

export const TimelineSchema = z.strictObject({
  schema: z.literal(SCHEMA_VERSION),
  meta: MetaSchema,
  canvas: CanvasSchema,
  sources: z.record(SourceIdSchema, SourceSchema),
  transcript: TranscriptRefSchema.optional(),
  outline: z.array(ChapterSchema),
  segments: z.array(SegmentSchema),
  scenes: z.array(SceneSchema),
  captions: z.array(CaptionSchema),
  overlays: z.array(OverlaySchema),
  audio: AudioPlanSchema,
  masks: z.array(MaskSchema),
  markers: z.array(MarkerSchema),
  outputs: z.array(OutputSchema),
  review: ReviewStateSchema,
});

export type Frame = number;
export type SourceFrame = number;
export type Rational = z.infer<typeof RationalSchema>;
export type Size = z.infer<typeof SizeSchema>;
export type Point = z.infer<typeof PointSchema>;
export type Focus = z.infer<typeof FocusSchema>;
export type FocusValue = z.infer<typeof FocusValueSchema>;
export type Rect = z.infer<typeof RectSchema>;
export type Range = z.infer<typeof RangeSchema>;
export type Corner = z.infer<typeof CornerSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type Canvas = z.infer<typeof CanvasSchema>;
export type Decided = z.infer<typeof DecidedSchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type LicenseRef = z.infer<typeof LicenseRefSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type SourceKind = Source['kind'];
export type TranscriptRef = z.infer<typeof TranscriptRefSchema>;
export type Chapter = z.infer<typeof ChapterSchema>;
export type VideoChoice = z.infer<typeof VideoChoiceSchema>;
export type ZoomKeyframe = z.infer<typeof ZoomKeyframeSchema>;
export type CheckKind = z.infer<typeof CheckKindSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type RemovedKind = z.infer<typeof RemovedKindSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type SlotValue = z.infer<typeof SlotValueSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Caption = z.infer<typeof CaptionSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type Bgm = z.infer<typeof BgmSchema>;
export type Sfx = z.infer<typeof SfxSchema>;
export type Voice = z.infer<typeof VoiceSchema>;
export type AudioPlan = z.infer<typeof AudioPlanSchema>;
export type Mask = z.infer<typeof MaskSchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type Output = z.infer<typeof OutputSchema>;
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
/** Input shape (defaults such as canvas.colorSpace may be omitted). */
export type TimelineInput = z.input<typeof TimelineSchema>;

/** Result of one machine check on a rendered file (media.runMachineChecks). Times in seconds. */
export interface CheckFinding {
  check: CheckKind;
  status: 'pass' | 'fail' | 'needs-human';
  note: string;
  ranges?: { start: number; end: number }[];
  measured?: Record<string, number | string | null>;
  /** Timeline-frame findings (track-based checks): what and where. */
  items?: { frame: Frame; note: string; ref?: string }[];
}

export function timelineJsonSchema(): object {
  return z.toJSONSchema(TimelineSchema, { io: 'input', unrepresentable: 'any' }) as object;
}
