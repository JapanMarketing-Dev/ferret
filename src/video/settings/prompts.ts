import { z } from 'zod';
import { loadSettings } from './settings.js';
import type { Settings } from './schema.js';

// The two prompts of the app (docs/13_prompts_and_autopilot.md): `finish` is sent to the agent by itself after a
// recording (autopilot.autoStart), `publish` after the human pressed「OK・投稿する」. The texts are built in; the user can
// replace them in settings.json (`prompts.finish` / `prompts.publish`, plain strings). An empty override means the default.

export const PROMPT_IDS = ['finish', 'publish'] as const;
export type PromptId = (typeof PROMPT_IDS)[number];

const AgentRef = z.string().regex(/^(default|[a-z0-9][a-z0-9-]*|custom:[A-Za-z0-9_.-]+)$/);

export const PromptSchema = z.object({
  id: z.enum(PROMPT_IDS),
  label: z.object({ ja: z.string(), en: z.string() }),
  agent: AgentRef.default('default'),
  body: z.object({ ja: z.string().optional(), en: z.string().optional() }),
  autopilot: z.boolean().optional(),
  /** true when the body comes from settings.json instead of the built-in default */
  overridden: z.boolean().optional(),
  /** kept for older callers (`ferret-video prompts list --all`); no prompt is hidden any more */
  hidden: z.boolean().optional(),
});
export type Prompt = z.infer<typeof PromptSchema>;

export const PROMPT_VARS = ['project', 'template', 'date'] as const;

export function isPromptId(id: unknown): id is PromptId {
  return typeof id === 'string' && (PROMPT_IDS as readonly string[]).includes(id);
}

const PUBLISH_JSON = `{
  "video": "renders/final.mp4",
  "thumbnail": "thumbnails/thumb-1.png",
  "title": "…", "description": "…", "tags": ["…"],
  "youtube": { "categoryId": "28", "privacy": "private", "madeForKids": false, "containsSyntheticMedia": false, "chapters": true },
  "tiktok": { "enabled": false, "caption": "…", "privacy": "SELF_ONLY", "allowComment": false, "allowDuet": false, "allowStitch": false, "isAigc": false }
}`;

const FINISH_JA = `このプロジェクト（{{project}}）の素材から、投稿できる動画を1本（YouTube 用・16:9）完成させてください。人は見ていません。止まらずに最後まで進めてください。

進め方
- \`ferret-video next --autopilot --json\` を実行し、返ってきた step の \`do\` と \`commands\` に従って作業し、また \`ferret-video next --autopilot --json\` を実行する、を state が done になるか、投稿（publish）の手前で人を待つ状態になるまで繰り返します（テンプレート {{template}} の手順）。
- 判定モデルは要りません。設定されていなくても止まらず、迷うところは自分で判断して進めます。自信のない箇所は needsReview を付け、「要確認」として .ferret-video/questions.md に1行ずつ書いて先へ進みます。
- チェックの不合格は直して \`ferret-video check\` をやり直します。同じ項目を3回直しても通らなければ「要確認」にして先へ進みます。
- 人物（メインのカメラ）は常に画面の中央に置きます。顔が画面の中央に来るように切り抜き・配置してください（カメラが複数でも、映っている人物を中央に）。

イラスト・画像
- 前もってダウンロードはしません。使うと決めた素材だけをその場で取得して assets/ に置きます。
- 使ってよい無料のライブラリ（各サイトの規約を守ること）:
  - いらすとや（irasutoya.com）: 1つの作品につき20点まで商用無料。
  - ソコスト（soco-st.com）: 商用無料・クレジット不要。
  - ICOOON MONO（icooon-mono.com）: 商用無料・クレジット不要のアイコン。
  - Loose Drawing（loosedrawing.com）: 商用無料・クレジット不要。
  - unDraw（undraw.co）: 商用無料・クレジット不要。
  - Openverse（openverse.org）: CC ライセンスの画像。作品ごとのライセンスに従い、求められるクレジットを入れる。
  - Pixabay / Unsplash / Pexels（写真）: 各サイトのライセンスで商用無料。人物・ロゴ・商標が主役の写真は避ける。
- 使った素材は、出典の URL・作者・ライセンスをプロジェクトの credits.md に記録し、クレジットが必要なものは説明文にも入れます。

サムネイル
- 動画のフレームをそのまま使う必要はありません。文字起こしと話題から、内容が一目で分かるサムネイルを作ります。
- 画像はサブスクリプションの中で作ります。API キーは使いません。
  1. Codex（ChatGPT のサブスクに入っている組み込みの画像生成）に頼みます。例:
     \`codex exec --skip-git-repo-check -s workspace-write -C "<このプロジェクトのフォルダ>" '$imagegen YouTube のサムネイルを 1280x720（16:9）で作り、thumbnails/thumb-1.png に保存して。内容: <話題と見どころ>。文字は大きく短く（日本語で8〜12字）: <文字>'\`
     （$imagegen は Codex の画像生成スキルの呼び出しなので、シェルで展開されないよう一重引用符で囲みます。）thumbnails/ に画像がなければ、~/.codex/generated_images/ の一番新しい画像をコピーします。
  2. Codex が使えないとき（未ログイン・上限など）は Gemini CLI（Gemini のサブスク）に頼みます。\`gemini extensions list\` で画像を作れる拡張がログインのまま使えるときだけ使い、API キーを求められたら使いません。
  3. どちらも使えないときは、自分で作ります（HTML や SVG を書いて画像に書き出す、ffmpeg で背景に文字を重ねるなど）。そのサムネイルは「要確認」にします。
- 仕上がりは 1280x720 の PNG か JPG で、2MB 以下にして thumbnails/ に置きます。

投稿の情報
- プロジェクトの直下に publish.json を書きます。形式:
${PUBLISH_JSON}
- title は100字以内、description は5000バイト以内（< と > は使わない）、tags は合計500字以内で10個前後。説明文の最初の2行で内容が分かるようにし、チャプター（00:00 から始まる）と素材のクレジットを入れます。公開範囲（youtube.privacy・tiktok.privacy）は、人の指示がなければ設定の既定を使います（\`ferret-video meta --json\` に出ます。設定の publish.youtube.privacy / publish.tiktok.privacy で、\`ferret-video config get publish\` でも確かめられます）。
- 投稿はしないでください。人が完成した動画を見て OK してから行います。

最後に .ferret-video/handoff.md を更新し、3行で報告してください（1行目: できたもの、2行目: 要確認の点、3行目: 人に見てほしいところ）。`;

const FINISH_EN = `Finish one video ready to publish (YouTube, 16:9) from this project's footage ({{project}}). Nobody is watching: keep going until the end without stopping.

How
- Run \`ferret-video next --autopilot --json\`, do what its \`do\` and \`commands\` say, then run \`ferret-video next --autopilot --json\` again, until state is done or it waits for a human before publish (the steps of template {{template}}).
- No decision model is needed. If none is configured, do not stop: judge for yourself. Mark the spots you are unsure of with needsReview, write each as one line under "要確認 / to review" in .ferret-video/questions.md and move on.
- Fix failed checks and re-run \`ferret-video check\`. If the same item still fails after 3 fixes, mark it to review and move on.
- Keep the person (main camera) in the center of the frame: crop and place so the face is centered (with several cameras too).

Illustrations and images
- Download nothing in advance. Fetch only the assets you decide to use, when you use them, into assets/.
- Free libraries you may use (follow each site's terms):
  - Irasutoya (irasutoya.com): free for commercial use, up to 20 images per work.
  - Sokosuto (soco-st.com): free for commercial use, no credit needed.
  - ICOOON MONO (icooon-mono.com): free commercial icons, no credit needed.
  - Loose Drawing (loosedrawing.com): free for commercial use, no credit needed.
  - unDraw (undraw.co): free for commercial use, no credit needed.
  - Openverse (openverse.org): CC-licensed images; follow each work's license and add the credit it requires.
  - Pixabay / Unsplash / Pexels (photos): free for commercial use under each site's license; avoid photos featuring people, logos or trademarks.
- Record the source URL, author and license of every asset you use in the project's credits.md, and put required credits in the description.

Thumbnail
- You do not need to use a frame of the video. Make a thumbnail that shows what the video is about at a glance, from the transcript and the topic.
- Make images inside the subscriptions. Never use API keys.
  1. Ask Codex (the built-in image generation of the ChatGPT subscription), e.g.:
     \`codex exec --skip-git-repo-check -s workspace-write -C "<this project's folder>" '$imagegen Make a 1280x720 (16:9) YouTube thumbnail and save it to thumbnails/thumb-1.png. About: <topic and hook>. Large, short text: <text>'\`
     ($imagegen calls Codex's image generation skill; keep it in single quotes so the shell does not expand it.) If no image appears in thumbnails/, copy the newest one from ~/.codex/generated_images/.
  2. If Codex cannot be used (not signed in, usage limit…), ask Gemini CLI (Gemini subscription). Use it only if \`gemini extensions list\` shows an image extension that works with the signed-in account; if it asks for an API key, do not use it.
  3. If neither works, make it yourself (write HTML or SVG and export it, or put text over a background with ffmpeg) and mark the thumbnail to review.
- The result is a 1280x720 PNG or JPG under 2 MB in thumbnails/.

Publishing info
- Write publish.json at the top of the project. Format:
${PUBLISH_JSON}
- title at most 100 characters, description at most 5000 bytes (no < or >), tags about 10 and at most 500 characters in total. The first 2 lines of the description say what the video delivers; include chapters (starting at 00:00) and the asset credits. For youtube.privacy and tiktok.privacy use the defaults from settings unless a human said otherwise (shown by \`ferret-video meta --json\`; settings publish.youtube.privacy / publish.tiktok.privacy, also \`ferret-video config get publish\`).
- Do not publish. Publishing happens after a human watched the finished video and approved it.

Finally update .ferret-video/handoff.md and report in 3 lines (1: what was made, 2: what to review, 3: what a human should look at).`;

const PUBLISH_JA = `人が完成した動画を確認し、投稿を承認しました。このプロジェクト（{{project}}）を投稿してください。

1. publish.json を読み、最終の動画と照らし合わせて確認します。
   - video のファイルがあり、最新の書き出しであること
   - title が1〜100字、description が5000バイト以内で < と > を含まないこと、tags が合計500字以内であること
   - thumbnail を指定しているなら、そのファイルがあり 1280x720・2MB 以下であること
   - youtube.privacy が private / unlisted / public のどれかであること。人の指示がなければ設定の既定（\`ferret-video meta --json\`、または \`ferret-video config get publish\`）に合わせる。publishAt を使うときは private にすること
   - 説明文のチャプターが動画の長さと合っていること（00:00 から始まり、3つ以上、それぞれ10秒以上）
   - tiktok.enabled が true なら、caption と privacy があること（privacy は人の指示がなければ設定の既定）
2. 問題があれば publish.json を直します。
3. \`ferret-video publish upload --json\` を実行します。アプリが publish.json の内容で YouTube（と、有効なら TikTok）にアップロードし、結果を返します。
   - メタデータの不備などで失敗したら、直してもう一度だけ実行します。連携が切れているなど人の操作が要るものは、直さずにそのまま報告します。
4. 投稿先ごとの URL と、直した点を3行以内で報告してください。`;

const PUBLISH_EN = `A human checked the finished video and approved publishing. Publish this project ({{project}}).

1. Read publish.json and check it against the final video:
   - the video file exists and is the latest render
   - title is 1–100 characters, description at most 5000 bytes without < or >, tags at most 500 characters in total
   - if thumbnail is set, the file exists and is 1280x720, under 2 MB
   - youtube.privacy is private / unlisted / public; unless a human said otherwise it matches the settings default (\`ferret-video meta --json\` or \`ferret-video config get publish\`); with publishAt it must be private
   - the chapters in the description match the video length (start at 00:00, at least 3, each at least 10 seconds)
   - if tiktok.enabled is true, caption and privacy are set (privacy from the settings default unless a human said otherwise)
2. Fix publish.json if anything is wrong.
3. Run \`ferret-video publish upload --json\`. The app uploads to YouTube (and TikTok if enabled) with publish.json and returns the result.
   - If it fails because of the metadata, fix it and run it once more. If a human is needed (an account is disconnected…), do not work around it; report it.
4. Report the URL for each destination and what you fixed, in at most 3 lines.`;

export const DEFAULT_PROMPTS: Prompt[] = [
  { id: 'finish', label: { ja: '動画を完成させて', en: 'Finish the video' }, agent: 'default', autopilot: true, body: { ja: FINISH_JA, en: FINISH_EN } },
  { id: 'publish', label: { ja: '投稿して', en: 'Publish' }, agent: 'default', body: { ja: PUBLISH_JA, en: PUBLISH_EN } },
];

/** The user's text for a prompt from settings, or undefined when it is absent / blank (= the default). */
export function promptOverride(settings: Pick<Settings, 'prompts'> | undefined, id: PromptId): string | undefined {
  const v = settings?.prompts?.[id];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** The two prompts with the settings overrides applied (an override replaces both languages). Pure. */
export function promptsFromSettings(settings: Pick<Settings, 'prompts'> | undefined): Prompt[] {
  return DEFAULT_PROMPTS.map((p) => {
    const text = promptOverride(settings, p.id);
    return text === undefined ? { ...p, label: { ...p.label }, body: { ...p.body } } : { ...p, label: { ...p.label }, body: { ja: text, en: text }, overridden: true };
  });
}

/** The built-in default text of a prompt in `lang` (for the settings page's「既定に戻す」and placeholder). */
export function defaultPromptText(id: PromptId, lang: 'ja' | 'en'): string {
  const p = DEFAULT_PROMPTS.find((x) => x.id === id)!;
  return p.body[lang] ?? p.body.ja ?? '';
}

export interface PromptsLoadResult { prompts: Prompt[]; errors: { file: string; message: string }[] }

/**
 * The prompts from ~/.ferret/video/settings.json. `projectDir` and `includeHidden` are accepted for older callers and
 * ignored (prompts.json files are gone). A broken settings file falls back to the defaults (see loadSettings).
 */
export function loadPromptsWithErrors(_projectDir?: string, _o: { includeHidden?: boolean } = {}): PromptsLoadResult {
  return { prompts: promptsFromSettings(loadSettings()), errors: [] };
}

export function loadPrompts(projectDir?: string, o: { includeHidden?: boolean } = {}): Prompt[] {
  return loadPromptsWithErrors(projectDir, o).prompts;
}

/** Body in `lang` (falls back to the other language) with {{vars}} filled. Unknown or missing vars become "". */
export function renderPrompt(p: Pick<Prompt, 'body'>, vars: Record<string, string>, lang: 'ja' | 'en'): string {
  const body = p.body[lang] ?? p.body[lang === 'ja' ? 'en' : 'ja'] ?? '';
  const all: Record<string, string> = { date: new Date().toISOString().slice(0, 10), ...vars };
  return body.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => all[name] ?? '');
}

/** Render prompt `id` with the given settings (pure). Throws for an unknown id. */
export function renderPromptById(id: string, vars: Record<string, string>, lang: 'ja' | 'en', settings?: Pick<Settings, 'prompts'>): { text: string; prompt: Prompt } {
  if (!isPromptId(id)) throw new Error(`unknown prompt: ${id}`);
  const prompt = promptsFromSettings(settings).find((p) => p.id === id)!;
  return { text: renderPrompt(prompt, vars, lang), prompt };
}
