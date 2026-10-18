/**
 * 設定ページの節と、上部の検索欄での絞り込み。画面に依存しない純粋な関数だけを置く（単体テストの対象）。
 *
 * 並びは左の一覧の順。VS Code / Orca の設定ページと同じく、節の名前だけでなく
 * 中の項目の言葉（マイク・キー・テーマ…）でも引けるよう、節ごとに検索語を持つ。
 * 検索語は英語と日本語の両方を入れる（画面の言語を変えても同じ言葉で探せる）。
 */

export const SETTINGS_SECTIONS = [
  // セットアップのチェックリスト（済んだ項目が緑になる）。いつでも見られるよう一番上に置く
  'setup',
  'general',
  // よく使う・大事なもの（Agent と判定モデル）を一般のすぐ下に置く
  'agents',
  'verify',
  // 全体（すべてのプロダクト）の共通のルールとプロダクトごとのルール
  'orchestra',
  // スマホのブラウザから、ターミナルを見て Agent に指示を送る（既定は切）
  'remote',
  'recording',
  'transcription',
  'organize',
  'accounts',
  'appearance',
  'language',
  'layout',
  // 内蔵ブラウザに読み込む Chrome 拡張
  'extensions',
  // 内蔵ブラウザのログインをプロジェクトで共有するか（既定は共有。クライアントごとに分けられる）
  'browserProfiles',
  // ほかのブラウザ（Chrome・Edge・Safari など）のパスワードの CSV と履歴の取り込み
  'browserImport',
  // よく使うサービスの CLI（gh・wrangler・Ollama・クラウド・デプロイ先）のインストールとログイン
  'cli',
  'about'
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]

const SECTION_KEYWORDS: Record<SettingsSectionId, readonly string[]> = {
  setup: ['setup', 'checklist', 'onboarding', 'getting started', 'progress', 'セットアップ', 'チェックリスト', '初期設定', '進み具合'],
  general: ['storage', 'keep', 'retention', 'days', 'delete', 'feedback screen', 'stop', 'crash', 'report', 'privacy', 'sentry',
    '保管', '保存期間', '削除', '日', '停止', 'フィードバック画面', 'クラッシュ', 'プライバシー'],
  appearance: ['theme', 'color', 'dark', 'light', 'system', 'テーマ', '配色', 'ダーク', 'ライト', '外観'],
  language: ['language', 'locale', 'english', 'japanese', 'interface', '言語', '英語', '日本語', '表示言語'],
  layout: ['layout', 'panel', 'dock', 'footer', 'terminal', 'sidebar', 'files', 'position', '配置', 'パネル', 'フッター', 'ターミナル', 'サイドバー', 'レイアウト'],
  remote: ['phone', 'mobile', 'remote', 'smartphone', 'iphone', 'android', 'tailscale', 'wi-fi', 'wifi', 'qr', 'lan', 'port', 'link',
    'スマホ', '携帯', 'リモート', '外出', 'ポート', 'リンク', '遠隔'],
  recording: ['microphone', 'mic', 'audio', 'voice', 'system audio', 'device', 'マイク', '音声', '声', '録音', '録画', 'デバイス'],
  transcription: ['transcription', 'speech', 'whisper', 'model', 'openai', 'api key', 'key', 'base url', 'cost', 'limit', 'compatible', 'local',
    'live transcript', 'show', 'hide', 'warning',
    '文字起こし', 'モデル', 'キー', '費用', '上限', '接続', '端末内', '言語', '表示', '非表示', '警告'],
  organize: ['organize', 'findings', 'llm', 'anthropic', 'claude api', 'gemini', 'openrouter', 'api key', 'model', 'split',
    '整理', '指摘', 'キー', 'モデル', '分割'],
  verify: ['decision', 'verify', 'judge', 'done', 'ollama', 'clef', 'typesafe', 'jev', 'openai', 'gpt-6-luna', 'luna', 'vercel', 'gateway', 'system one', 'api key',
    '判定', '検証', '完了', 'キー'],
  orchestra: ['orchestra', 'orchestrator', 'all products', 'shared rules', 'per-product', 'infrastructure', 'tags', 'instances', 'common',
    'オーケストラ', '全体', '共通', '個別', 'ルール', 'インフラ', 'タグ', 'インスタンス', 'プロダクト'],
  agents: ['agent', 'claude', 'codex', 'antigravity', 'agy', 'gemini', 'opencode', 'cursor', 'copilot', 'aider', 'grok', 'qwen', 'amp', 'hermes', 'openclaw', 'deepseek', 'custom', 'install',
    'command', 'args', 'arguments', 'prompt', 'instruction', 'startup', 'エージェント', 'カスタム', 'インストール', 'コマンド', '引数', '指示', 'プロンプト', '起動'],
  accounts: ['account', 'login', 'sign in', 'usage', 'manage', 'limit', 'failover', 'switch', 'アカウント', 'ログイン', '使用量', '管理', '上限', '切り替え'],
  extensions: ['extension', 'extensions', 'chrome', 'add-on', 'addon', 'plugin', 'browser', 'popup', 'crx', 'edge', 'brave',
    '拡張', '拡張機能', 'ブラウザ', 'アドオン', 'プラグイン', 'ポップアップ'],
  browserProfiles: ['browser', 'login', 'sign in', 'session', 'cookie', 'share', 'shared', 'separate', 'client', 'profile', 'google', 'gmail',
    'ブラウザ', 'ログイン', 'セッション', '共有', '分ける', 'クライアント', 'プロフィール'],
  browserImport: ['import', 'password', 'passwords', 'csv', 'history', 'autofill', 'login', 'chrome', 'edge', 'safari', 'firefox', 'brave', 'arc', 'browser',
    '取り込み', 'パスワード', '履歴', '自動入力', 'ブラウザ', 'ログイン'],
  cli: ['cli', 'command line', 'install', 'login', 'sign in', 'wrangler', 'cloudflare', 'ollama', 'github', 'gitlab', 'glab', 'gh', 'vercel', 'netlify',
    'supabase', 'firebase', 'fly', 'railway', 'heroku', 'stripe', 'gcloud', 'google cloud', 'aws', 'azure', 'docker',
    'repository', 'private', 'owner', 'organization', 'org',
    'コマンドライン', 'インストール', 'ログイン', 'ツール', 'リポジトリ', '組織', '置き場'],
  about: ['about', 'version', 'update', 'ferret', 'movie-ade', 'バージョン', '更新', 'について']
}

/** 全角・大文字小文字の揺れをならす */
function normalizeSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim()
}

/**
 * 検索語に合う節を、一覧の順のまま返す。空なら全部。
 * 空白で区切った語は「すべてを含む」（AND）。節の表示名（今の言語）と検索語の両方を見る。
 */
export function filterSettingsSections(query: string, titleOf: (id: SettingsSectionId) => string): SettingsSectionId[] {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...SETTINGS_SECTIONS]
  return SETTINGS_SECTIONS.filter((id) => {
    const haystack = normalizeSearch([id, titleOf(id), ...SECTION_KEYWORDS[id]].join(' '))
    return words.every((word) => haystack.includes(word))
  })
}

/**
 * スクロール位置から、いま読んでいる節を決める（左の一覧の選択表示に使う）。
 * tops は各節の上端（スクロール領域の上端からの距離）。上端を少しでも過ぎた最後の節を選ぶ。
 */
export function activeSectionAt(tops: ReadonlyArray<{ id: SettingsSectionId; top: number }>, offset = 24): SettingsSectionId | null {
  let current: SettingsSectionId | null = tops[0]?.id ?? null
  for (const { id, top } of tops) if (top <= offset) current = id
  return current
}
