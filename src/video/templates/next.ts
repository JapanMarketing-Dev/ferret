import type { StepId } from './schema.js';
import type { Template } from './load.js';

// `ferret-video next`: from status.json and each step's pass condition, return exactly one next thing to do
// (docs/04 「ferret-video next の動き」, docs/13 autopilot).

/** A step of the template pipeline (one video per project: no per-variant steps). */
export type PipelineStep = StepId;

export interface StepState {
  step: PipelineStep;
  state: 'todo' | 'running' | 'done' | 'needs-human' | 'skipped';
  note?: string;
  at?: string;
}

export interface NextStep {
  step: PipelineStep | 'done';
  state: 'ready' | 'needs-human' | 'done';
  why: string;
  do: string;
  commands: string[];
  /** Absolute path of the template prompt to follow in this step. */
  prompt?: string;
  /** Ids a human has to decide before this step passes. */
  blocking?: string[];
  /** While waiting for a human: a later step that can already be done. */
  meanwhile?: PipelineStep;
}

export interface NextContext {
  hasTakes: boolean;
  hasTranscript: boolean;
  /** Open review items (decisions, checks, feedback) — rough-cut passes only at 0. */
  openItems: number;
  /** Failed items in the last check — check passes only at 0. */
  lastCheckFailed: number;
  openItemRefs?: string[];
  /** docs/13: take the most likely answer instead of waiting (except low-confidence sync and stopBefore). */
  autopilot?: boolean;
  /** Steps where autopilot always stops (settings.autopilot.stopBefore). */
  stopBefore?: string[];
  lang?: 'ja' | 'en';
  /**
   * publish.json (the post the human approves in the app): metadata passes when it is valid (title, video…),
   * thumbnail when it names an existing image. Without this, both steps pass on their status alone.
   */
  publish?: { valid: boolean; thumbnail: boolean; problems?: string[] };
  /** Camera sources in the project: with fewer than 2 there is nothing to switch, so multicam passes. */
  cameras?: number;
}

/** Steps a step needs (only those present in the pipeline count). */
export const STEP_DEPS: Record<StepId, StepId[]> = {
  ingest: [],
  sync: ['ingest'],
  analyze: ['ingest', 'sync'],
  transcribe: ['ingest'],
  'rough-cut': ['transcribe', 'sync'],
  multicam: ['rough-cut', 'sync', 'analyze'],
  captions: ['transcribe'],
  sfx: ['rough-cut', 'captions', 'layout'],
  layout: ['rough-cut', 'analyze'],
  masks: ['rough-cut', 'analyze'],
  preview: ['rough-cut', 'multicam', 'captions', 'sfx', 'layout', 'masks'],
  check: ['preview'],
  review: ['check'],
  final: ['review', 'check'],
  thumbnail: ['rough-cut'],
  metadata: ['rough-cut'],
};

type L = { ja: string; en: string };
const STEP_TEXT: Record<StepId, { do: L; commands: string[] }> = {
  ingest: {
    do: { ja: '収録したテイクを素材として登録し、一覧を確認する', en: 'Register the recorded takes as sources and check the list' },
    commands: ['ferret-video ingest --json', 'ferret-video takes --json'],
  },
  sync: {
    do: { ja: 'トラック間（カメラ・マイク・画面）の同期を取る', en: 'Sync the tracks (cameras, mic, screen)' },
    commands: ['ferret-video sync --json'],
  },
  analyze: {
    do: {
      ja: '素材を解析する（無音・音量・黒画面・静止）。顔・カーソル・個人情報の解析ファイルはアプリが derived/analysis/ に書く',
      en: 'Analyze the media (silence, loudness, black/frozen frames). The app writes face/cursor/PII analysis to derived/analysis/',
    },
    commands: ['ferret-video analyze --json'],
  },
  masks: {
    do: {
      ja: '画面に映った個人情報（メール・APIキーなど）にモザイクを入れ、残りは確認に回す',
      en: 'Mask private text on screen (emails, API keys…) and leave the masks for review',
    },
    commands: ['ferret-video masks from-analysis --json', 'ferret-video step masks done'],
  },
  transcribe: {
    do: { ja: 'マイクの音声を文字起こしする（単語単位の時刻つき）', en: 'Transcribe the mic track with word timestamps' },
    commands: ['ferret-video transcribe --json'],
  },
  'rough-cut': {
    do: {
      ja: 'カットの候補を作り、prompts/rough-cut.md に沿って残す・切るを決める。直しは ferret-video edit で、理由を --reason に書く。確認したら ferret-video step rough-cut done',
      en: 'Propose cuts, then decide keep/cut following prompts/rough-cut.md. Fix with ferret-video edit and give a --reason. When checked, run ferret-video step rough-cut done',
    },
    commands: ['ferret-video propose cuts --json', 'ferret-video tl summary --json', 'ferret-video edit <op> ... --reason "<why>"', 'ferret-video step rough-cut done'],
  },
  multicam: {
    do: {
      ja: 'prompts/multicam.md に沿って区間ごとのカメラを決める。人物のカメラ（material の person）を優先し、suggestions を目安に自分で判断する（判定モデルは不要）。迷う切り替えには needsReview を付ける',
      en: 'Choose the camera per segment following prompts/multicam.md. Prefer the person camera (material "person"); use "suggestions" as a guide and decide yourself (no decision model). Mark unsure switches needsReview',
    },
    commands: [
      'ferret-video multicam material --json', 'ferret-video edit split-for-switch --segment <segment> --at <sourceFrame,…> --reason "<why>"',
      'ferret-video edit setCamera --id <segment> --camera <source> --reason "<why>"', 'ferret-video step multicam done',
    ],
  },
  captions: {
    do: { ja: '字幕を作り、prompts/captions.md に沿って直す', en: 'Build captions and polish them following prompts/captions.md' },
    commands: ['ferret-video captions build --json', 'ferret-video edit updateCaption --id <caption> --patch \'{"text":"…"}\''],
  },
  sfx: {
    do: {
      ja: 'prompts/sfx.md に沿って効果音・BGM を入れる。ferret-video sfx apply が組み込みの効果音（初回に自動で作る）をテンプレートの規則で置く。足りなければ効果音ラボ・OtoLogic などから使う分だけ取得して addSfx（クレジットを記録）',
      en: 'Add sound effects and BGM following prompts/sfx.md. ferret-video sfx apply places the built-in effects (made on first use) by the template rules; for more, fetch just the sounds you use from free sites (効果音ラボ, OtoLogic) and addSfx with their credit',
    },
    commands: ['ferret-video sfx apply --json', 'ferret-video edit addSfx --sfx \'{…}\' --reason "<why>"', 'ferret-video step sfx done'],
  },
  layout: {
    do: {
      ja: '区間ごとのレイアウト（ワイプ・全画面など）を決め、ferret-video tracks apply で人物の顔をカメラの枠の中央に保つ切り抜きとズーム・クリック表示を入れる',
      en: 'Set the layout of each segment (wipe, full screen…), then run ferret-video tracks apply: it keeps the person\'s face centred in the camera frame and adds zooms and click overlays',
    },
    commands: ['ferret-video tracks apply --json', 'ferret-video edit setVideo --id <segment> --video \'{"layout":"…"}\' --reason "<why>"', 'ferret-video step layout done'],
  },
  preview: {
    do: { ja: 'プレビューを書き出す', en: 'Render the preview' },
    commands: ['ferret-video render --preview --json'],
  },
  check: {
    do: { ja: '機械的チェックを実行し、不合格を直す', en: 'Run the machine checks and fix failures' },
    commands: ['ferret-video check --json'],
  },
  review: {
    do: { ja: '人の確認とフィードバックを待つ', en: 'Wait for the human review and feedback' },
    commands: ['ferret-video step review done'],
  },
  final: {
    do: { ja: '出力先ごとに本番の書き出しをする', en: 'Render the final output for each target' },
    commands: ['ferret-video render --final --json'],
  },
  thumbnail: {
    do: {
      ja: 'prompts/thumbnail.md に沿ってサムネイルの画像を作り（画像生成は Codex か Gemini のサブスクリプションに頼む。API キーは使わない）、publish.json の thumbnail に書く',
      en: 'Make the thumbnail image following prompts/thumbnail.md (ask Codex or Gemini on their subscriptions; no API keys) and set publish.json "thumbnail"',
    },
    commands: ['ferret-video frame --at <frame> --json', 'ferret-video thumb pick <image> --json'],
  },
  metadata: {
    do: {
      ja: 'prompts/metadata.md に沿って、タイトル・説明文・タグを publish.json に書く（投稿はしない）',
      en: 'Write the title, description and tags to publish.json following prompts/metadata.md (do not publish)',
    },
    commands: ['ferret-video tl summary --json', 'ferret-video meta set --title "…" --description "…" --tags a,b --json', 'ferret-video meta check --json'],
  },
};

export function stepText(step: PipelineStep, lang: 'ja' | 'en' = 'ja'): { do: string; commands: string[] } {
  const t = STEP_TEXT[step];
  return { do: t.do[lang], commands: [...t.commands] };
}

export function initialStatus(t: Pick<Template, 'pipeline'>): StepState[] {
  return t.pipeline.map((step) => ({ step, state: 'todo' }));
}

/** Whether a step's own condition (a file the step produces) is met, when the project reports it. */
function fileCondition(step: PipelineStep, ctx: NextContext): { ok: boolean; why: { ja: string; en: string } } | null {
  if (step === 'metadata' && ctx.publish) {
    const more = ctx.publish.problems?.length ? `: ${ctx.publish.problems.slice(0, 3).join(' / ')}` : '';
    return { ok: ctx.publish.valid, why: { ja: `publish.json がないか、内容が足りません${more}`, en: `publish.json is missing or incomplete${more}` } };
  }
  if (step === 'thumbnail' && ctx.publish) {
    return { ok: ctx.publish.thumbnail, why: { ja: 'publish.json の thumbnail が、存在する画像を指していません', en: 'publish.json "thumbnail" does not point to an existing image' } };
  }
  return null;
}

export function nextStep(template: Template, status: StepState[], ctx: NextContext): NextStep {
  const lang = ctx.lang ?? 'ja';
  const ja = lang === 'ja';
  const pipeline: PipelineStep[] = [...template.pipeline];
  const stateOf = (s: PipelineStep) => status.find((x) => x.step === s)?.state ?? 'todo';
  /** multicam with one camera (or none) has nothing to decide. */
  const notNeeded = (s: PipelineStep) => s === 'multicam' && ctx.cameras !== undefined && ctx.cameras < 2;
  /** A file condition that holds passes the step even when nobody marked it done. */
  const fileOk = (s: PipelineStep) => fileCondition(s, ctx)?.ok === true;
  const isPassed = (s: PipelineStep) => !pipeline.includes(s) || notNeeded(s) || stateOf(s) === 'done' || stateOf(s) === 'skipped' || fileOk(s);

  const make = (step: PipelineStep, state: NextStep['state'], why: string, extra: Partial<NextStep> = {}): NextStep => {
    const txt = stepText(step, lang);
    const out: NextStep = { step, state, why, do: txt.do, commands: txt.commands, ...extra };
    const prompt = template.promptFiles?.[step];
    if (prompt && !out.prompt) out.prompt = prompt;
    if (step === 'final' && !extra.commands) out.commands = template.targets.map((t) => `ferret-video render --final --target ${t} --json`);
    return out;
  };

  /** A later step whose dependencies are all passed (to do while a human decides). */
  const meanwhile = (blocked: PipelineStep): PipelineStep | undefined => {
    const i = pipeline.indexOf(blocked);
    return pipeline.slice(i + 1).find((s) => {
      const st = stateOf(s);
      return (st === 'todo' || st === 'running') && !fileOk(s) && (STEP_DEPS[s] ?? []).every((d) => d !== blocked && isPassed(d));
    });
  };

  const waitFor = (step: PipelineStep, why: string, blocking?: string[]): NextStep => {
    const m = meanwhile(step);
    const base = ja
      ? '人の確認が必要です。編集画面の「要確認」に表示されます。自動操縦（--autopilot）なら待たずに、要確認（needsReview）として残して先へ進みます。'
      : 'A human needs to decide; it is listed under 要確認 (Needs review) in the Edit screen. On autopilot (--autopilot) do not wait: leave it marked needsReview and continue.';
    const extra: Partial<NextStep> = { do: base, commands: [] };
    if (m) {
      extra.meanwhile = m;
      extra.do = ja ? `${base}待つ間に ${m} の手順へ進めます` : `${base} Meanwhile you can do ${m}.`;
      extra.commands = stepText(m, lang).commands;
    }
    if (blocking?.length) extra.blocking = blocking;
    return make(step, 'needs-human', why, extra);
  };

  for (const step of pipeline) {
    const st = stateOf(step);
    const note = status.find((x) => x.step === step)?.note;

    if (ctx.autopilot && ctx.stopBefore?.includes(step) && st !== 'done' && st !== 'skipped') {
      return waitFor(step, ja ? `設定で ${step} の前に必ず止まるようになっています` : `Settings stop autopilot before ${step}`);
    }

    // pass conditions are re-checked even for steps marked done
    if (step === 'ingest' && !ctx.hasTakes) {
      return make(step, 'needs-human', ja ? 'テイクも取り込んだ素材もありません' : 'There are no takes or imported media', {
        do: ja ? '撮影するか、`ferret-video import <ファイル>` で素材を取り込んでください' : 'Record a take or import media with `ferret-video import <file>`',
        commands: ['ferret-video import <file> --kind camera --role front'],
      });
    }
    if (step === 'transcribe' && (st === 'done' || st === 'skipped') && !ctx.hasTranscript) {
      return make(step, 'ready', ja ? '文字起こしのファイルがありません（derived/transcripts/main.json）' : 'The transcript file is missing (derived/transcripts/main.json)');
    }
    if (step === 'rough-cut' && st === 'done' && ctx.openItems > 0 && !ctx.autopilot) {
      return waitFor(step, ja ? `要確認の項目が ${ctx.openItems} 件あります` : `${ctx.openItems} open review item(s)`, ctx.openItemRefs);
    }
    if (step === 'check' && st === 'done' && ctx.lastCheckFailed > 0) {
      return make(step, 'ready', ja ? `前回のチェックで ${ctx.lastCheckFailed} 件が不合格でした` : `${ctx.lastCheckFailed} item(s) failed in the last check`, {
        do: ja
          ? 'checks/<run>/report.md を読んで直し、もう一度チェックする。素材が原因で直せない項目（マイクの音が小さいなど）は、理由を書いて `ferret-video step check needs-human --note "<理由>"` にして先へ進む（人が最後に確認する）'
          : 'Read checks/<run>/report.md, fix the failures and check again. If an item cannot be fixed from the media (e.g. a very quiet mic), mark it with `ferret-video step check needs-human --note "<why>"` and move on (the human sees it at the end)',
        commands: ['ferret-video render --preview --json', 'ferret-video check --json'],
      });
    }
    const cond = fileCondition(step, ctx);
    if (cond && st !== 'skipped') {
      if (cond.ok) continue;
      if (st === 'done') return make(step, 'ready', cond.why[lang]);
    }
    if (st === 'done' || st === 'skipped' || notNeeded(step)) continue;

    if (st === 'needs-human') {
      // autopilot never waits: the step stays marked 要確認 (needs-human, listed in the Edit screen) and the run goes on
      if (ctx.autopilot) continue;
      const why = note ?? (ja ? 'この手順は人の判断を待っています' : 'This step is waiting for a human');
      return waitFor(step, why, step === 'rough-cut' ? ctx.openItemRefs : undefined);
    }
    if (st === 'running') {
      return make(step, 'ready', note ?? (ja ? 'この手順は途中です。続きから進めてください' : 'This step is in progress; continue it'));
    }

    // todo
    if (step === 'rough-cut' && !ctx.hasTranscript) {
      return make('transcribe', 'ready', ja ? 'カットの前に文字起こしが必要です' : 'A transcript is needed before cutting');
    }
    if (step === 'review') {
      if (ctx.autopilot) continue; // autopilot finishes first; the human reviews the finished video
      return waitFor(step, ja ? 'プレビューとチェックが済みました。人の確認とフィードバックを待ちます' : 'Preview and checks are done; waiting for the human review');
    }
    const why = note ?? (cond ? cond.why[lang] : ja ? `テンプレート ${template.id} の次の手順です` : `Next step of template ${template.id}`);
    return make(step, 'ready', why);
  }

  return {
    step: 'done',
    state: 'done',
    why: ja ? '動画ができました。人がアプリの投稿画面で確認し、OK なら投稿します' : 'The video is finished. A human checks it in the app\'s Publish screen and posts it when OK',
    do: ja
      ? '.ferret-video/handoff.md に、やったこと・残っていること・人に確認してほしいこと（needsReview）を書いてください。投稿はしないでください'
      : 'Write what you did, what remains and what the human should check (needsReview) to .ferret-video/handoff.md. Do not publish',
    commands: [],
  };
}
