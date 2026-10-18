import type { Template } from './load.js';
import { stepText } from './next.js';

// AGENTS.md generator (docs/04 「エージェントへの指示書」). CLAUDE.md only contains `@AGENTS.md`.

export interface AgentsMdProject { dir: string; title: string; lang: 'ja' | 'en' }

const CLI_JA: [string, string][] = [
  ['ferret-video status --json', '手順の進み具合とプロジェクトの概要'],
  ['ferret-video next --json', '次にやること（1つだけ）。迷ったらまずこれ'],
  ['ferret-video ingest --json', '収録したテイク（media/takes/）を素材として登録する'],
  ['ferret-video takes --json', 'テイクと取り込んだ素材の一覧'],
  ['ferret-video import <file> --kind camera --role front', '別撮りの素材を取り込む'],
  ['ferret-video sync --json', 'トラック間の同期'],
  ['ferret-video transcribe --json', '文字起こし（derived/transcripts/main.json）'],
  ['ferret-video analyze --json', '無音・ラウドネスの解析（derived/analysis/）'],
  ['ferret-video multicam material --json', 'カメラ切り替えの材料（区間ごとの顔・視線・発話）'],
  ['ferret-video edit split-for-switch --segment <id> --at <素材フレーム,…> --reason "<なぜ>"', 'カメラを切り替える位置で区間を分ける'],
  ['ferret-video sfx apply --json', 'テンプレートの効果音ルールで効果音を入れる'],
  ['ferret-video tracks apply --json', '顔・カーソルを追うズームとクリック・キー表示を入れる'],
  ['ferret-video masks from-analysis --json', '画面の個人情報にモザイクを入れる（要確認つき）'],
  ['ferret-video propose cuts --json', 'カットの候補を作って区間にする（--dry-run で書き込まない）'],
  ['ferret-video tl summary --json', '構成・区間の数・未解決の一覧。まず読むもの'],
  ['ferret-video tl show <id> --json', '1つの要素とその周り'],
  ['ferret-video tl range 00:01:00-00:02:00 --json', 'その時間帯にある要素'],
  ['ferret-video tl query "segments[role=demo]" --json', '条件で絞り込む'],
  ['ferret-video tl why <id> --json', 'その要素の decided と関係する履歴'],
  ['ferret-video edit <op> --<field> <value> --reason "<なぜ>"', '編集操作を1つ適用する'],
  ['ferret-video edit --ops ops.json', '複数の操作をまとめて適用する（失敗したら何も変わらない）'],
  ['ferret-video undo / ferret-video redo / ferret-video history', '取り消し・やり直し・履歴'],
  ['ferret-video validate --json', 'timeline.json の検証（直接書き換えたら必ず実行）'],
  ['ferret-video captions build --json', '字幕を作る（captions/main.ass と main.srt も出す）'],
  ['ferret-video render --preview --json', 'プレビューを書き出す（変わった区間だけ作り直す）'],
  ['ferret-video render --final --target youtube --json', '本番の書き出し'],
  ['ferret-video frame --at <フレーム|00:01:02:03> --json', '1フレームの静止画'],
  ['ferret-video check --json', '機械的チェック（checks/<run>/report.md）'],
  ['ferret-video meta set --title … --description … --tags a,b', '投稿の内容を publish.json に書く（meta show / meta check で確認）'],
  ['ferret-video thumb pick <画像>', 'サムネイルの画像を publish.json に設定する'],
  ['ferret-video step <step> done|skipped --note "<メモ>"', '手作業の手順を終えた印を付ける'],
  ['ferret-video past list|search|show|timeline', '過去の動画（アーカイブ）を参照する'],
  ['ferret-video config get|set|schema', '設定の読み書き'],
  ['ferret-video prompts list|show <id>', '用意済みのプロンプト'],
  ['ferret-video doctor --json', '環境の診断（ツール、エージェント）'],
];

const CLI_EN: [string, string][] = [
  ['ferret-video status --json', 'Step progress and project overview'],
  ['ferret-video next --json', 'The one next thing to do. Start here when unsure'],
  ['ferret-video ingest --json', 'Register recorded takes (media/takes/) as sources'],
  ['ferret-video takes --json', 'Recorded takes and imported media'],
  ['ferret-video import <file> --kind camera --role front', 'Import separately recorded media'],
  ['ferret-video sync --json', 'Sync the tracks'],
  ['ferret-video transcribe --json', 'Transcribe (derived/transcripts/main.json)'],
  ['ferret-video analyze --json', 'Silence and loudness analysis (derived/analysis/)'],
  ['ferret-video multicam material --json', 'Camera-switch material (faces, gaze, speech per segment)'],
  ['ferret-video edit split-for-switch --segment <id> --at <sourceFrame,…> --reason "<why>"', 'Split a segment where the camera should switch'],
  ['ferret-video sfx apply --json', 'Add sound effects from the template rules'],
  ['ferret-video tracks apply --json', 'Face/cursor-following zoom plus click and keystroke overlays'],
  ['ferret-video masks from-analysis --json', 'Mask private text on screen (marked for review)'],
  ['ferret-video propose cuts --json', 'Build segments from cut candidates (--dry-run writes nothing)'],
  ['ferret-video tl summary --json', 'Structure, segment count, open items. Read this first'],
  ['ferret-video tl show <id> --json', 'One element and its surroundings'],
  ['ferret-video tl range 00:01:00-00:02:00 --json', 'Everything in a time range'],
  ['ferret-video tl query "segments[role=demo]" --json', 'Filter elements'],
  ['ferret-video tl why <id> --json', 'The decided record and related history of an element'],
  ['ferret-video edit <op> --<field> <value> --reason "<why>"', 'Apply one edit operation'],
  ['ferret-video edit --ops ops.json', 'Apply several operations atomically'],
  ['ferret-video undo / ferret-video redo / ferret-video history', 'Undo, redo, history'],
  ['ferret-video validate --json', 'Validate timeline.json (always after editing it by hand)'],
  ['ferret-video captions build --json', 'Build captions (also captions/main.ass and main.srt)'],
  ['ferret-video render --preview --json', 'Render the preview (only changed chunks are re-rendered)'],
  ['ferret-video render --final --target youtube --json', 'Final render'],
  ['ferret-video frame --at <frame|00:01:02:03> --json', 'A still of one frame'],
  ['ferret-video check --json', 'Machine checks (checks/<run>/report.md)'],
  ['ferret-video meta set --title … --description … --tags a,b', 'Write the post to publish.json (meta show / meta check)'],
  ['ferret-video thumb pick <image>', 'Set the thumbnail image in publish.json'],
  ['ferret-video step <step> done|skipped --note "<note>"', 'Mark a manual step finished'],
  ['ferret-video past list|search|show|timeline', 'Look at past videos (archive)'],
  ['ferret-video config get|set|schema', 'Read and change settings'],
  ['ferret-video prompts list|show <id>', 'Ready-made prompts'],
  ['ferret-video doctor --json', 'Environment diagnosis (tools, agents)'],
];

const NEXT_EXAMPLE = `{
  "ok": true,
  "step": "rough-cut",
  "state": "needs-human",
  "why": "…",
  "do": "…",
  "commands": ["ferret-video captions build --json"],
  "blocking": ["seg_14", "seg_22"]
}`;

const EDIT_EXAMPLE = `ferret-video edit removeSegment --id seg_12 --reason "言い直しの前半。後のテイクのほうが明瞭"
ferret-video edit trimSegment --id seg_03 --to 1840 --reason "語尾の後の間を詰める"
ferret-video edit --ops '[{"op":"setCamera","id":"seg_05","camera":"cam_close","decided":{"by":"agent","reason":"結論の直前で寄る"}}]'`;

const EDIT_EXAMPLE_EN = `ferret-video edit removeSegment --id seg_12 --reason "First half of a retake; the later take is clearer"
ferret-video edit trimSegment --id seg_03 --to 1840 --reason "Tighten the pause after the sentence"
ferret-video edit --ops '[{"op":"setCamera","id":"seg_05","camera":"cam_close","decided":{"by":"agent","reason":"Punch in before the conclusion"}}]'`;

function table(rows: [string, string][], head: [string, string]): string {
  return [`| ${head[0]} | ${head[1]} |`, '|---|---|', ...rows.map(([c, d]) => `| \`${c.split('|').join('\\|')}\` | ${d} |`)].join('\n');
}

export function generateAgentsMd(t: Template, project: AgentsMdProject): string {
  const ja = project.lang === 'ja';
  const name = ja ? t.name.ja : t.name.en;
  const steps = t.pipeline
    .map((s, i) => {
      const txt = stepText(s, project.lang);
      const prompt = t.promptFiles[s] ? (ja ? `（\`${t.promptFiles[s]}\` に従う）` : ` (follow \`${t.promptFiles[s]}\`)`) : '';
      return `${i + 1}. **${s}** — ${txt.do}${prompt}`;
    })
    .join('\n');
  const prompts = Object.keys(t.promptFiles).length
    ? Object.entries(t.promptFiles).map(([k, p]) => `- \`${k}\`: \`${p}\``).join('\n')
    : ja ? '（なし）' : '(none)';
  const rules = t.rules.trim() || (ja ? '（テンプレートに rules.md はありません）' : '(the template has no rules.md)');

  if (ja) {
    return `<!-- ferret-video が自動生成したファイルです。テンプレートを変えると作り直されます。手で直すなら rules.md と prompts/ を直してください。 -->
# ${project.title} — エージェントへの指示書

## 役割

あなたはこのプロジェクトの動画編集者です。テンプレート **${name}**（\`${t.id}\` 版 ${t.version}）の手順に従って、撮影した素材から動画を仕上げます。
編集の正本は \`timeline.json\` です。すべての編集は \`ferret-video\` CLI で行います。

- 種類: ${t.kind === 'tech' ? '技術動画' : '語り動画'}
- 出力先: ${t.targets.join(', ')}
- キャンバス: ${t.canvas.width}×${t.canvas.height}, ${t.canvas.fps.num}/${t.canvas.fps.den} fps

## 最初にすること

\`\`\`sh
ferret-video status --json
ferret-video next --json
\`\`\`

\`.ferret-video/handoff.md\` があれば先に読んでください（前のエージェントからの引き継ぎです）。
あとは \`ferret-video next --json\` の \`do\` と \`commands\` に従い、終わったらもう一度 \`ferret-video next --json\` を実行する、を \`"state": "done"\` になるまで繰り返します。

## 守ること

- \`media/\` の中は変更しない（元の素材は読み取り専用）
- 編集は \`ferret-video edit\` で行う。\`timeline.json\` を直接編集したら、必ず \`ferret-video validate\` を実行する
- 編集には必ず理由を付ける（\`--reason\`）。理由は「なぜそうしたか」を1文で
- 手順の合格条件を満たすまで、次の手順に進まない（\`ferret-video next\` が判断する）
- 迷ったら、下の編集方針に従って自分で決める（判定モデルは使わなくてよい）。自信がない判断には needsReview を付け、理由を書いて先へ進む。人に聞きたいことは \`.ferret-video/questions.md\` に書き、待たずに進められる手順を先に進める
- 動画は 16:9 の1本だけ。投稿の内容は \`publish.json\` に書く。投稿はしない（人がアプリで確認して OK してから）
- 長い出力は読まない。\`ferret-video tl summary\` → \`tl show\` / \`tl range\` の順に必要な部分だけ読む

## 手順（${t.id}）

${steps}

## 編集方針（rules.md）

${rules}

## 手順ごとのプロンプト

${prompts}

## CLI の使い方

すべてのコマンドに \`--json\` を付けると機械向けの出力になります。失敗したときは \`{"ok": false, "error": {"code": "…", "message": "…"}}\` を返し、終了コードは 1 です。

${table(CLI_JA, ['コマンド', '内容'])}

\`ferret-video next --json\` の出力例:

\`\`\`json
${NEXT_EXAMPLE}
\`\`\`

編集の例:

\`\`\`sh
${EDIT_EXAMPLE}
\`\`\`

## 終わったとき

\`.ferret-video/handoff.md\` に次の3つを書いてください。エージェントが替わっても、ここから続けられるようにします。

1. やったこと
2. 残っていること（要確認の項目、直せなかったチェック）
3. 次の一手（次に実行するコマンド）
`;
  }

  return `<!-- Generated by ferret-video. Regenerated when the template changes. Edit rules.md and prompts/ instead. -->
# ${project.title} — Instructions for the agent

## Role

You are the video editor of this project. Follow the steps of template **${name}** (\`${t.id}\` version ${t.version}) to turn the recorded media into a finished video.
\`timeline.json\` is the source of truth. Make every edit through the \`ferret-video\` CLI.

- Kind: ${t.kind === 'tech' ? 'tech video' : 'talking-head video'}
- Targets: ${t.targets.join(', ')}
- Canvas: ${t.canvas.width}×${t.canvas.height}, ${t.canvas.fps.num}/${t.canvas.fps.den} fps

## First

\`\`\`sh
ferret-video status --json
ferret-video next --json
\`\`\`

If \`.ferret-video/handoff.md\` exists, read it first (a handoff from the previous agent).
Then follow \`do\` and \`commands\` from \`ferret-video next --json\`, run \`ferret-video next --json\` again, and repeat until \`"state": "done"\`.

## Rules

- Never modify anything in \`media/\` (original media is read-only)
- Edit with \`ferret-video edit\`. If you edit \`timeline.json\` directly, always run \`ferret-video validate\`
- Every edit needs a reason (\`--reason\`): one sentence on why
- Do not move on until the step's pass condition is met (\`ferret-video next\` decides)
- When unsure, decide yourself following the editing policy below (no decision model needed). Mark unsure choices needsReview with a reason and move on. Write questions for the human to \`.ferret-video/questions.md\` and continue with steps that do not depend on them
- One 16:9 video only. Write the post to \`publish.json\`. Never publish (the human checks it in the app and approves)
- Do not read huge outputs: \`ferret-video tl summary\` first, then \`tl show\` / \`tl range\` for the parts you need

## Steps (${t.id})

${steps}

## Editing policy (rules.md)

${rules}

## Prompts per step

${prompts}

## CLI

Add \`--json\` to any command for machine output. Failures return \`{"ok": false, "error": {"code": "…", "message": "…"}}\` with exit code 1.

${table(CLI_EN, ['Command', 'What it does'])}

\`ferret-video next --json\` example:

\`\`\`json
${NEXT_EXAMPLE}
\`\`\`

Edit examples:

\`\`\`sh
${EDIT_EXAMPLE_EN}
\`\`\`

## When you finish

Write these three things to \`.ferret-video/handoff.md\` so any agent can continue from there:

1. What you did
2. What remains (open review items, checks you could not fix)
3. The next move (the next command to run)
`;
}

export const CLAUDE_MD = '@AGENTS.md\n';
