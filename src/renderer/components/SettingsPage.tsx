import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isValidOwner } from '@shared/repoCreate'
import { Lock, Plus, Search, Star } from 'lucide-react'
import { DEFAULT_AGENT_PREFERENCES, TUI_AGENT_LABEL, type AgentLaunchConfig, type AgentOption, type AgentPreferences, type BuiltinAgent, type CustomAgent, type CustomAgentId, type SttAvailability, type SttProvider, type TuiAgent } from '@shared/types'
import { AGENT_CATALOG, BUILTIN_AGENTS, agentLabel, firstCommandWord, isBuiltinAgent } from '@shared/agentCatalog'
import { listAgents } from '../lib/agentListing'
import { addCustomAgent, isDefaultLaunch, removeCustomAgent, resetLaunchConfig, setAgentEnabled, setLaunchConfig, startableAgents, toggleStartupAgent, updateCustomAgent } from '../lib/agentPrefs'
import { defaultAgentPrompt, renderAgentPrompt } from '@shared/agentPrompt'
import { type TranslationKey } from '@shared/i18n'
import { Button, Field, LocaleSelect, ThemeSegmented, useToast } from '../ui'
import { starFromMenu } from './StarPrompt'
import { useLocale, useT } from '../lib/i18n'
import { AccountsSection } from './AccountsSection'
import { OrchestraSection } from './OrchestraSection'
import { RemoteSection } from './RemoteSection'
import { AgentIcon } from './AgentIcon'
import { AgentResourcesSection } from './AgentResourcesSection'
import { CliToolsSection } from './CliToolsSection'
import { BrowserExtensionsSection } from './BrowserExtensionsSection'
import { BrowserImportSection } from './BrowserImportSection'
import { BrowserProfilesSection } from './BrowserProfilesSection'
import { LayoutSettings } from './LayoutSettings'
import { TranscriptionSection } from './TranscriptionSection'
import { OrganizeSection } from './OrganizeSection'
import { DecisionSection } from './DecisionSection'
import { CrashReportsSetting } from './CrashReportsSetting'
import { SettingsFileCard } from './SettingsFileCard'
import { useSettingsRevision } from '../lib/settingsFile'
import { PRODUCT_NAME } from '@shared/i18n'
import { SETTINGS_SECTIONS, activeSectionAt, filterSettingsSections, type SettingsSectionId } from '../lib/settingsSections'
import { requestShowOnboarding } from '../onboarding/showOnboardingEvent'
import { SetupChecklist } from '../onboarding/SetupChecklist'
import { AgentInstallDisclosure } from '../onboarding/AgentInstallTerminal'
import { agentInstallCommand } from '../onboarding/agentInstall'
import '../styles/settings.css'
import type { SttLanguageCode } from '@shared/sttLanguages'

export type Transcription = SttProvider
/** 文字起こしの言語（auto か whisper の対応言語のコード。src/shared/sttLanguages.ts） */
export type SpeechLanguage = SttLanguageCode

export interface CaptureSettings {
  captureMic: boolean
  micDeviceId: string
  captureSystemAudio: boolean
  language: SpeechLanguage
  transcription: Transcription
  keepDays: number
  stayFeedbackOnStop: boolean
  /** 録画中の文字起こしを右パネルのタブに出す（省略時は出す） */
  showLiveTranscript?: boolean
}

function PageSection({ id, title, bare, children }: { id: SettingsSectionId; title: string; bare?: boolean; children: ReactNode }) {
  return <section className="st-page__section" id={`settings-page-${id}`} data-section={id} aria-label={title}>
    {!bare && <h2 className="st-page__heading">{title}</h2>}
    <div className={bare ? undefined : 'st-page__body'}>{children}</div>
  </section>
}

function Switch({ label, hint, checked, disabled, onChange }: { label: string; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return <label className="st-row st-row--switch" data-disabled={disabled || undefined}>
    <span className="st-row__label">{label}{hint}</span>
    <input type="checkbox" role="switch" className="st-switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
  </label>
}

/**
 * プロジェクトの右クリックの「GitHub で private リポジトリを作る」の既定の置き場（settings.json の github.defaultOwner）。
 * 空なら自分のアカウント。名前の形は main（@shared/repoCreate）が確かめ、違えば捨てる
 */
function GithubRepoDefaults() {
  const t = useT()
  const [owner, setOwner] = useState('')
  useEffect(() => {
    void window.ade.invoke('app:settings').then((s) => setOwner(s.github?.defaultOwner ?? '')).catch(() => undefined) // 読めなければ空のまま
  }, [])
  const valid = owner === '' || isValidOwner(owner)
  const save = (next: string) => {
    if (next !== '' && !isValidOwner(next)) return
    void window.ade.invoke('settings:github', next ? { defaultOwner: next } : {}).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
  }
  return <div className="st-page__group" data-testid="settings-github-owner">
    <SelectRow label={t('repoCreate.settings.owner')}>
      <Field mono value={owner} placeholder={t('repoCreate.settings.ownerPlaceholder')} spellCheck={false} autoComplete="off" maxLength={39}
        aria-label={t('repoCreate.settings.owner')} onChange={(e) => setOwner(e.target.value.trim())} onBlur={() => save(owner)} />
    </SelectRow>
    {!valid && <p className="st-note st-note--warn">{t('repoCreate.errors.owner')}</p>}
    <p className="st-note">{t('repoCreate.settings.ownerNote')}</p>
  </div>
}

function SelectRow({ label, children }: { label: string; children: ReactNode }) {
  return <label className="st-row"><span className="st-row__label">{label}</span><span className="rv-select">{children}</span></label>
}

/** プレビューに使う例（実際は開いているプロジェクトと録画ごとの日時） */
const PREVIEW_TARGET = { relativeDir: '.ferret/reviews/20261003-101500', feedbackMd: '/Users/you/project/.ferret/reviews/20261003-101500/feedback.md' }

/**
 * エージェントの節。Orca の Agents 設定ページにならう。
 *   - 組み込みのエージェント: 有効のスイッチ（disabledAgents）・インストール済みの印・コマンドと引数
 *   - カスタムエージェント: 追加・削除・名前・コマンド・引数・プロセス名
 *   - プロジェクトを開いたら起動するもの（startupAgents）: 有効なものから選んだ順
 *   - 「Agentへ送信」の指示文
 * 既定の引数は空。権限確認を省く引数はプロジェクトごとに許したときだけ main が付ける（security-3 [1]、src/shared/agentCatalog.ts）。
 * インストール済みかは main の検出（agents:list / agents:changed）で知る。
 */
function AgentSection({ value, onChange, prompt, onPromptChange }: {
  value: AgentPreferences
  onChange: (next: AgentPreferences) => void
  /** 「Agentへ送信」「Agent向けにコピー」の指示。空なら既定文 */
  prompt: string
  onPromptChange: (next: string) => void
}) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const [options, setOptions] = useState<AgentOption[]>([])
  useEffect(() => {
    void window.ade.invoke('agents:list').then(setOptions).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    return window.ade.on('agents:changed', setOptions)
  }, [])
  const installed = (id: TuiAgent) => options.find((o) => o.id === id)?.installed
  const enabled = (id: TuiAgent) => !value.disabledAgents.includes(id)
  const label = (id: TuiAgent) => agentLabel(id, value) || t('settings.agents.customUnnamed')

  // 変更の中身は lib/agentPrefs.ts の純粋な関数（単体テスト済み）。ここは画面とのつなぎだけ
  const setEnabled = (id: TuiAgent, on: boolean) => onChange(setAgentEnabled(value, id, on))
  const toggleStartup = (id: TuiAgent, on: boolean) => onChange(toggleStartupAgent(value, id, on))
  const setLaunch = (agent: BuiltinAgent, patch: Partial<AgentLaunchConfig>) => onChange(setLaunchConfig(value, agent, patch))
  const setCustom = (id: CustomAgentId, patch: Partial<Omit<CustomAgent, 'id'>>) => onChange(updateCustomAgent(value, id, patch))
  const addCustom = () => onChange(addCustomAgent(value).prefs)
  const removeCustom = (id: CustomAgentId) => onChange(removeCustomAgent(value, id))
  // 40種以上あるので、起動の候補も一覧も「見つかったもの・主要なもの・選んでいるもの・カスタム」を先に見せ、
  // 残りは「すべて表示」にたたむ。検索欄は全部から探す（lib/agentListing.ts）
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const startableIds = startableAgents(value)
  const startable = options.length > 0
    ? listAgents(options.filter((o) => startableIds.includes(o.id)), { selected: value.startupAgents }).visible.map((o) => o.id)
    : startableIds.filter((id) => value.startupAgents.includes(id) || (isBuiltinAgent(id) && AGENT_CATALOG[id].popular))
  const builtinOptions: AgentOption[] = BUILTIN_AGENTS.map((agent) => options.find((o) => o.id === agent) ?? {
    id: agent, label: TUI_AGENT_LABEL[agent], custom: false, installed: false, enabled: enabled(agent),
    command: value.launch[agent].command, args: value.launch[agent].args, defaultCommand: null, defaultArgs: null, homepageUrl: null
  })
  const listing = listAgents(builtinOptions, { query, showAll, selected: value.startupAgents })
  const shownBuiltins = listing.visible.map((o) => o.id).filter(isBuiltinAgent)

  return <div id="settings-agent" className="st-page__group">
    <p className="st-note">{t('settings.agents.intro')}</p>

    {/* 権限確認を省いて起動する（既定は入）。付ける引数は main の resolveAgentLaunchPolicy が決める */}
    <div data-testid="agent-skip-permissions">
      <Switch label={t('settings.agents.skipPermissions')} checked={value.skipPermissions} onChange={(skipPermissions) => onChange({ ...value, skipPermissions })} />
      <p className="st-note">{t('settings.agents.skipPermissionsNote', { claude: AGENT_CATALOG.claude.yoloArgs, codex: AGENT_CATALOG.codex.yoloArgs })}</p>
    </div>

    {/* Agent どうしの依頼（既定は入）。配送と skill は main の agentMail.ts */}
    <div data-testid="agent-mail">
      <Switch label={t('settings.agents.agentMail')} checked={value.agentMail} onChange={(agentMail) => onChange({ ...value, agentMail })} />
      <p className="st-note">{t('settings.agents.agentMailNote')}</p>
    </div>

    {/* Agent が終わった・確認を待っているときの OS 通知（既定は切）。出すかは renderer の terminal/agentAttention.ts */}
    <div data-testid="agent-notify">
      <Switch label={t('settings.agents.notify')} checked={value.notify} onChange={(notify) => onChange({ ...value, notify })} />
      <p className="st-note">{t('settings.agents.notifyNote')}</p>
    </div>

    {/* Windows のターミナルのシェル（既定は PowerShell。cmd.exe は履歴を残さない。main の resolveWindowsShell） */}
    {window.ade.platform === 'win32' && <div data-testid="agent-windows-shell">
      <SelectRow label={t('settings.agents.windowsShell')}>
        <select className="st-select" aria-label={t('settings.agents.windowsShell')} value={value.windowsShell} onChange={(e) => onChange({ ...value, windowsShell: e.target.value === 'cmd' ? 'cmd' : 'powershell' })}>
          <option value="powershell">PowerShell</option>
          <option value="cmd">cmd.exe</option>
        </select>
      </SelectRow>
      <p className="st-note">{t('settings.agents.windowsShellNote')}</p>
    </div>}

    {/* ターミナルのタブと画面の文字を覚えて、再起動・閉じたあとに戻す（既定は入。切にすると main が書いたものも消す） */}
    <div data-testid="agent-restore-terminals">
      <Switch label={t('settings.agents.restoreTerminals')} checked={value.restoreTerminals} onChange={(restoreTerminals) => onChange({ ...value, restoreTerminals })} />
      <p className="st-note">{t('settings.agents.restoreTerminalsNote')}</p>
      <Button variant="ghost" data-testid="agent-restore-terminals-clear" onClick={() => {
        void window.ade.invoke('terminal:restoreClear')
          .then(() => toast({ tone: 'success', message: t('settings.agents.clearTerminalHistoryDone') }))
          .catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
      }}>{t('settings.agents.clearTerminalHistory')}</Button>
    </div>

    <h3 className="st-page__subheading">{t('settings.agents.startupTitle')}</h3>
    <div className="st-agent-startup" role="group" aria-label={t('settings.agents.startupTitle')}>
      {startable.map((id) => {
        const order = value.startupAgents.indexOf(id)
        return <label key={id} className="st-agent-pick" data-checked={order >= 0 || undefined}>
          <input type="checkbox" checked={order >= 0} onChange={(e) => toggleStartup(id, e.target.checked)} data-testid={`agent-startup-${id}`} />
          <AgentIcon agent={id} label={label(id)} size={13} />
          <span>{label(id)}</span>
          {order >= 0 && <span className="st-agent-pick__order" aria-hidden="true">{order + 1}</span>}
        </label>
      })}
    </div>
    <p className="st-note">{t(value.startupAgents.length === 0 ? 'settings.agents.noneSelected' : 'settings.agents.startupHint')}</p>

    <h3 className="st-page__subheading">{t('settings.agents.customTitle')}</h3>
    <p className="st-note">{t('settings.agents.customHint')}</p>
    {value.customAgents.map((custom) => <div key={custom.id} className="st-agent-row" data-testid="agent-custom" data-disabled={!enabled(custom.id) || undefined}>
      <div className="st-agent-row__head">
        <AgentIcon agent={custom.id} label={custom.icon || label(custom.id)} size={14} />
        <Field className="st-agent-row__namefield" aria-label={t('settings.agents.customName')} placeholder={t('settings.agents.customName')}
          value={custom.name} onChange={(e) => setCustom(custom.id, { name: e.target.value })} data-testid="agent-custom-name" />
        <Field className="st-agent-row__iconfield" aria-label={t('settings.agents.customIcon')} placeholder={(custom.name.trim()[0] ?? 'A').toUpperCase()}
          value={custom.icon ?? ''} maxLength={2} onChange={(e) => setCustom(custom.id, { icon: e.target.value || undefined })} data-testid="agent-custom-icon" />
        {installed(custom.id) === false && custom.command.trim() && <span className="st-agent-row__state is-missing">{t('settings.agents.notFound')}</span>}
        <input type="checkbox" role="switch" className="st-switch" aria-label={t('settings.agents.enabled', { agent: label(custom.id) })}
          checked={enabled(custom.id)} onChange={(e) => setEnabled(custom.id, e.target.checked)} />
      </div>
      <div className="st-agent__fields">
        <Field mono aria-label={t('settings.agents.command', { agent: label(custom.id) })} placeholder="my-agent"
          value={custom.command} onChange={(e) => setCustom(custom.id, { command: e.target.value })} data-testid="agent-custom-command" />
        <Field mono aria-label={t('settings.agents.args', { agent: label(custom.id) })} placeholder={t('settings.agents.noArgs')}
          value={custom.args} onChange={(e) => setCustom(custom.id, { args: e.target.value })} />
      </div>
      {/* 書きかけの行は消さずに残し、使えるようになる条件を行の中で示す（メニューにはコマンドのあるものだけが出る） */}
      {(!custom.name.trim() || !custom.command.trim()) && <p className="st-note st-note--warn" data-testid="agent-custom-incomplete">{t('settings.agents.customIncomplete')}</p>}
      <details className="st-agent-row__details">
        <summary>{t('settings.agents.customProcess')}</summary>
        <Field mono aria-label={t('settings.agents.customProcess')} placeholder={firstCommandWord(custom.command) || 'my-agent'}
          value={custom.processName ?? ''} onChange={(e) => setCustom(custom.id, { processName: e.target.value || undefined })} />
        <p className="st-note">{t('settings.agents.customProcessHint')}</p>
      </details>
      <div className="st-agent__reset">
        <Button variant="ghost" onClick={() => removeCustom(custom.id)} data-testid="agent-custom-remove">{t('common.delete')}</Button>
      </div>
    </div>)}
    <div>
      <Button icon={<Plus size={14} strokeWidth={1.5} />} onClick={addCustom} data-testid="agent-custom-add">{t('settings.agents.customAdd')}</Button>
    </div>

    <h3 className="st-page__subheading">{t('settings.agents.builtinTitle')}</h3>
    <Field type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agents.searchPlaceholder')}
      aria-label={t('agents.searchPlaceholder')} data-testid="agent-search" />
    {query.trim() && shownBuiltins.length === 0 && <p className="st-note">{t('agents.noMatch')}</p>}
    {shownBuiltins.map((agent) => {
      const launch = value.launch[agent]
      const defaults = DEFAULT_AGENT_PREFERENCES.launch[agent]
      const found = installed(agent)
      return <div key={agent} className="st-agent-row" data-testid={`agent-launch-${agent}`} data-disabled={!enabled(agent) || undefined}>
        <div className="st-agent-row__head">
          <AgentIcon agent={agent} label={TUI_AGENT_LABEL[agent]} size={14} />
          <span className="st-agent-row__name">{TUI_AGENT_LABEL[agent]}</span>
          {found === true && <span className="st-agent-row__state">{t('settings.agents.installed')}</span>}
          {/* 入れ方のページへは飛ばさない。下のたためる欄で、公式のコマンドを行の中のターミナルで走らせる */}
          {found === false && <span className="st-agent-row__state is-missing">{t('settings.agents.notFound')}</span>}
          <input type="checkbox" role="switch" className="st-switch" aria-label={t('settings.agents.enabled', { agent: TUI_AGENT_LABEL[agent] })}
            checked={enabled(agent)} onChange={(e) => setEnabled(agent, e.target.checked)} data-testid={`agent-enabled-${agent}`} />
        </div>
        {/* 見つからないものは、押したときだけ行の中のターミナルでインストールできる（セットアップと同じ部品） */}
        {found === false && <AgentInstallDisclosure agentId={agent} label={TUI_AGENT_LABEL[agent]} command={agentInstallCommand(agent)}
          guideUrl={AGENT_CATALOG[agent].homepageUrl}
          onRefresh={() => window.ade.invoke('agents:list', true).then((next) => { setOptions(next); return next.some((o) => o.id === agent && o.installed) })} />}
        <details className="st-agent-row__details">
          <summary>{t('settings.agents.commandSummary')}<code title={[launch.command, launch.args].filter(Boolean).join(' ')}>{[launch.command, launch.args].filter(Boolean).join(' ')}</code></summary>
          <div className="st-agent__fields">
            <Field mono aria-label={t('settings.agents.command', { agent: TUI_AGENT_LABEL[agent] })} placeholder={defaults.command}
              value={launch.command} onChange={(e) => setLaunch(agent, { command: e.target.value })} />
            <Field mono aria-label={t('settings.agents.args', { agent: TUI_AGENT_LABEL[agent] })} placeholder={t('settings.agents.noArgs')}
              value={launch.args} onChange={(e) => setLaunch(agent, { args: e.target.value })} />
          </div>
          <div className="st-agent__reset">
            <Button variant="ghost" disabled={isDefaultLaunch(value, agent)} onClick={() => onChange(resetLaunchConfig(value, agent))}>{t('settings.agents.resetOne')}</Button>
          </div>
        </details>
      </div>
    })}
    {!query.trim() && (listing.hiddenCount > 0 || showAll) && <div>
      <Button variant="ghost" onClick={() => setShowAll((v) => !v)} data-testid="agent-show-all">
        {showAll ? t('agents.showLess') : t('agents.showAll', { count: listing.hiddenCount })}</Button>
    </div>}

    <label className="st-prompt">
      <span className="st-row__label">{t('settings.agents.prompt')}</span>
      <textarea className="st-textarea st-textarea--prompt" rows={8} aria-label={t('settings.agents.prompt')} placeholder={defaultAgentPrompt(locale)} spellCheck={false}
        value={prompt} onChange={(e) => onPromptChange(e.target.value)} data-testid="agent-prompt" />
    </label>
    <p className="st-note">{(() => {
      // {{path}} / {{relpath}} は <code> で見せる。語順は言語ごとに違うので、辞書の位置で分けて差し込む
      const parts = t('settings.agents.promptHelp', { pathVar: '\0path\0', relpathVar: '\0relpath\0' }).split('\0')
      return parts.map((part, i) => i % 2 === 1 ? <code key={i}>{`{{${part}}}`}</code> : part)
    })()}</p>
    <div className="st-prompt__preview" data-testid="agent-prompt-preview">{renderAgentPrompt(PREVIEW_TARGET, prompt, locale)}</div>
    <div className="st-agent__reset">
      <Button variant="ghost" disabled={!prompt.trim()} onClick={() => onPromptChange('')}>{t('settings.agents.resetPrompt')}</Button>
    </div>
    {/* 有効でインストール済みの CLI ごとのスキル・コマンド・MCP（読むだけ） */}
    <AgentResourcesSection agents={options.filter((o) => o.installed && enabled(o.id)).map((o) => ({ id: o.id, label: label(o.id) }))} />
  </div>
}

/** 画面の言語（system / English / 日本語 …）。文字起こしの言語とは別の軸 */
function LanguageSection() {
  const t = useT()
  return <div id="settings-language" className="st-page__group">
    <div className="st-row"><span className="st-row__label">{t('settings.language.label')}</span>
      <LocaleSelect ariaLabel={t('settings.language.label')} /></div>
    <p className="st-note">{t('settings.language.note')}</p>
  </div>
}


/** 「この Ferret について」。名前と版だけ（更新の確認はフッターの版表示が持つ） */
function AboutSection() {
  const t = useT()
  const [version, setVersion] = useState<{ version: string; packaged: boolean } | null>(null)
  const toast = useToast()
  useEffect(() => { void window.ade.invoke('app:version').then(setVersion).catch(() => undefined) }, []) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
  return <div className="st-page__group">
    <div className="st-row"><span className="st-row__label">{PRODUCT_NAME}</span>
      <span className="st-about__version" data-testid="settings-version">{version ? `${t('settings.about.version')} ${version.version}${version.packaged ? '' : ` (${t('settings.about.devBuild')})`}` : ''}</span></div>
    {/* 初回起動のセットアップを開き直す（ヘルプ → セットアップをもう一度 と同じ） */}
    <div className="st-row"><span className="st-row__label">{t('settings.setup.label')}</span>
      <Button onClick={requestShowOnboarding} data-testid="settings-run-setup">{t('settings.setup.run')}</Button></div>
    {/* いつでも押せる star の入口（ヘルプ → GitHub で star と同じ）。押したときだけ star する */}
    <div className="st-row"><span className="st-row__label">GitHub</span>
      <Button icon={<Star size={13} />} onClick={() => void starFromMenu(t, toast)} data-testid="settings-star">{t('settings.about.star')}</Button></div>
  </div>
}

/**
 * 設定のページ（VS Code / Orca の設定ページにならう）。中央のタブの1つとして開く。
 * 左に節の一覧、右に全節を縦に並べ、上の検索欄で節を絞り込む。
 * モーダルだった頃と違い「閉じたときに保存」は無く、変えたらその場で保存する（呼び出し側の onChange が保存まで行う）。
 */
export function SettingsPage({
  value,
  onChange,
  recording,
  micDevices,
  available,
  onAvailabilityChange,
  onPickModel,
  onModelChanged,
  agents,
  onAgentsChange,
  agentPrompt,
  onAgentPromptChange,
  focus
}: {
  value: CaptureSettings
  /** 変えたらすぐ保存する */
  onChange: (patch: Partial<CaptureSettings>) => void
  recording: boolean
  micDevices: Array<{ id: string; label: string }>
  available: SttAvailability
  /** キー・接続先を変えたあと、使える状態を読み直す（文字起こしの節がキーと接続先を自分で保存する） */
  onAvailabilityChange: () => void
  onPickModel: () => void
  /** モデルをダウンロードして選んだあと、使える状態を読み直す */
  onModelChanged: () => void
  agents: AgentPreferences
  onAgentsChange: (next: AgentPreferences) => void
  agentPrompt: string
  onAgentPromptChange: (next: string) => void
  /** 外から特定の節を開く（Agent 設定・アカウント管理など）。nonce が変わるたびにその節へ移る */
  focus?: { section: SettingsSectionId; nonce: number } | null
}) {
  const t = useT()
  const v = value
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<SettingsSectionId>('general')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const titleOf = (id: SettingsSectionId) => t(`settings.section.${id}` as TranslationKey)
  const visible = useMemo(() => filterSettingsSections(query, titleOf), [query, t])
  // settings.json が外部で書き換えられたら、自分で読み込む節（文字起こし・整理など）を読み直させる
  const settingsRevision = useSettingsRevision()

  const goTo = (id: SettingsSectionId) => {
    setActive(id)
    document.getElementById(`settings-page-${id}`)?.scrollIntoView({ block: 'start' })
  }

  // 外から節を指定されたら、検索を外してその節へ移る
  useEffect(() => {
    if (!focus) return
    setQuery('')
    requestAnimationFrame(() => goTo(focus.section))
  }, [focus?.nonce])

  const onScroll = () => {
    const box = scrollRef.current
    if (!box) return
    const top = box.getBoundingClientRect().top
    const tops = [...box.querySelectorAll<HTMLElement>('[data-section]')].map((el) => ({ id: el.dataset.section as SettingsSectionId, top: el.getBoundingClientRect().top - top }))
    const current = activeSectionAt(tops)
    if (current) setActive(current)
  }

  const sections: Record<SettingsSectionId, ReactNode> = {
    setup: <PageSection key="setup" id="setup" title={titleOf('setup')}>
      {/* 済んだかは実際の状態から自動で決める（onboarding/setupChecklist.ts） */}
      <SetupChecklist />
    </PageSection>,
    general: <PageSection key="general" id="general" title={titleOf('general')}>
        <SelectRow label={t('settings.storage.keep')}>
          <select className="st-select" aria-label={t('settings.storage.keepLabel')} value={v.keepDays} disabled={recording} onChange={(e) => onChange({ keepDays: Number(e.target.value) })}>
            <option value="7">{t('settings.storage.days', { count: 7 })}</option><option value="30">{t('settings.storage.days', { count: 30 })}</option><option value="0">{t('settings.storage.forever')}</option>
          </select>
        </SelectRow>
        <p className="st-note">{t('settings.storage.note')}</p>
        <Switch label={t('settings.storage.stayFeedback')} checked={v.stayFeedbackOnStop} disabled={recording} onChange={(stayFeedbackOnStop) => onChange({ stayFeedbackOnStop })} />
        <h3 className="st-page__subheading">{t('settings.privacy.title')}</h3>
        <CrashReportsSetting />
    </PageSection>,
    appearance: <PageSection key="appearance" id="appearance" title={titleOf('appearance')}>
      {/* 配色の保存と反映は lib/theme.ts が持つ */}
      <div className="st-row"><span className="st-row__label">{t('settings.appearance.theme')}</span><ThemeSegmented /></div>
    </PageSection>,
    language: <PageSection key="language" id="language" title={titleOf('language')}>
      {/* 画面の言語は lib/i18n.ts が即時に保存・反映する */}
      <LanguageSection />
    </PageSection>,
    layout: <PageSection key="layout" id="layout" title={titleOf('layout')}>
      {/* 配置は layout-footer 担当の欄（行だけを描く）。保存・反映は lib/layout.ts が即時に行う */}
      <LayoutSettings />
    </PageSection>,
    recording: <PageSection key="recording" id="recording" title={titleOf('recording')}>
        <Switch label={t('settings.mic.captureMic')} checked={v.captureMic} disabled={recording} onChange={(captureMic) => onChange({ captureMic })} />
        <SelectRow label={t('settings.mic.device')}>
          <select className="st-select" aria-label={t('settings.mic.deviceLabel')} value={v.micDeviceId} disabled={recording || !v.captureMic} onChange={(e) => onChange({ micDeviceId: e.target.value })}>
            <option value="">{t('settings.mic.systemDefault')}</option>
            {micDevices.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
          </select>
        </SelectRow>
        <Switch label={t('settings.mic.captureSystemAudio')} checked={v.captureSystemAudio} disabled={recording} onChange={(captureSystemAudio) => onChange({ captureSystemAudio })} />
        {v.captureSystemAudio && <p className="st-note st-note--warn">{t('settings.mic.systemAudioWarning')}</p>}
    </PageSection>,
    transcription: <PageSection key="transcription" id="transcription" title={titleOf('transcription')}>
      {/* 提供元・接続先・費用の上限・キー・接続の確認（src/renderer/components/TranscriptionSection.tsx） */}
      <TranscriptionSection headless transcription={v.transcription} onTranscriptionChange={(transcription) => onChange({ transcription })}
        language={v.language} onLanguageChange={(language) => onChange({ language })} recording={recording} available={available}
        onAvailabilityChange={onAvailabilityChange} onPickModel={onPickModel} onModelChanged={onModelChanged} />
      {/* 表示だけの設定なので録画中でも切り替えられる。止まったときの警告は切っても出す */}
      <Switch label={t('settings.transcription.showLive')} checked={v.showLiveTranscript !== false} onChange={(showLiveTranscript) => onChange({ showLiveTranscript })} />
      <p className="st-note">{t('settings.transcription.showLiveNote')}</p>
    </PageSection>,
    organize: <PageSection key="organize" id="organize" title={titleOf('organize')}>
      {/* 指摘の整理（LLM の接続先・キー）。読み込み・保存は自分で行う（src/renderer/components/OrganizeSection.tsx） */}
      <OrganizeSection headless recording={recording} />
    </PageSection>,
    verify: <PageSection key="verify" id="verify" title={titleOf('verify')}>
      {/* 判定モデル（指摘の画面の「判定」）。読み込み・保存は自分で行う（src/renderer/components/DecisionSection.tsx） */}
      <DecisionSection recording={recording} />
    </PageSection>,
    agents: <PageSection key="agents" id="agents" title={titleOf('agents')}>
      <AgentSection value={agents} onChange={onAgentsChange} prompt={agentPrompt} onPromptChange={onAgentPromptChange} />
    </PageSection>,
    orchestra: <PageSection key="orchestra" id="orchestra" title={titleOf('orchestra')}>
      {/* 全体の共通のルールとプロダクトごとのルール。読み込み・保存は自分で行う（src/renderer/components/OrchestraSection.tsx） */}
      <OrchestraSection />
    </PageSection>,
    remote: <PageSection key="remote" id="remote" title={titleOf('remote')}>
      {/* スマホから操作。入れる・ポート・リンクと QR・作り直しは main が持つ（src/renderer/components/RemoteSection.tsx） */}
      <RemoteSection />
    </PageSection>,
    accounts: <PageSection key="accounts" id="accounts" title={titleOf('accounts')} bare>
      {/* 外側の section・見出し・保存（IPC で即時）はアカウント欄が自分で持つ */}
      <AccountsSection />
    </PageSection>,
    extensions: <PageSection key="extensions" id="extensions" title={titleOf('extensions')}>
      {/* 内蔵ブラウザの Chrome 拡張。読み込み・保存は main が行う（src/renderer/components/BrowserExtensionsSection.tsx） */}
      <BrowserExtensionsSection recording={recording} />
    </PageSection>,
    browserProfiles: <PageSection key="browserProfiles" id="browserProfiles" title={titleOf('browserProfiles')}>
      {/* 内蔵ブラウザのログインの組（既定は全プロジェクトで共有）。保存は main の project:update（src/renderer/components/BrowserProfilesSection.tsx） */}
      <BrowserProfilesSection />
    </PageSection>,
    browserImport: <PageSection key="browserImport" id="browserImport" title={titleOf('browserImport')}>
      {/* ほかのブラウザのパスワードの CSV・履歴の取り込み。読み込み・保存は main が行う（src/renderer/components/BrowserImportSection.tsx） */}
      <BrowserImportSection />
    </PageSection>,
    cli: <PageSection key="cli" id="cli" title={titleOf('cli')}>
      {/* よく使うサービスの CLI。ボタンで公式のコマンドを内蔵ターミナルの新しいタブで走らせる（src/renderer/components/CliToolsSection.tsx） */}
      <CliToolsSection />
      <GithubRepoDefaults />
    </PageSection>,
    about: <PageSection key="about" id="about" title={titleOf('about')}>
      <AboutSection />
    </PageSection>
  }

  return <div className="st-page" data-testid="settings-page">
    <nav className="st-page__nav" aria-label={t('settings.nav.label')}>
      <h1 className="st-page__title">{t('settings.title')}</h1>
      {SETTINGS_SECTIONS.map((id) => <button key={id} type="button" className="st-page__navitem" aria-current={active === id || undefined}
        disabled={!visible.includes(id)} onClick={() => goTo(id)} data-testid={`settings-nav-${id}`}>{titleOf(id)}</button>)}
    </nav>
    <div className="st-page__main">
      <div className="st-page__search">
        <Field icon={<Search size={14} strokeWidth={1.5} />} type="search" placeholder={t('settings.search.placeholder')} aria-label={t('settings.search.placeholder')}
          value={query} onChange={(e) => setQuery(e.target.value)} data-testid="settings-search" />
      </div>
      <div className="st-page__scroll" ref={scrollRef} onScroll={onScroll}>
        {recording && <p className="st-lock"><Lock size={12} aria-hidden="true" />{t('settings.locked')}</p>}
        <p className="st-note st-page__autosave">{t('settings.autosave')}</p>
        {/* すべての設定の正本の settings.json（場所・開く・壊れたときの理由） */}
        <SettingsFileCard />
        {visible.length === 0
          ? <p className="st-page__empty" data-testid="settings-empty">{t('settings.search.empty', { query })}</p>
          : <div key={settingsRevision} className="st-page__sections">{visible.map((id) => sections[id])}</div>}
      </div>
    </div>
  </div>
}
