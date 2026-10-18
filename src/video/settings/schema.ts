import { z } from 'zod';

// settings.json (docs/11_settings.md). Every field has a default, so `SettingsSchema.parse({})` is a full settings
// object. Sections use `.prefault({})` so missing sections are filled from their inner defaults.

const Lang = z.enum(['ja', 'en']);

/** Any agent of the Ferret agent catalog (src/shared/agentCatalog.ts) (lower-case id) or custom:<name>; the app/CLI check ids against the catalog. */
export const AgentIdSchema = z.string().regex(/^([a-z0-9][a-z0-9-]*|custom:[A-Za-z0-9_.-]+)$/, 'invalid agent id');

const Appearance = z.object({
  // Theme is dark only (no choice).
  uiScale: z.number().min(0.75).max(2).default(1),
  accent: z.enum(['red', 'orange', 'blue', 'green', 'purple']).default('red'),
});

const Agents = z.object({
  order: z.array(AgentIdSchema).default(['claude', 'codex', 'gemini']),
  failover: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  custom: z
    .array(z.object({ id: z.string().regex(/^custom:[A-Za-z0-9_.-]+$/), label: z.string().min(1), command: z.string().min(1), printMode: z.array(z.string()).optional() }))
    .default([]),
  checkUpdates: z.boolean().default(true),
});

const Recording = z.object({
  screen: z.object({ fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(30) }).prefault({}),
  camera: z
    .object({
      deviceId: z.string().default('default'),
      width: z.number().int().positive().default(1920),
      height: z.number().int().positive().default(1080),
      fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(30),
    })
    .prefault({}),
  mic: z.object({ deviceId: z.string().default('default') }).prefault({}),
  systemAudio: z.boolean().default(true),
  syncMarker: z.boolean().default(false),
  hotkeys: z
    .object({ markNg: z.string().default('CmdOrCtrl+Shift+N'), markImportant: z.string().default('CmdOrCtrl+Shift+M') })
    .prefault({}),
  keystrokeOverlay: z.boolean().default(true),
});

/**
 * Recording region (desktop Record screen,「範囲を選ぶ」): a rectangle of one display in that display's physical pixels,
 * relative to its top-left. null = the whole display. The recorder crops the screen stream to it.
 */
export const RecordRegionSchema = z.object({
  displayId: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(32),
  height: z.number().int().min(32),
});
const RecordSection = z.object({ region: RecordRegionSchema.nullable().default(null) });

const Transcription = z.object({
  engine: z.enum(['whisper.cpp']).default('whisper.cpp'),
  model: z.enum(['large-v3-turbo-q5', 'small']).default('large-v3-turbo-q5'),
  language: z.enum(['ja', 'en', 'auto']).default('ja'),
});

const Decision = z.object({
  /**
   * Optional and off by default: nothing in the pipeline requires it (the agent judges, rules decide the rest).
   * 'auto' = the first installed agent CLI (claude-cli → codex-cli → gemini-cli). Not shown in the app.
   */
  provider: z.enum(['auto', 'claude-cli', 'codex-cli', 'gemini-cli', 'off', 'ollama', 'openai', 'typesafe', 'custom']).default('off'),
  model: z.string().default('qwen3-vl'),
  endpoint: z.string().url().optional(),
  apiKeyRef: z.string().optional(),
  limits: z
    .object({
      perProjectUsd: z.number().min(0).default(2), perDayUsd: z.number().min(0).default(5),
      /** Agent CLI providers are counted in calls (each call batches many questions). */
      perProjectCalls: z.number().int().min(0).default(200),
    })
    .prefault({}),
  cloudConsent: z.boolean().default(false),
});

const ImageProvider = z.object({
  via: z.enum(['subscription', 'api']),
  apiKeyRef: z.string().optional(),
  model: z.string().optional(),
});

/** Images are made inside the subscriptions (the agent asks Codex / Gemini CLI); API providers only when added by hand. */
const ImageGen = z.object({
  order: z.array(z.string()).default(['codex']),
  providers: z.record(z.string(), ImageProvider).default({ codex: { via: 'subscription' } }),
});

const Library = z.object({
  catalog: z.string().default('ferret-video-default'),
  download: z.enum(['on-demand']).default('on-demand'),
  cacheLimitGB: z.number().min(0).max(1000).default(2),
  autoCredits: z.boolean().default(true),
});

const Archive = z.object({
  autoRegister: z.array(z.enum(['export', 'publish'])).default(['export', 'publish']),
  keepPreview: z.boolean().default(true),
  analytics: z.object({ youtube: z.boolean().default(false) }).prefault({}),
});

const Benchmark = z.object({
  keepThumbnails: z.boolean().default(false),
  maxMinutes: z.number().positive().max(60).default(3),
});

const Target = z.enum(['youtube', 'youtube-shorts', 'tiktok', 'instagram-reels']);

const Export = z.object({
  defaultTargets: z.array(Target).default(['youtube']),
  hwEncodePreview: z.boolean().default(true),
});

const Updates = z.object({ channel: z.enum(['stable', 'beta']).default('stable'), auto: z.boolean().default(true) });
const Telemetry = z.object({ crashReports: z.boolean().default(true) });

const Autopilot = z.object({
  /** After a recording is ingested, the app sends the `finish` prompt to the agent by itself. */
  autoStart: z.boolean().default(true),
  stopBefore: z.array(z.string()).default(['publish']),
  maxFixLoops: z.number().int().min(0).max(20).default(3),
  notify: z.array(z.enum(['done', 'needs-human', 'error'])).default(['done', 'needs-human']),
  budget: z.object({ decisionUsd: z.number().min(0).default(2) }).prefault({}),
});

/** Default visibility of new posts; the agent copies them into publish.json unless the human said otherwise. */
export const YOUTUBE_PRIVACY = ['private', 'unlisted', 'public'] as const;
export const TIKTOK_PRIVACY = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'PUBLIC_TO_EVERYONE'] as const;
const Publish = z.object({
  youtube: z.object({ privacy: z.enum(YOUTUBE_PRIVACY).default('private') }).prefault({}),
  tiktok: z.object({ privacy: z.enum(TIKTOK_PRIVACY).default('SELF_ONLY') }).prefault({}),
});

/** The user's own text for the two prompts (absent or blank = the built-in default, see prompts.ts). */
const Prompts = z.object({
  finish: z.string().max(50_000).optional(),
  publish: z.string().max(50_000).optional(),
});

/** Workspace panes the user toggled / resized (desktop). Widths in px. */
const Ui = z.object({
  layout: z.object({
    sidebar: z.boolean().default(true),
    center: z.boolean().default(true),
    terminal: z.boolean().default(true),
    sidebarWidth: z.number().int().min(120).max(1200).optional(),
    terminalWidth: z.number().int().min(200).max(2400).optional(),
  }).prefault({}),
});

/** Master folder: every new video is a subfolder `<root>/<YYYY-MM-DD>-<slug-or-HHMM>/`. Absolute, or `~/…` (see resolveVideosRoot). */
const Videos = z.object({
  root: z.string().regex(/^(~(?=[\\/]|$)|\/|[A-Za-z]:[\\/]|\\\\)/, 'must be an absolute path or start with ~/').default('~/Movies/Ferret'),
});

/** First-run onboarding: when it was finished (null = not yet). */
const Onboarding = z.object({ completedAt: z.iso.datetime({ offset: true }).nullable().default(null) });

export const SettingsSchema = z.object({
  $schema: z.string().optional(),
  language: Lang.default('ja'),
  appearance: Appearance.prefault({}),
  ui: Ui.prefault({}),
  onboarding: Onboarding.prefault({}),
  videos: Videos.prefault({}),
  agents: Agents.prefault({}),
  recording: Recording.prefault({}),
  record: RecordSection.prefault({}),
  transcription: Transcription.prefault({}),
  decision: Decision.prefault({}),
  imageGen: ImageGen.prefault({}),
  library: Library.prefault({}),
  archive: Archive.prefault({}),
  benchmark: Benchmark.prefault({}),
  export: Export.prefault({}),
  updates: Updates.prefault({}),
  telemetry: Telemetry.prefault({}),
  autopilot: Autopilot.prefault({}),
  prompts: Prompts.prefault({}),
  publish: Publish.prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsInput = z.input<typeof SettingsSchema>;
export const SETTINGS_SECTIONS = Object.keys(SettingsSchema.shape).filter((k) => k !== '$schema') as (keyof Settings)[];
