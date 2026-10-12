import type { BrowserExtensionInfo, InstalledBrowserExtension } from './browserExtensions'
import type { GithubPreferences, RepoCreateInfo, RepoCreateRequest, RepoCreateResult } from './repoCreate'
import type { BrowserImportStatus, HistorySourceInfo, PageLogins } from './browserImport'
import type { BlogTargetInput, PostBlogResult, PostDraftPatch, PostXResult, PublishConnectionsInfo, PublishGenerateRequest, PublishSnapshot } from './publish'
import type { ShareRecordingStatus, ShareSettingsInput, ShareSettingsView, ShareSnapshot, ShareSummaryInfo, ShareUrl } from './feedbackShare'
import type { MeetingImportProgress, MeetingImportRequest, MeetingMediaPick, MeetingScoreResult, MeetingTranscriptPick } from './meetingImport'
import type { AgentNotifyOpen, AgentNotifyRequest } from './agentNotify'
import type { FailoverLaunchRequest, FailoverNotice, LimitFailoverPrefs } from './failover'
import type { CliToolStatus } from './cliTools'
import type { AiEndpointConfig, AiVendor, LlmApiProvider, OrganizeRunnerId, SttRemoteProvider } from './aiProviders'
import type { AnnotationColor } from './annotation'
import type { AgentSkillAgent, AgentSkillStatus } from './agentSkill'
import type { SendRequest } from './sendTarget'
import type { CloneFailureKind, CloneProgress, GitHubRepoList, SshConfigHost } from './projectSource'
import type { SshTarget } from './sshCommand'
import type { QuitSaveEntry, QuitSaveOutcome, UnsavedFileRef, UnsavedReveal } from './quitUnsaved'
import type { ClosedTerminal, TerminalRestoreSnapshot } from './terminalRestore'
import type {
  AnnotationHistory,
  AnnotationShortcut,
  AnnotationMode,
  AppMode,
  AgentPreferences,
  CapturePreferences,
  CaptureSourceList,
  DesktopAppInfo,
  DesktopAppLaunch,
  CaptureTarget,
  SttAvailability,
  OrganizerPreferences,
  WhisperModelList,
  WhisperModelName,
  WhisperModelProgress,
  ProjectSession,
  ProjectUpdate,
  ProjectsState,
  TerminalCreateOptions,
  AudioLevel,
  BrowserState,
  MenuCommand,
  PlatformName,
  RecordingStatus,
  Settings,
  SettingsFileError,
  SettingsFileInfo,
  FeedbackTargetsPrefs,
  StartRecordingOptions,
  StartupTiming,
  TerminalSize,
  ThemePreference,
  TerminalTabInfo,
  AccountAgent,
  AgentOption,
  TerminalAttachInfo,
  TerminalSessionInfo,
  ViewBounds,
  Viewport,
  WorkspaceState,
  TuiAgent
} from './types'
import type { DecisionPreferences } from './decision'
import type { ApiUsageSummary } from './apiUsage'
import type { ReviewData, ReviewEdit, ReviewLabelPatch, ReviewProgressPatch, ReviewSummary, ReviewFrame } from './review'
import type { ProgressMap, ReviewVerdict } from './findingProgress'
import type { AccountLoginRequest, AgentAccountAddResult, AgentAccountsState } from './accounts'
import type { AgentResourceList } from './agentResources'
import type { AccountUsage, UsageState } from './usage'
import type { UpdateCheckResult } from './appVersion'
import type { AutoUpdateStatus } from './appUpdate'
import type { SentryTestKind } from './telemetry'
import type { LayoutPrefs } from './layout'
import type { OnboardingPatch, OnboardingState, PermissionKind, PermissionsState } from './onboarding'
import type { ResolvedTheme } from './theme'
import type { LocalePreference, SupportedLocale } from './i18n'
import type { ResourceKillTarget, ResourceSnapshot } from './resources'
import type { FsChangedEvent, FsCreated, FsEntry, FsFileList, FsReadResult, FsSearchMode, FsSearchResult, FsTransfer, FsWriteResult } from './files'
import type { FsFileInfo } from './fileViewer'
import type { FsGitStatus } from './gitDecorations'
import type { StarActionResult, StarPromptMode } from './starPrompt'
import type { FeedbackEnvironment, FeedbackSubmitInput, FeedbackSubmitResult } from './feedback'
import type { GitActionResult, GitRepoStatus } from './github'
import type { FetchTrigger, GitSyncAction } from './gitSync'
import type { DroppedEntry } from './externalDrop'

/**
 * IPC の全チャネルを1か所で宣言する。
 * - `IpcRequests`: renderer → main の呼び出し（ipcRenderer.invoke）
 * - `IpcEvents`:   main → renderer の通知（webContents.send）
 *
 * ハンドラ登録側（main）と呼び出し側（preload）の両方がこの型から生成されるため、
 * チャネル名・引数・戻り値のずれはコンパイルエラーになる。
 */
export interface IpcRequests {
  'app:ready': () => StartupTiming
  'app:settings': () => Settings
  /** settings.json の場所と、壊れているか（~/.ferret/settings.json。src/main/settingsFile.ts） */
  'settingsFile:info': () => SettingsFileInfo
  /** 生の settings.json（設定のページのエディタで開く） */
  'settingsFile:read': () => string
  /** エディタからの保存。壊れていれば書かずにエラーを返す。保存できたら null（取り込みは settings:changed で届く） */
  'settingsFile:write': (text: string) => SettingsFileError | null
  /** settings.json をファイルマネージャで見せる */
  'settingsFile:reveal': () => void
  /** フィードバックモードの右パネルの開閉と幅 */
  'settings:feedbackTargets': (prefs: FeedbackTargetsPrefs) => void
  /** package.json の version と、配布用にパッケージされた起動か（dev 起動なら false） */
  'app:version': () => { version: string; packaged: boolean }
  /** 配信元（R2）の latest.json と比べ、署名を確かめる。自動のダウンロードがオンなら、続けて裏でダウンロードを始める（src/main/autoUpdate.ts） */
  'app:checkUpdate': () => UpdateCheckResult
  /** 直前の確認で署名を確かめたインストーラーを、ダウンロードのフォルダに保存して見せる（自動更新ができないとき） */
  'app:openUpdate': () => void
  /** 裏での更新の状態（最後の確認の結果・ダウンロードの進み具合・「再起動して更新」ができるか） */
  'update:status': () => AutoUpdateStatus
  /** 新しい版を裏でダウンロードする（自動のダウンロードがオフのときの［ダウンロード］・失敗したときの［もう一度］） */
  'update:download': () => boolean
  /** 「再起動して更新」（deb はインストーラーを開く）。作業中の Agent・録画があれば確認を出し、やめたら false */
  'update:install': () => boolean
  /** 新しい版を自動でダウンロードするか（設定の autoUpdate） */
  'update:setAutoDownload': (on: boolean) => AutoUpdateStatus
  /** 配信元にある版の一覧（新しい順）と、今の版・選んでいる版 */
  'update:versions': () => { current: string; pinned: string | null; versions: Array<{ version: string; date: string; prerelease: boolean }> }
  /** 版を選んで落とす（署名で確かめる）。入れ替えは update:install。古い版を選ぶと自動の更新はオフになる */
  'update:chooseVersion': (version: string) => AutoUpdateStatus
  /** 設定の案内のリンク（キーを作るページなど）を外部のブラウザで開く。https だけ（src/shared/setupGuide.ts） */
  'app:openExternal': (url: string) => void
  /**
   * 文を Agent のターミナルへ送る（Agent に設定を頼む指示文）。宛先は「Agent へ送信」と同じ選び方。
   * feedback は人が打ったフィードバックそのもの（あればオーケストラの feedback/ に記録する。@shared/feedbackLog）
   */
  'agent:sendText': (text: string, feedback?: { text: string; product?: string }) => { ok: boolean; message: string; noAgent?: boolean }
  /** Resource Manager。アプリ・内蔵ブラウザ・ターミナルの CPU と RSS */
  'resources:snapshot': () => ResourceSnapshot
  /** ターミナルを止める／内蔵ブラウザのページを閉じる（about:blank にする） */
  'resources:kill': (target: ResourceKillTarget) => void
  /** 画面の読み込み直しで置き去りになったターミナルを止める。止めた数を返す */
  'resources:cleanup': () => number

  'workspace:open': () => WorkspaceState
  'workspace:current': () => WorkspaceState

  /** 登録済みプロジェクト（フォルダ＋URLプリセット） */
  'project:list': () => ProjectsState
  /** フォルダを選んで登録し、そのプロジェクトを開く。キャンセルなら null */
  'project:add': () => ProjectsState | null
  'project:switch': (id: string) => WorkspaceState
  /** 名前・URLの変更。id で既存を置き換える */
  /** 名前・種類・確認先の変更。送った項目だけが変わる（Project をそのまま渡してもよい） */
  'project:update': (project: ProjectUpdate) => ProjectsState
  /** オーケストレーターにする・やめる。子のプロジェクトの subagent を書く・消す（src/main/orchestrator.ts） */
  'project:orchestrator': (id: string, enabled: boolean) => { children: Array<{ dir: string; name: string; agent: string }>; skipped: string[] }
  /** 登録を外すだけ。フォルダは消さない */
  'project:remove': (id: string) => ProjectsState
  /** 中央のタブ・開いているファイル・表示中のレビューを覚える（URL は main が自分で覚える）。通知は送らない */
  'project:saveSession': (id: string, session: Pick<ProjectSession, 'centerTab' | 'openFiles'> & { reviewId?: string | null }) => void
  /** 「プロジェクトを追加」の GitHub / SSH（src/main/projectSources.ts） */
  'project:sshHosts': () => SshConfigHost[]
  'project:githubRepos': () => GitHubRepoList
  /** 「GitLab から取得」の一覧（glab にログイン済みのホストごと。gitlab.com とセルフホスト） */
  'project:gitlabRepos': () => GitHubRepoList
  /** clone の保存先の親フォルダの既定 */
  'project:cloneDefaults': () => { parent: string; home: string }
  /** clone の保存先の親フォルダを選ぶ。キャンセルなら null */
  'project:pickParent': (current?: string) => string | null
  /** clone して、そのフォルダをプロジェクトとして開く。進み具合は project:cloneProgress */
  'project:clone': (url: string, parent: string) => { ok: true; state: ProjectsState } | { ok: false; kind: CloneFailureKind; detail: string }
  'project:cloneCancel': () => void
  /** SSH の接続先とリモートのフォルダを登録して開く（鍵やパスワードは扱わない） */
  'project:addSsh': (target: SshTarget, name?: string) => ProjectsState
  /** 外から落としたフォルダ（drop:inspect で確かめたもの）をプロジェクトとして登録して開く。登録済みならそれに切り替える */
  'project:addDropped': (path: string) => ProjectsState
  /** 一覧の並べ替え。ids は新しい並び（知らない ID は捨て、無いプロジェクトはその位置のまま） */
  'project:reorder': (ids: string[]) => ProjectsState
  /** プロジェクトを別のオーケストラへ移す・並べ替える（before の前。null ならそのオーケストラの最後）。オーケストラ同士の並べ替えにも使う */
  'project:move': (id: string, toOrchestraId: string | null, beforeId: string | null) => ProjectsState
  /** 新しいオーケストラを作って開く */
  'orchestra:create': (name: string) => ProjectsState
  /**
   * 外から落としたファイル・フォルダのパスを確かめる（src/main/droppedPaths.ts）。
   * preload の inspectDrop だけが呼ぶ（IPC_REQUEST_CHANNELS には入れない＝window.ade.invoke からは呼べない）
   */
  'drop:inspect': (paths: string[]) => DroppedEntry[]

  'settings:agents': (preferences: AgentPreferences) => void
  /** エージェントの一覧（設定とインストール済みかの検出を合わせたもの）。refresh で検出し直す */
  'agents:list': (refresh?: boolean) => AgentOption[]
  /** よく使うサービスの CLI（gh・wrangler・Ollama など）の検出（入っているか・版）。refresh で検出し直す */
  'cliTools:list': (refresh?: boolean) => CliToolStatus[]
  /** その CLI のスキル・スラッシュコマンド・MCP サーバー（読むだけ。MCP は名前・種類・コマンド名か host だけ） */
  'agents:resources': (agent: TuiAgent) => AgentResourceList
  /** 空文字で既定文に戻す */
  'settings:agentPrompt': (template: string) => void
  /** Agent への依頼文の変更（src/shared/agentRequests.ts）。定期の送った時刻は main が持つ */
  'settings:agentRequests': (prefs: import('./agentRequests').AgentRequestPrefs) => void
  /** 選んだ依頼文を、開いているプロジェクトの Agent へ送る（複数ならまとめて1つの依頼） */
  'agentRequests:send': (ids: string[]) => { ok: boolean; message: string; noAgent?: boolean }
  /** 全プロダクトの確認待ちのレビュー（確認の巡回。src/shared/productRound.ts） */
  'review:pendingAcross': () => Array<{ projectId: string; reviewId: string; count: number }>
  /** 全体のダッシュボード：プロジェクトごとの進み具合・コスト、人の確認リスト（human.md）。src/main/orchestraOverview.ts */
  'orchestra:overview': () => import('./orchestraOverview').OrchestraOverview
  /** 全体の human.md の確認リストだけ（フィードバックの帯。コストは数えない） */
  'orchestra:checklist': () => import('./humanChecklist').ChecklistItem[]
  /** 人の答えを全体の human.md の「## 回答」に書く（空の答えは消す）。書いたあとの確認リストを返す */
  'orchestra:answer': (entries: Array<{ key: string; answer: string }>) => import('./humanChecklist').ChecklistItem[]
  /** human.md の答えと「人の確認なしで進めてよい操作」をまとめて、全体の Agent に1回で送る */
  'orchestra:sendAnswers': () => { ok: boolean; message: string; noAgent?: boolean }
  /** 開いているオーケストラのフィードバックの記録（log）・プレイブック（playbook）を用意して、オーケストラのフォルダからの相対パスを返す */
  'orchestra:feedbackFile': (which: 'log' | 'playbook') => string
  /** 全体（すべてのプロダクト）の共通のルールとプロダクトごとのルール */
  'settings:orchestra': (rules: import('./orchestrator').OrchestraRules) => void
  /** 全体として人の確認なしで進めてよい操作だけを書き換える（ダッシュボード） */
  'settings:orchestraAllowed': (allowed: string) => void

  /** Claude Code / Codex のアカウント。一覧を読むたびにログインの済んだ行を登録し直す */
  'accounts:list': () => AgentAccountsState
  /** 設定フォルダと「ログイン待ち」の行を作る。続けて内蔵ターミナルでログインを始める */
  'accounts:add': (agent: AccountAgent) => AgentAccountAddResult
  'accounts:rename': (agent: AccountAgent, accountId: string, label: string) => AgentAccountsState
  /** 一覧から外し、本システムが作った設定フォルダを消す */
  'accounts:remove': (agent: AccountAgent, accountId: string) => AgentAccountsState
  /** null はシステムの既定アカウント。新しく開く Agent から効く */
  'accounts:select': (agent: AccountAgent, accountId: string | null) => AgentAccountsState
  /** ログインをやり直す（ターミナルで開く指定を返す） */
  'accounts:relogin': (agent: AccountAgent, accountId: string) => AccountLoginRequest

  /** 選択中のアカウントの使用量（フッター左下）。変わると usage:changed で届く */
  'usage:get': () => UsageState
  /** force なら連打よけを越えて取り直す。そうでなければ古いもの・切り替えたものだけ */
  'usage:refresh': (force: boolean) => UsageState
  /** アカウント別の内訳（Usage ポップオーバーの「>」）。開いたときだけ取る */
  'usage:accounts': (agent: AccountAgent, force: boolean) => AccountUsage[]
  /** 上限での自動切り替えの設定（保存はすぐ。設定画面のアカウントの節） */
  'failover:get': () => LimitFailoverPrefs
  'failover:set': (prefs: LimitFailoverPrefs) => LimitFailoverPrefs
  /** Agent が終わった・確認を待っている OS 通知（設定の agents.notify が入のときだけ main が出す）。出したら true */
  'agentNotify:show': (request: AgentNotifyRequest) => boolean

  'mode:set': (mode: AppMode) => void

  'browser:setBounds': (bounds: ViewBounds | null) => void
  'browser:navigate': (url: string) => void
  /** 新しいタブを開いて前に出す。url を省けば空のタブ（上限・開けない URL なら断る） */
  'browser:newTab': (url?: string) => void
  'browser:closeTab': (id: string) => void
  /** タブの右クリックのメニュー（OS のメニュー。ページの上にも出る）を出し、選んだ閉じ方で閉じる。at は窓の中の位置 */
  'browser:tabMenu': (id: string, at: { x: number; y: number }) => void
  'browser:activateTab': (id: string) => void
  'browser:back': () => void
  'browser:forward': () => void
  'browser:reload': () => void
  /** 表示中のタブのページを OS の既定のブラウザで開く。URL は渡さない（main が表示中のタブの URL を使い、http / https だけ通す） */
  'browser:openExternal': () => void
  'browser:setViewport': (viewport: Viewport) => void
  'browser:state': () => BrowserState
  /** 内蔵ブラウザの拡張機能の一覧と読み込みの結果（src/main/browserExtensions.ts） */
  'browserExtensions:list': () => BrowserExtensionInfo[]
  /** 展開済みの拡張のフォルダを選んで足す（ダイアログは main が出す。パスは画面から受け取らない）。やめたら null */
  'browserExtensions:addFolder': () => BrowserExtensionInfo[] | null
  /** Chrome・Edge・Brave などのプロフィールに入っている拡張（取り込みの候補） */
  'browserExtensions:scanInstalled': () => InstalledBrowserExtension[]
  /** 候補（直前の scanInstalled の key）を Ferret の設定フォルダへ写して足す */
  'browserExtensions:import': (key: string) => BrowserExtensionInfo[]
  'browserExtensions:setEnabled': (path: string, enabled: boolean) => BrowserExtensionInfo[]
  /** 設定から外す（取り込んだ写しは消す。利用者のフォルダは消さない） */
  'browserExtensions:remove': (path: string) => BrowserExtensionInfo[]
  /**
   * Chrome ウェブストアから入れる。input はストアの URL か拡張の ID。省けば内蔵ブラウザでいま開いているストアのページ。
   * main が Google の配布の置き場から取り、署名と ID を確かめてから入れる（src/main/crx.ts）
   */
  'browserExtensions:installFromStore': (input?: string) => BrowserExtensionInfo[]
  /** .crx を選んで入れる（ダイアログは main が出す。署名を確かめる）。やめたら null */
  'browserExtensions:addCrx': () => BrowserExtensionInfo[] | null
  /**
   * ツールバーの拡張機能のボタンのメニュー（at はウインドウの中の位置）。「拡張機能を管理」は 'manage'、
   * 「このページの拡張を入れる」（ストアのページを開いているとき）は 'install'
   */
  'browserExtensions:menu': (at: { x: number; y: number }) => 'manage' | 'install' | null
  /** ツールバーの拡張のボタン：そのポップアップを開く（無ければ設定のページ）。どちらも無ければ 'none'、閉じたら 'closed' */
  'browserExtensions:open': (path: string) => 'popup' | 'options' | 'closed' | 'none'
  /** ほかのブラウザからの取り込み（パスワードの CSV・履歴）の件数（src/main/browserImport/） */
  'browserImport:status': () => BrowserImportStatus
  /**
   * パスワードの CSV を取り込む。key が無ければダイアログで選ぶ（main が出す。パスは画面から受け取らない）、
   * あれば直前の findExports で見つけたファイル。同じブラウザから前に取り込んだものは置き換える（同期）。やめたら null。
   * file は取り込んだファイルの key（ごみ箱へ移すのに使う）
   */
  'browserImport:importPasswords': (key?: string) => { added: number; updated: number; removed: number; skipped: number; file: string } | null
  /** ダウンロード・デスクトップにある、ここ 14 日のパスワードの書き出しの CSV（新しい順） */
  'browserImport:findExports': () => import('./browserImport').PasswordExportFile[]
  /** 取り込んだ（この起動で選んだ・見つけた）CSV をごみ箱へ移す。平文のパスワードを残さない */
  'browserImport:trashExport': (key: string) => boolean
  'browserImport:clearPasswords': () => BrowserImportStatus
  /** 履歴を取り込める元（Chromium 系のプロフィール・Safari）。取り込みは key で選ぶ */
  'browserImport:historySources': () => HistorySourceInfo[]
  /** 直前の historySources の key の履歴を取り込む。read は読んだ件数 */
  'browserImport:importHistory': (key: string) => { read: number; status: BrowserImportStatus }
  'browserImport:clearHistory': () => BrowserImportStatus
  /** URL 欄の入力に合う、取り込んだ履歴（全プロジェクト共通） */
  'browserImport:suggest': (query: string) => Array<{ url: string; title: string }>
  /** 内蔵ブラウザの表示中のタブのページに使える保存した資格情報（ユーザー名だけ。パスワードは返さない） */
  'passwords:forPage': () => PageLogins
  /** 選んだ1件を表示中のタブのページへ入れる（オリジンは main が確かめる）。入れた欄の数 */
  'passwords:fill': (id: string) => number
  /** 資格情報が複数あるときのネイティブのメニュー（at はウインドウの中の位置）。選んだものを入れたら true、管理を選んだら 'manage' */
  'passwords:menu': (at: { x: number; y: number }) => boolean | 'manage'
  /** 発信（X とブログへの投稿。src/main/publish/）。このプロジェクトの下書きとバックグラウンドの生成の様子（メディアは見本だけ） */
  'publish:list': () => PublishSnapshot
  /** AI に下書きを作らせる（intent＝何を発信したいか・文章を渡せばそれから、無ければプロジェクトの最近の変更から）。作った数（新しいものが一覧の先頭） */
  'publish:generate': (request: PublishGenerateRequest) => number
  /** 手で書く下書きを作る */
  'publish:create': (text: string) => string
  'publish:update': (id: string, patch: PostDraftPatch) => void
  'publish:remove': (id: string) => void
  /** 画像・動画を選んで下書きに付ける（ファイルの選択は main が出す。実パスは main だけが持つ）。付けた数 */
  'publish:pickMedia': (id: string) => number
  /** プロジェクトの中のファイル（相対パス）を下書きに付ける（ファイルツリーからのドロップ） */
  'publish:addProjectMedia': (id: string, relPaths: string[]) => number
  /** バックグラウンドで下書きを作るか */
  'publish:setBackground': (enabled: boolean) => void
  /** 接続先（X の Client ID・つながっているか・ブログの一覧）。トークン・パスワードは返さない */
  'publish:connections': () => PublishConnectionsInfo
  /** X の Client ID を保存する（空なら消す。変えたら前のトークンは捨てる） */
  'publish:setXClientId': (clientId: string) => PublishConnectionsInfo
  /** 既定のブラウザで X の認証を開き、許可されるまで待ってトークンを保存する */
  'publish:connectX': () => PublishConnectionsInfo
  /** 待っている X の認証をやめる */
  'publish:cancelConnectX': () => void
  'publish:disconnectX': () => PublishConnectionsInfo
  /** ブログの接続先を、接続を確かめてから足す */
  'publish:addBlog': (input: BlogTargetInput) => PublishConnectionsInfo
  'publish:removeBlog': (id: string) => PublishConnectionsInfo
  /** 保存した下書きを X API で投稿する（長ければスレッド。メディアは1件目） */
  'publish:postX': (id: string) => PostXResult
  /** 保存した下書きの記事をブログへ投稿する（draft なら下書きとして置く） */
  'publish:postBlog': (id: string, blogId: string, draft: boolean) => PostBlogResult
  /** ログイン無しで誰でも指摘を送れる共有リンク（src/main/feedbackShare/）。このプロジェクトの共有の一覧 */
  'share:list': () => { shares: ShareSummaryInfo[]; persisted: boolean }
  /** 開いているページの共有（同じ URL の期限内のもの）を返す。無ければ作る。リンクは画面がコピーする */
  'share:forPage': (page: ShareUrl) => { share: ShareSummaryInfo; created: boolean }
  /** 設定（題名・ページ・メモ・パスワード）を決めて共有を作る */
  'share:create': (input: ShareSettingsInput) => ShareSummaryInfo
  /** 共有の設定を開く（パスワードそのものは返さない） */
  'share:settings': (shareId: string) => ShareSettingsView
  /** 共有の設定を変える */
  'share:update': (shareId: string, input: ShareSettingsInput) => ShareSummaryInfo
  /** 覚えているパスワードを main がクリップボードへ写す（画面へは返さない） */
  'share:copyPassword': (shareId: string) => void
  /** 共有の中身と届いた録画（サムネイルは data URL） */
  'share:open': (shareId: string) => { snapshot: ShareSnapshot; thumbnails: Record<string, string> }
  /** 録画を断る・断ったのを戻す */
  'share:setStatus': (shareId: string, recordingId: string, status: Extract<ShareRecordingStatus, 'new' | 'rejected'>) => void
  /** 届いた録画を mtg と同じ流れでレビュー（指摘の候補）にする。進み具合は meeting:progress */
  'share:import': (shareId: string, recordingId: string) => ReviewData
  /** 共有を消す（相手の画面も見られなくなる） */
  'share:delete': (shareId: string) => void

  'terminal:create': (options: TerminalCreateOptions) => TerminalTabInfo
  'terminal:write': (id: string, data: string) => void
  'terminal:resize': (id: string, size: TerminalSize) => void
  'terminal:close': (id: string) => void
  'terminal:screen': (id: string, text: string) => void
  'terminal:agentState': (id: string) => { kind: string; state: string; agent?: TuiAgent | null }
  /** 複数のターミナルの状態をまとめて調べる（ペインごとの毎秒の問い合わせを1回に）。返す順は ids と同じ */
  'terminal:agentStates': (ids: string[]) => Array<{ kind: string; state: string; agent?: TuiAgent | null }>
  /** 画面に出ているターミナル。それ以外は main が出力をゆっくりまとめて送る（src/main/terminal.ts の HIDDEN_FLUSH_INTERVAL_MS） */
  'terminal:visible': (ids: string[]) => void
  /** 閉じたとき作業の途中だった Agent に、入力欄が出たら続きから再開するよう頼む（戻したタブ。送ったら true） */
  'terminal:continueWork': (id: string) => boolean
  /** シェルの今のカレント（分割したペインに引き継ぐ）。終了済みなら null */
  'terminal:cwd': (id: string) => string | null
  /** 開いているターミナルの一覧（画面を読み込み直したあと、つなぎ直す先を探す） */
  'terminal:list': () => TerminalSessionInfo[]
  /** 生きているターミナルにつなぎ直す（新しくは作らない）。終了していれば null */
  'terminal:attach': (id: string) => TerminalAttachInfo | null
  /** クリップボードの文字列（Windows / Linux のターミナルの Ctrl+V 貼り付け。renderer には読み取りの権限を渡していない） */
  /** Ctrl+V の貼り付けを main に頼む。中身は返さない（押した直後・端末にフォーカスがあるときだけ。security-7 [1]） */
  'terminal:paste': () => boolean
  /** ターミナルへの貼り付けで、クリップボードのファイル・画像をプロジェクトの .ferret/pasted/ に写し、作ったものの絶対パスだけを返す。無ければ null */
  'terminal:pasteFiles': () => string[] | null
  /** ターミナルの選択範囲のコピーをクリップボードへ（キーを押した直後だけ書く。security-5 [9]） */
  'terminal:writeClipboard': (text: string) => void
  /** 端末のプログラムのコピー（OSC 52）。確認なしで写す。写せたら true（src/main/terminalClipboard.ts） */
  'terminal:programCopy': (id: string, text: string) => boolean
  /** renderer が terminal:data の出力を描き終えた文字数（main の流量制御。src/main/terminal.ts の FLOW_HIGH_WATER） */
  'terminal:ack': (id: string, chars: number) => void
  /** ターミナルにフォーカスが入った・外れた。Windows / Linux でターミナルのキー（Ctrl+R など）をメニューに取らせない（terminalMenuKeys.ts） */
  'terminal:focused': (focused: boolean) => void
  /** 今開いているタブと画面の文字（終了したあとに戻すため。設定の agents.restoreTerminals が切なら main は捨てる） */
  'terminal:restoreSave': (snapshot: TerminalRestoreSnapshot) => void
  /** 起動して最初の1回だけ、前に終了したときのタブ。無い・切なら null */
  'terminal:restoreTake': () => TerminalRestoreSnapshot | null
  /** 利用者が閉じたタブ（開き直すため） */
  'terminal:closedPush': (entry: ClosedTerminal) => void
  /** そのプロジェクトで最後に閉じたタブを取り出す。無ければ null */
  'terminal:closedPop': (projectId: string | null) => ClosedTerminal | null
  /** 覚えたタブと画面の文字をすべて消す（設定の「保存した履歴を消す」） */
  'terminal:restoreClear': () => void
  /**
   * 指摘を Agent へ送る。request は宛先と差し替える本文（@shared/sendTarget の SendRequest。古い形のターミナルの id も受ける）。
   * noAgent: 宛先に Agent が居ない（launchAgent があればそれを、無ければ既定の Agent を renderer が起動して送り直す）。
   * terminalId: 実際に送ったターミナル。submitted: false なら貼り付けただけ（Enter は利用者が押す）
   */
  'review:send': (sessionId: string, request: SendRequest | string | null) => { ok: boolean; message: string; noAgent?: boolean; launchAgent?: TuiAgent; terminalId?: string; submitted?: boolean }

  'settings:splitRatio': (ratio: number) => void
  /** パネルの置き場所と表示、フッターの項目 */
  'settings:layout': (layout: LayoutPrefs) => void
  /** 配色を保存し、ネイティブ側（nativeTheme・ウインドウの背景）にも反映する */
  'settings:theme': (theme: ThemePreference) => void
  /** 画面の言語を保存し、main 側（メニュー・ダイアログ）も切り替える。戻り値は解決済みの言語 */
  'settings:locale': (locale: LocalePreference) => SupportedLocale
  /** クラッシュレポートを送るか。OFF はすぐ効く。ON は次の起動から（初期化は起動時だけ） */
  'settings:crashReports': (enabled: boolean) => void
  /** active = この起動で Sentry を初期化したか（設定が ON で E2E でないとき。dev も含む）。packaged = 配布版か。test = 確認用にわざと起こす例外（FERRET_SENTRY_TEST）。noticeShown = 初回の案内を出し終えたか */
  'telemetry:state': () => { active: boolean; enabled: boolean; noticeShown: boolean; packaged: boolean; test: SentryTestKind[] }
  /** 初回の案内を閉じた */
  'telemetry:noticeShown': () => void
  /** スマホから操作の今の状態（待ち受け・URL・QR・失敗の理由。src/main/mobileRemote.ts） */
  'remote:state': () => import('./mobileRemote').MobileRemoteState
  /** 入れる・切る・ポートを変える。入れるのは利用者が押した直後だけ。保存して開け閉めしたあとの状態を返す */
  'remote:set': (patch: { enabled?: boolean; port?: number }) => import('./mobileRemote').MobileRemoteState
  /** 合言葉を作り直す（古いリンクのスマホは使えなくなる）。利用者が押した直後だけ */
  'remote:resetToken': () => import('./mobileRemote').MobileRemoteState
  /** 初回起動のセットアップの進み具合を保存する（null で項目を消す）。保存後の値を返す */
  'settings:onboarding': (patch: OnboardingPatch) => OnboardingState | null
  /** Ferret の設定を変える skill（Claude Code・Codex）を入れてあるか */
  'agentSkill:status': () => AgentSkillStatus[]
  /** skill を入れる・書き直す（押した直後だけ）。agents を省くと使っている Agent すべて */
  'agentSkill:install': (agents?: AgentSkillAgent[]) => AgentSkillStatus[]
  /** マイク・画面収録の OS の許可の状態（読むだけで確認のダイアログは出さない） */
  'permissions:status': () => PermissionsState
  /** 押したときだけ許可を求める。マイクは OS の確認、画面収録はシステム設定を開く（macOS だけ） */
  'permissions:request': (kind: PermissionKind) => PermissionsState

  // 録画（要件 5.3・5.4）
  'recording:start': (options: StartRecordingOptions) => RecordingStatus
  'recording:pause': () => RecordingStatus
  'recording:resume': () => RecordingStatus
  'recording:stop': () => RecordingStatus
  'recording:status': () => RecordingStatus
  /** 録画中に映像を足す（選択画面で選んだ直後だけ）。足したトラックの id。画面もそちらへ切り替える */
  'recording:addTrack': (target: CaptureTarget) => string
  /** 画面に映して書き込むトラックを切り替える（録画はどのトラックも続ける） */
  'recording:switchTrack': (id: string) => void
  /** 録っている映像（トラック）と待ち受けのいまの状態 */
  'recording:tracks': () => import('./captureTracks').CaptureTracksState
  'annotation:setMode': (mode: AnnotationMode) => void
  /** 書き込みの色を変え、settings.json（capture.annotationColor）にも残す */
  'annotation:setColor': (color: AnnotationColor) => void
  'annotation:clear': () => void
  /**
   * 文字で指摘（エディタの内蔵ブラウザ・映したウインドウで枠を引いて指示を打つ。録画しない）の入・切。
   * reviewId は足し先（Findings で開いているレビュー）。無ければ最初の1件で新しいレビューを作る。実際の状態を返す
   */
  'note:setMode': (enabled: boolean, reviewId?: string | null) => boolean
  /** 書き込みを一つ前に戻す・やり直す（描く・動かす・消去が1手。録画中だけ） */
  'annotation:undo': () => void
  'annotation:redo': () => void
  /** 省略時は開いているフォルダ。指定できるのは登録済みプロジェクトのフォルダだけ（サイドバーの入れ子表示用） */
  'review:list': (folderPath?: string) => ReviewSummary[]
  /** セットアップの確認用。録画したことがあるか・送ったことがあるか（新しい数件だけを見る。全部の履歴は読まない） */
  'review:activity': (folderPath: string) => { recorded: boolean; sent: boolean }
  /** レビューの名前・アーカイブを変える（folderPath は登録済みプロジェクトに限る。省略時は開いているプロジェクト） */
  'review:label': (id: string, patch: ReviewLabelPatch, folderPath?: string) => void
  /** レビューを消す（.ferret/reviews/<日時>/ ごと。古いものは .ade-movie/）。消せた ID を返す */
  'review:delete': (ids: string[], folderPath?: string) => string[]
  'review:load': (id: string) => ReviewData
  'review:edit': (sessionId: string, edit: ReviewEdit) => ReviewData
  /** 指摘の進み具合（progress.json）を変えて、今の値を返す。patch を省くと読むだけ（Agent が書いたあとの読み直し） */
  'review:progress': (sessionId: string, patch?: ReviewProgressPatch) => ProgressMap
  /** 「Agent から確認があります」への返答を送る1行を作る。renderer が review:send の text（差し替えの本文）として送る */
  /** 人の判断（OK / NG / Comment）を記録して、今の進み具合を返す。NG と Comment は本文が必須 */
  'review:verdict': (sessionId: string, itemId: string, verdict: ReviewVerdict, text?: string) => ProgressMap
  /** NG の指摘をコメントつきで送り直す1行を作る（itemIds を省くと送り直し待ちすべて）。renderer が review:send の text として送る */
  'review:ngPrompt': (sessionId: string, itemIds?: string[]) => { text: string; ids: string[] }
  /** NG を送り直したあと。送り直し待ちを外して対応中にする */
  'review:resent': (sessionId: string, itemIds: string[]) => ProgressMap
  'review:copy': (id: string) => void
  'review:folder': (id: string) => void
  'review:restore': (id: string, t: number) => ReviewData
  /** CLI（各自の契約）か、API キーで直接（api:anthropic など） */
  'review:organize': (id: string, runner: OrganizeRunnerId) => ReviewData
  'review:frames': (id: string, itemId: string) => ReviewFrame[]
  /** mtg の取り込み（@shared/meetingImport）。動画・文字起こしのファイルは main のダイアログで選ぶ（パスは画面へ渡さない） */
  'meeting:pickMedia': () => MeetingMediaPick | null
  'meeting:pickTranscript': () => MeetingTranscriptPick | null
  'meeting:import': (request: MeetingImportRequest) => ReviewData
  /** 取り込んだ候補を判定モデルで確かめ、点を付ける（判定を有効にしていなければ skipped） */
  'meeting:score': (reviewId: string) => { review: ReviewData; result: MeetingScoreResult }
  'settings:capture': (preferences: CapturePreferences) => void
  'capture:devices': () => Array<{ id: string; label: string }>
  /** 空文字は解除。persisted は暗号化して保存できたか（false なら起動中だけ保持） */
  'capture:apiKey': (key: string, provider?: AiVendor) => { persisted: boolean }
  /** 「接続を確認」。1秒の無音を送り、届くかどうかを日本語で返す */
  'capture:testConnection': (target: { provider: SttRemoteProvider; endpoint?: AiEndpointConfig }) => { ok: boolean; message: string }
  /** 文字起こしの接続先の上書きと費用の上限を保存する（設定の文字起こしの節がその場で保存する） */
  'settings:stt': (patch: { sttEndpoints?: Partial<Record<SttRemoteProvider, AiEndpointConfig>>; costLimitUsd?: number | null }) => void
  /** 「指摘を整理」の実行方法と API の接続先を保存する */
  'settings:organizer': (prefs: OrganizerPreferences) => void
  /** 整理の API の「接続を確認」。短い質問を1回送る */
  'organize:testConnection': (target: { provider: LlmApiProvider; endpoint?: AiEndpointConfig }) => { ok: boolean; message: string }
  /** 判定モデルの設定を保存し、整えた値を返す（キーは capture:apiKey で提供元ごとに保存） */
  'settings:decision': (prefs: DecisionPreferences) => DecisionPreferences
  /** 従量課金の API 呼び出しの集計（今日・今月・プロジェクト・モデル・種類ごと、直近 50 件）。フッター左下 */
  /** 判定モデルの「接続を確かめる」（押したときだけ。画面でまだ保存していない値で1回送る。記録に数える）。合否の判定はしない */
  'decision:testConnection': (prefs: DecisionPreferences) => { ok: boolean; message: string; model?: string; latencyMs?: number }
  'usage:apiCalls': () => ApiUsageSummary
  /** 記録の JSONL を Finder / エクスプローラーで示す */
  'usage:openApiLog': () => void
  'capture:model': () => boolean
  'capture:availability': () => SttAvailability
  /** 端末内の文字起こしのモデルの一覧と、whisper-cli の有無 */
  'capture:whisperModels': () => WhisperModelList
  /** 落として sha256 を照合し、終わったらそのモデルを選ぶ。失敗・中止は結果で返す */
  'capture:downloadModel': (id: WhisperModelName) => { ok: true } | { ok: false; reason: 'aborted' | 'failed'; message: string }
  'capture:cancelModelDownload': () => void
  /** 録画の対象の候補（画面・ウインドウ。サムネイル付き）と、画面収録の許可 */
  'capture:sources': () => CaptureSourceList
  /** 画面収録の許可だけを調べる（一覧は取らない。macOS で許可の確認ダイアログを出さないため） */
  'capture:screenAccess': () => CaptureSourceList['screenAccess']
  /** 録画の対象を覚える（次回の既定） */
  'capture:setTarget': (target: CaptureTarget) => void
  /** macOS のシステム設定（画面収録）を開く */
  'capture:openScreenSettings': () => void
  /** 入れてあるデスクトップアプリ（まだ開いていないものも名前で選べるように。recording/apps.ts） */
  'capture:apps': () => DesktopAppInfo[]
  /** capture:apps の1件を起動・前面へ出す（利用者が選んだ直後だけ）。ウインドウを探す手がかりを返す */
  'capture:launchApp': (id: string) => DesktopAppLaunch

  // ファイルエディタ。パスはすべて開いているプロジェクトからの相対パス（外は main が断る）
  'fs:list': (relDir: string) => FsEntry[]
  'fs:read': (relPath: string) => FsReadResult
  'fs:write': (relPath: string, content: string) => FsWriteResult
  /** クイックオープン（⌘P）用の全ファイル一覧。.gitignore に従う */
  'fs:files': () => FsFileList
  'fs:search': (query: string, mode: FsSearchMode) => FsSearchResult
  /** 文字として開けないファイルの大きさと先頭のバイト（画像・動画・バイナリの表示） */
  'fs:inspect': (relPath: string) => FsFileInfo
  /** Office の文書（.docx・.xlsx・.pptx など）の中身。プレビューのために renderer で HTML にする（ほかの種類・上限を超えるものは断る） */
  'fs:readOffice': (relPath: string) => Uint8Array
  /** ファイルツリーの git の色分け（変更・追跡外・削除・.gitignore の対象）。git のリポジトリでなければ isGit: false（src/main/gitDecorations.ts） */
  'fs:gitStatus': () => FsGitStatus
  /** ファイルツリーから空のファイル・フォルダを作る（名前の / で途中のフォルダも）。作ったものの相対パスを返す（既にあれば断る。src/main/fileOps.ts） */
  'fs:create': (parentRel: string, name: string, kind: 'file' | 'directory') => FsCreated
  /** 選んだものを destRel のフォルダへコピーする（貼り付け・複製。同じ名前は「名前 copy」にする） */
  'fs:copy': (relPaths: string[], destRel: string) => FsTransfer[]
  /** 選んだものを destRel のフォルダへ動かす（切り取り・貼り付け・ドラッグ。同じ名前があれば断る） */
  'fs:move': (relPaths: string[], destRel: string) => FsTransfer[]
  /** OS から落としたファイル・フォルダ（drop:inspect で確かめた絶対パスだけ）を destRel のフォルダへコピーする */
  'fs:import': (absolutePaths: string[], destRel: string) => FsTransfer[]
  /**
   * ファイルツリーの貼り付け。OS のクリップボードのファイル（Finder などでコピーしたもの）か画像を destRel のフォルダへ取り込む。
   * 中身・元のパスは返さず、作ったものの相対パスだけ（押した直後だけ。src/main/clipboardFiles.ts）。何も無ければ kind: 'none'
   */
  'fs:pasteClipboard': (destRel: string) => { kind: 'files' | 'image' | 'none'; created: string[] }
  /** OS から Markdown のファイルへ落とした画像・動画（drop:inspect で確かめた絶対パスだけ）を、その隣の assets/ などへコピーする。コピーの相対パスを渡した順に返す */
  'fs:importMedia': (markdownRel: string, absolutePaths: string[]) => string[]
  /** パスをクリップボードへ書く（絶対パスか、プロジェクトからの相対パス）。書いた文字列を返す */
  'fs:copyPath': (relPaths: string[], kind: 'absolute' | 'relative') => string
  /** 「ターミナルで開く」の作業フォルダ（絶対パス）。ファイルならその親 */
  'fs:terminalDir': (relPath: string) => string
  /** 同じフォルダの中で名前を変える。新しい相対パスを返す（既にある名前には上書きしない） */
  'fs:rename': (relPath: string, newName: string) => string
  /** ゴミ箱へ送る（shell.trashItem）。送った相対パスを返す */
  'fs:trash': (relPaths: string[]) => string[]
  /** Finder（エクスプローラ）でファイルを選んで見せる */
  'fs:reveal': (relPath: string) => void
  /** OS の既定のアプリで開く。実行されうる種類は断る（@shared/fileViewer の isRiskyToOpenExternally） */
  'fs:openExternal': (relPath: string) => void
  /** エディタで未保存のファイル（開いたときのプロジェクトのフォルダと相対パス）。終了するときの確認に使う（別のプロジェクトのタブも含む） */
  'editor:unsaved': (files: UnsavedFileRef[]) => void
  /**
   * 終了の確認で「保存して終了」を選んだ: editor:saveForQuit で頼まれた requestId と、未保存のファイルの中身を返す。
   * main は確認で示したファイルだけを、登録済みのプロジェクトの中へ書き、ファイルごとの結果を返す
   */
  'editor:quitSave': (requestId: string, entries: QuitSaveEntry[]) => QuitSaveOutcome[]
  /** 編集中（未保存）の内容をプレビューの中身（HTML）にする。横に並べたプレビューを打鍵に追従させる */
  'preview:render': (path: string, source: string) => string

  // GitHub 連携（認証は gh CLI に任せる。トークンは扱わない）
  /** リポジトリ・ブランチ・フィードバックで作った Issue のページを既定のブラウザで開く（GitHub と今のプロジェクトのホストのURLだけ） */
  'github:open': (url: string) => void
  /** フッター用：今のプロジェクトのリポジトリ・ブランチ・変更の数。呼ぶと .git/HEAD の見張りも始める */
  'github:repoStatus': () => GitRepoStatus
  /**
   * 裏の fetch（open: プロジェクトを開いた・interval: 定期・focus: 前に出した）。走らせるかは main が決め、走らせなければ null。
   * 失敗は投げずに、返す状態の fetch.lastError に入れる
   */
  'github:autoFetch': (trigger: FetchTrigger, visible: boolean) => GitRepoStatus | null
  /** フッターの「リモートの変更を確認」「最新を取得」「push」。push は確認を出したときの HEAD を渡し、押した直後だけ受け付ける */
  'github:gitAction': (action: GitSyncAction, expectedHead: string | null) => GitActionResult
  /** 裏の fetch を、今のリモートに認める（true）・認めない（false）。押した直後だけ（security-7 [9]） */
  'github:autoFetchConsent': (allowed: boolean) => GitRepoStatus
  /** 右クリックの「GitHub で private リポジトリを作る」の下調べ（何も変えない。src/main/github/createRepo.ts） */
  'github:repoCreateInfo': (projectId: string) => RepoCreateInfo
  /** private のリポジトリを作り、このフォルダの origin にする（コミットがあれば push） */
  'github:createPrivateRepo': (projectId: string, request: RepoCreateRequest) => RepoCreateResult
  /** 新しいリポジトリの既定の置き場（settings.json の github） */
  'settings:github': (prefs: GithubPreferences) => void

  // GitHub の star のお願い（src/main/starPrompt.ts）。star するのは利用者が押したときだけ
  /** トーストの「Star」。gh で star できたら true（できなければ画面はブラウザの案内に切り替える） */
  'star:star': () => boolean
  /** リポジトリをブラウザで開く */
  'star:openWeb': () => void
  'star:later': () => void
  /** 「今後表示しない」 */
  'star:never': () => void
  /** 設定・ヘルプのいつでも押せる入口。gh で star、できなければブラウザで開く */
  'star:fromMenu': () => StarActionResult

  // フィードバック → GitHub の Issue（src/main/feedback.ts）。サーバーは使わない
  /** 環境情報（版・OS・CPU・言語）。パス・利用者名・プロジェクト名・URL・キーは伏せてある */
  'feedback:environment': () => FeedbackEnvironment
  /** gh でログイン中のアカウント名。未ログイン・gh 無しは null（ブラウザで開く案内にする） */
  'feedback:account': () => string | null
  /** 確認画面で見せた題名と本文のまま送る。gh で作るか、ブラウザで「新しい Issue」を開く */
  'feedback:submit': (input: FeedbackSubmitInput) => FeedbackSubmitResult
  /** Ferret の今の画面の静止画（PNG、2MB 以下に縮める）。フィードバックに添付する */
  'feedback:captureWindow': () => { type: 'image/png' | 'image/jpeg'; base64: string; width: number; height: number }
}

export interface IpcEvents {
  'browser:stateChanged': (state: BrowserState) => void
  /** 内蔵ブラウザから利用者へ短く知らせる（タブの上限など） */
  'browser:notice': (message: string) => void
  /** 拡張機能の一覧・読み込みの結果が変わった */
  'browserExtensions:changed': (list: BrowserExtensionInfo[]) => void
  /** 取り込んだパスワードが変わった（鍵のボタンを出し直す） */
  'passwords:changed': () => void
  'mode:changed': (mode: AppMode) => void
  'terminal:data': (id: string, data: string) => void
  'terminal:exit': (id: string, exitCode: number) => void
  /** 終了の前に、今のタブと画面の文字を terminal:restoreSave で送ってほしい */
  'terminal:restoreCollect': () => void
  'menu:command': (command: MenuCommand) => void
  'workspace:changed': (state: WorkspaceState) => void
  'projects:changed': (state: ProjectsState) => void
  'project:cloneProgress': (progress: CloneProgress) => void
  /** エージェントの設定が変わった（settings:agents の保存後） */
  'agents:changed': (options: AgentOption[]) => void
  'recording:status': (status: RecordingStatus) => void
  /** 録っている映像（トラック）・映しているもの・待ち受けが変わった */
  'recording:tracksChanged': (state: import('./captureTracks').CaptureTracksState) => void
  /** 録画の対象を main が変えた（ウインドウを映している間に URL を開いたので内蔵ブラウザへ戻した） */
  'capture:targetChanged': (target: CaptureTarget) => void
  'recording:level': (level: AudioLevel) => void
  /** 録画は続いているが、何かが取れなかった（マイク無しなど）ことを知らせる */
  'recording:warning': (message: string) => void
  /** 録画中の文字起こしの状態（右パネルの「文字起こし」タブと、止まったときの警告。@shared/liveTranscript） */
  'transcript:status': (status: import('./liveTranscript').LiveTranscriptStatus) => void
  /** 録画中に文字起こしできた発話（区切り1つ分） */
  'transcript:segments': (batch: import('./liveTranscript').LiveTranscriptBatch) => void
  /** 書き込みの「元に戻す／やり直す」ができるかが変わった */
  'annotation:history': (history: AnnotationHistory) => void
  /** ページに焦点があるときに押された、書き込みの道具の切り替えキー（ツールバーで処理する） */
  'annotation:shortcut': (action: AnnotationShortcut) => void
  'capture:modelProgress': (progress: WhisperModelProgress) => void
  /** API の呼び出しを記録したあとの集計（フッターの使用量を更新する） */
  'usage:apiCallsChanged': (summary: ApiUsageSummary) => void
  'review:ready': (review: ReviewData) => void
  'meeting:progress': (progress: MeetingImportProgress) => void
  /** 文字で指摘を足した（足した後のレビューと、その中の打った指摘の数）。画面はブラウザのまま */
  'note:added': (result: { review: ReviewData; count: number }) => void
  /** 文字で指摘の入・切を main が変えた（ページの Esc・録画の開始・プロジェクトの切り替え） */
  'note:mode': (active: boolean) => void
  /** 文字で指摘を足せなかった理由 */
  'note:error': (message: string) => void
  /** 開いているプロジェクトのレビューの progress.json（指摘の進み具合）が変わった。Agent の書き込みを画面へ反映する */
  'review:progressChanged': (ids: string[]) => void
  /** 使用量が変わった（取得中・成功・失敗） */
  'usage:changed': (state: UsageState) => void
  /** 上限での自動切り替え: このタブを開いて（開いたら main が引き継ぐ） */
  'failover:launch': (request: FailoverLaunchRequest) => void
  /** Agent どうしの依頼: 宛先の Agent が居ないので、送り手の隣にこの Agent を開いて（開いたら main が依頼を貼る） */
  'agentMail:launch': (request: import('./agentMail').AgentMailLaunchRequest) => void
  /** 上限での自動切り替え: 切り替えた・できなかった（フッターとトースト） */
  'failover:notice': (notice: FailoverNotice) => void
  /** Agent の通知が押された: そのプロジェクトへ切り替え、そのタブを開く */
  'agentNotify:open': (target: AgentNotifyOpen) => void
  /** プロジェクトの中のファイルが外部（Agent など）で変わった */
  'fs:changed': (event: FsChangedEvent) => void
  /** 発信の下書きが増えた・変わった（バックグラウンドの生成など） */
  'publish:changed': () => void
  /** 解決済みの配色が変わった（設定の変更、または system のときの OS の切り替え） */
  'theme:changed': (theme: ResolvedTheme) => void
  /** 解決済みの画面の言語が変わった */
  'locale:changed': (locale: SupportedLocale) => void
  /** 開いているプロジェクトの .git/HEAD・index が変わった（ブランチの切り替え・コミット） */
  'github:headChanged': () => void
  /** star のお願いを出す（良い場面で、条件を満たしたときだけ） */
  'star:show': (mode: StarPromptMode) => void
  /** 使い始めてしばらくしたら一度だけ「使いづらいところはありましたか？」と聞く */
  'feedback:ask': () => void
  /** settings.json が外部（利用者のエディタ・Claude Code など）で書き換えられ、取り込んだ。平文のキーは外してある */
  'settings:changed': (settings: Settings) => void
  /** settings.json が壊れた（JSON・スキーマの誤り）。null は直った。壊れている間は取り込まず、ファイルも上書きしない */
  'settingsFile:error': (error: SettingsFileError | null) => void
  /** 裏での更新の状態が変わった（確認・ダウンロードの進み具合・準備ができた・失敗） */
  'update:status': (status: AutoUpdateStatus) => void
  /** スマホから操作の状態が変わった（開いた・閉じた・開けなかった・合言葉を作り直した。settings.json の変更も） */
  'remote:changed': (state: import('./mobileRemote').MobileRemoteState) => void
  /** 終了の確認で「保存して終了」: 未保存のファイルの中身を editor:quitSave で返して */
  'editor:saveForQuit': (requestId: string) => void
  /** 終了の確認で「プロジェクトを開く」: main がプロジェクトとエディタへ切り替えたので、このファイルのタブを開いて（error なら知らせるだけ） */
  'editor:revealUnsaved': (target: UnsavedReveal) => void
}

export type IpcRequestChannel = keyof IpcRequests
export type IpcEventChannel = keyof IpcEvents

export type IpcResult<C extends IpcRequestChannel> = Awaited<ReturnType<IpcRequests[C]>>
export type IpcArgs<C extends IpcRequestChannel> = Parameters<IpcRequests[C]>

/** preload が contextBridge で公開する API の形。renderer 側はこれだけを見る */
export interface AdeApi {
  invoke<C extends IpcRequestChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>
  on<C extends IpcEventChannel>(channel: C, listener: IpcEvents[C]): () => void
  platform: PlatformName
  /** OS の版（process.getSystemVersion()。Windows は 10.0.22631 の形で、ターミナルが ConPTY のビルド番号に使う） */
  systemVersion?: string
  /**
   * 見本データを出してよいか（E2Eの撮影用）。
   * 通常起動では false で、実データが無ければ空状態を出す。
   * 架空のレビューや指摘が製品の画面に出ないようにするための切り分け。
   */
  demo: boolean
  /** 起動時点の解決済みの配色。最初の描画の前に data-theme を決めるために使う */
  initialTheme: ResolvedTheme
  /** 起動時点の解決済みの画面の言語。最初の描画の文言を決めるために使う */
  initialLocale: SupportedLocale
  /**
   * 外から落とした File の実パスを webUtils.getPathForFile で取り、main で確かめた結果を返す。
   * 存在しないもの・ファイルでもフォルダでもないものは入らない（src/shared/externalDrop.ts）
   */
  inspectDrop(files: readonly File[]): Promise<DroppedEntry[]>
}

/** contextBridge で公開するキー名 */
export const ADE_API_KEY = 'ade' as const

export const IPC_REQUEST_CHANNELS = [
  'app:ready',
  'app:settings',
  'settingsFile:info', 'settingsFile:read', 'settingsFile:write', 'settingsFile:reveal', 'settings:feedbackTargets',
  'app:version',
  'app:checkUpdate',
  'app:openUpdate', 'app:openExternal', 'agent:sendText',
  'update:status', 'update:download', 'update:install', 'update:setAutoDownload', 'update:versions', 'update:chooseVersion',
  'resources:snapshot',
  'resources:kill',
  'resources:cleanup',
  'workspace:open',
  'workspace:current',
  'project:list',
  'project:add',
  'project:switch',
  'project:update',
  'project:orchestrator',
  'project:remove',
  'project:saveSession',
  'project:sshHosts',
  'project:githubRepos',
  'project:gitlabRepos',
  'project:cloneDefaults',
  'project:pickParent',
  'project:clone',
  'project:cloneCancel',
  'project:addSsh',
  'project:addDropped',
  'project:reorder',
  'project:move',
  'orchestra:create',
  'settings:agents',
  'agents:list',
  'cliTools:list',
  'agents:resources',
  'settings:agentPrompt',
  'settings:agentRequests',
  'agentRequests:send',
  'review:pendingAcross',
  'orchestra:overview',
  'orchestra:checklist',
  'orchestra:answer',
  'orchestra:sendAnswers',
  'orchestra:feedbackFile',
  'settings:orchestra',
  'settings:orchestraAllowed',
  'accounts:list',
  'accounts:add',
  'accounts:rename',
  'accounts:remove',
  'accounts:select',
  'accounts:relogin',
  'usage:get',
  'usage:refresh',
  'usage:accounts',
  'failover:get', 'failover:set', 'agentNotify:show',
  'mode:set',
  'browser:setBounds',
  'browser:navigate',
  'browser:newTab',
  'browser:closeTab',
  'browser:tabMenu',
  'browser:activateTab',
  'browser:back',
  'browser:forward',
  'browser:reload',
  'browser:openExternal',
  'browser:setViewport',
  'browser:state',
  'browserExtensions:list', 'browserExtensions:addFolder', 'browserExtensions:scanInstalled', 'browserExtensions:import', 'browserExtensions:setEnabled', 'browserExtensions:remove', 'browserExtensions:menu', 'browserExtensions:open', 'browserExtensions:installFromStore', 'browserExtensions:addCrx',
  'browserImport:status', 'browserImport:importPasswords', 'browserImport:findExports', 'browserImport:trashExport', 'browserImport:clearPasswords', 'browserImport:historySources', 'browserImport:importHistory', 'browserImport:clearHistory', 'browserImport:suggest', 'passwords:forPage', 'passwords:fill', 'passwords:menu',
  'publish:list', 'publish:generate', 'publish:create', 'publish:update', 'publish:remove', 'publish:pickMedia', 'publish:addProjectMedia', 'publish:setBackground',
  'publish:connections', 'publish:setXClientId', 'publish:connectX', 'publish:cancelConnectX', 'publish:disconnectX', 'publish:addBlog', 'publish:removeBlog', 'publish:postX', 'publish:postBlog',
  'share:list', 'share:forPage', 'share:create', 'share:settings', 'share:update', 'share:copyPassword', 'share:open', 'share:setStatus', 'share:import', 'share:delete',
  'terminal:create',
  'terminal:write',
  'terminal:resize',
  'terminal:close',
  'terminal:screen', 'terminal:agentState', 'terminal:agentStates', 'terminal:visible', 'terminal:continueWork', 'terminal:cwd', 'terminal:list', 'terminal:attach', 'terminal:paste', 'terminal:pasteFiles', 'terminal:writeClipboard', 'terminal:programCopy', 'terminal:ack', 'terminal:focused', 'terminal:restoreSave', 'terminal:restoreTake', 'terminal:closedPush', 'terminal:closedPop', 'terminal:restoreClear', 'review:send',
  'settings:splitRatio',
  'settings:layout',
  'settings:theme',
  'settings:locale',
  'settings:crashReports', 'telemetry:state', 'telemetry:noticeShown',
  'remote:state', 'remote:set', 'remote:resetToken',
  'settings:onboarding', 'agentSkill:status', 'agentSkill:install', 'permissions:status', 'permissions:request',
  'recording:start',
  'recording:pause',
  'recording:resume',
  'recording:stop',
  'recording:status',
  'recording:addTrack', 'recording:switchTrack', 'recording:tracks',
  'annotation:setMode',
  'annotation:setColor',
  'annotation:clear',
  'note:setMode',
  'annotation:undo',
  'annotation:redo',
  'review:list', 'review:activity', 'review:label', 'review:delete', 'review:load', 'review:edit', 'review:progress', 'review:verdict', 'review:ngPrompt', 'review:resent', 'review:copy', 'review:folder', 'review:frames', 'review:organize', 'review:restore', 'meeting:pickMedia', 'meeting:pickTranscript', 'meeting:import', 'meeting:score', 'capture:model', 'capture:apiKey', 'capture:devices', 'settings:capture', 'capture:availability', 'capture:testConnection', 'settings:stt', 'settings:organizer', 'organize:testConnection', 'settings:decision', 'decision:testConnection', 'usage:apiCalls', 'usage:openApiLog', 'capture:whisperModels', 'capture:downloadModel', 'capture:cancelModelDownload',
  'capture:screenAccess', 'capture:sources', 'capture:setTarget', 'capture:openScreenSettings', 'capture:apps', 'capture:launchApp',
  'fs:list', 'fs:read', 'fs:write', 'fs:files', 'fs:search', 'fs:inspect', 'fs:readOffice', 'fs:gitStatus', 'fs:create', 'fs:copy', 'fs:move', 'fs:import', 'fs:pasteClipboard', 'fs:importMedia', 'fs:copyPath', 'fs:terminalDir', 'fs:rename', 'fs:trash', 'fs:reveal', 'fs:openExternal', 'editor:unsaved', 'editor:quitSave', 'preview:render',
  'github:open', 'github:repoStatus', 'github:autoFetch', 'github:gitAction', 'github:autoFetchConsent',
  'github:repoCreateInfo', 'github:createPrivateRepo', 'settings:github',
  'star:star', 'star:openWeb', 'star:later', 'star:never', 'star:fromMenu',
  'feedback:environment', 'feedback:account', 'feedback:submit', 'feedback:captureWindow'
] as const satisfies readonly IpcRequestChannel[]

export const IPC_EVENT_CHANNELS = [
  'browser:stateChanged',
  'browser:notice',
  'browserExtensions:changed',
  'passwords:changed',
  'mode:changed',
  'terminal:data',
  'terminal:exit',
  'terminal:restoreCollect',
  'menu:command',
  'workspace:changed',
  'projects:changed',
  'project:cloneProgress',
  'agents:changed',
  'recording:status',
  'recording:tracksChanged',
  'recording:level',
  'recording:warning', 'transcript:status', 'transcript:segments', 'capture:targetChanged', 'annotation:history', 'annotation:shortcut', 'capture:modelProgress', 'usage:apiCallsChanged', 'review:ready', 'review:progressChanged', 'meeting:progress',
  'note:added', 'note:mode', 'note:error',
  'fs:changed',
  'publish:changed',
  'theme:changed',
  'locale:changed',
  'usage:changed',
  'failover:launch', 'failover:notice', 'agentMail:launch', 'agentNotify:open',
  'github:headChanged',
  'star:show',
  'feedback:ask',
  'settings:changed', 'settingsFile:error',
  'update:status',
  'remote:changed',
  'editor:saveForQuit', 'editor:revealUnsaved'
] as const satisfies readonly IpcEventChannel[]
