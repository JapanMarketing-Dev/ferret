import { useState } from 'react'
import { Check, Info, KeyRound, LogIn, Pencil, Plus, Trash2, X } from 'lucide-react'
import { accountDisplayName, defaultLoginLabel, type AgentAccountSummary, type AgentAccountsView } from '@shared/accounts'
import { TUI_AGENT_LABEL, type AccountAgent } from '@shared/types'
import { Badge, Button, Field, IconButton } from '../ui'
import { useAgentAccounts, type AccountAction } from '../hooks/useAgentAccounts'
import { AgentIcon } from './AgentIcon'
import { FailoverSettings } from './FailoverSettings'
import { formatDateTime } from '@shared/i18n'
import { useT } from '../lib/i18n'
import '../styles/accounts.css'

/**
 * 設定画面のアカウント欄（Claude Code / Codex）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/settings/AccountsPane.tsx,
 *           ~/bench/orca/src/renderer/src/components/settings/accounts-pane-claude-section.tsx,
 *           ~/bench/orca/src/renderer/src/components/settings/accounts-pane-codex-section.tsx,
 *           ~/bench/orca/src/renderer/src/components/settings/accounts-pane-codex-account-row.tsx,
 *           ~/bench/orca/src/renderer/src/components/settings/accounts-pane-removal-dialogs.tsx（MIT, Copyright 2026 Lovecast Inc.）
 *
 * いつものログイン（~/.claude・~/.codex）を、ログインしているアカウントの名前（メール）の1行として先頭に置き、
 * その下に追加したアカウントを並べる。どれを使うかは行を押して選ぶ（「システムの既定」という別枠は出さない）。
 * 追加はログインを促す流れ（押すと内蔵ターミナルでログインが始まる）。保存は main 側で即時に行うので、
 * ダイアログを閉じたときの一括保存の対象ではない。WSL・リモート・使用量の表示は持ち込んでいない。
 */

const AGENTS: readonly AccountAgent[] = ['claude', 'codex']

function formatTime(ms: number | null): string {
  if (!ms) return ''
  return formatDateTime(ms, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function AccountRow({
  agent,
  account,
  active,
  action,
  onSelect,
  onRename,
  onRemove,
  onRelogin
}: {
  agent: AccountAgent
  account: AgentAccountSummary
  active: boolean
  action: AccountAction
  onSelect: () => void
  onRename: (label: string) => void
  onRemove: () => void
  onRelogin: () => void
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(account.label)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const busy = action !== 'idle'
  const pending = account.lastAuthenticatedAt === null
  const usable = account.signedIn && !account.problem

  const status = account.problem
    ? { tone: 'warning' as const, text: t('accounts.status.unusable') }
    : pending
      ? { tone: 'neutral' as const, text: t('accounts.status.pending') }
      : !account.signedIn
        ? { tone: 'warning' as const, text: t('accounts.status.reloginNeeded') }
        : null
  const detail =
    account.problem ??
    (pending
      ? t('accounts.pendingDetail')
      : [account.label && account.email, account.workspaceLabel, account.lastAuthenticatedAt && t('accounts.signedInAt', { time: formatTime(account.lastAuthenticatedAt) })]
          .filter(Boolean)
          .join(t('common.listSeparator')))

  const commitRename = () => {
    setEditing(false)
    if (draft.trim() !== account.label) onRename(draft)
  }

  return (
    <div className={`acct-row${active ? ' is-active' : ''}`} data-testid={`account-row-${account.id}`}>
      <button
        type="button"
        className="acct-row__main"
        onClick={onSelect}
        disabled={busy || active || !usable || editing}
        aria-pressed={active}
        title={usable ? (active ? t('accounts.selected') : t('accounts.switchTo')) : undefined}
      >
        <span className="acct-row__radio" aria-hidden="true">{active && <Check size={12} strokeWidth={2.5} />}</span>
        <span className="acct-row__text">
          {editing ? null : (
            <span className="acct-row__name">
              <span className="acct-row__label" title={accountDisplayName(account)}>{accountDisplayName(account)}</span>
              {active && <Badge tone="brand">{t('accounts.selected')}</Badge>}
              {status && <Badge tone={status.tone}>{status.text}</Badge>}
            </span>
          )}
          {!editing && detail && <span className={`acct-row__detail${account.problem ? ' is-warn' : ''}`} title={detail}>{detail}</span>}
        </span>
      </button>
      {editing && (
        <div className="acct-row__edit">
          <Field
            autoFocus
            value={draft}
            placeholder={account.email ?? t('accounts.namePlaceholder', { agent: TUI_AGENT_LABEL[agent] })}
            aria-label={t('accounts.nameLabel')}
            maxLength={80}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitRename()
              if (e.key === 'Escape') {
                e.stopPropagation()
                setDraft(account.label)
                setEditing(false)
              }
            }}
          />
          <IconButton size="sm" label={t('accounts.saveName')} icon={<Check size={14} />} onClick={commitRename} />
          <IconButton size="sm" label={t('common.cancelShort')} icon={<X size={14} />} onClick={() => { setDraft(account.label); setEditing(false) }} />
        </div>
      )}
      {!editing && !confirmRemove && (
        <div className="acct-row__actions">
          {(pending || !account.signedIn) && !account.problem && (
            <Button variant="ghost" icon={<LogIn size={14} />} disabled={busy} onClick={onRelogin}>
              {pending ? t('accounts.openLogin') : t('accounts.relogin')}
            </Button>
          )}
          <IconButton size="sm" label={t('accounts.rename')} icon={<Pencil size={14} />} disabled={busy} onClick={() => { setDraft(account.label); setEditing(true) }} />
          <IconButton size="sm" label={t('common.delete')} icon={<Trash2 size={14} />} disabled={busy} onClick={() => setConfirmRemove(true)} />
        </div>
      )}
      {confirmRemove && (
        <div className="acct-row__confirm" role="alertdialog" aria-label={t('accounts.removeLabel')}>
          <span>{t('accounts.removeConfirm')}</span>
          <Button variant="danger" busy={action === `remove:${account.id}`} onClick={onRemove}>{t('common.delete')}</Button>
          <Button variant="ghost" onClick={() => setConfirmRemove(false)}>{t('common.cancelShort')}</Button>
        </div>
      )}
    </div>
  )
}

function AgentAccounts({
  agent,
  view,
  accounts
}: {
  agent: AccountAgent
  view: AgentAccountsView | undefined
  accounts: ReturnType<typeof useAgentAccounts>
}) {
  const t = useT()
  const { action, select, rename, remove, relogin, add, switched } = accounts
  const busy = action !== 'idle'
  // いつものログイン（~/.claude・~/.codex。保存値の null）も、追加したアカウントと同じ1行として、ログインしているアカウントの名前で並べる。
  // 「システムの既定」という別枠は出さない（2026-11-13）。名前の変更・削除は無い（Ferret が作ったフォルダではないので消さない）
  const defaultActive = !!view && view.activeAccountId === null
  const system = view?.systemDefault
  const defaultName = defaultLoginLabel(agent, system)
  // 追加したアカウントに同じメールがあるときだけ、どちらがいつものログインか分かるよう添える
  const sameEmail = !!system?.email && !!view?.accounts.some((a) => a.email?.toLowerCase() === system.email?.toLowerCase())
  const defaultDetail = [system?.signedIn && system.email ? system.workspaceLabel : null, sameEmail ? t('accounts.defaultLogin', { agent: TUI_AGENT_LABEL[agent] }) : null]
    .filter(Boolean)
    .join(t('common.listSeparator'))

  return (
    <div className="acct-group" id={`settings-accounts-${agent}`} data-testid={`accounts-${agent}`}>
      <div className="acct-group__head">
        <span className="acct-group__title">
          <AgentIcon agent={agent} size={14} />
          {TUI_AGENT_LABEL[agent]}
        </span>
        <Button variant="default" icon={<Plus size={14} />} busy={action === `add:${agent}`} disabled={busy} onClick={() => void add(agent)} data-testid={`accounts-add-${agent}`}>
          {t('accounts.add')}
        </Button>
      </div>
      {view && (
        <div className={`acct-row${defaultActive ? ' is-active' : ''}`} data-testid={`account-row-default-${agent}`}>
          <button
            type="button"
            className="acct-row__main"
            onClick={() => void select(agent, null)}
            disabled={busy || defaultActive}
            aria-pressed={defaultActive}
            title={defaultActive ? t('accounts.selected') : t('accounts.switchTo')}
          >
            <span className="acct-row__radio" aria-hidden="true">{defaultActive && <Check size={12} strokeWidth={2.5} />}</span>
            <span className="acct-row__text">
              <span className="acct-row__name">
                <span className="acct-row__label" title={defaultName}>{defaultName}</span>
                {defaultActive && <Badge tone="brand">{t('accounts.selected')}</Badge>}
                {!system?.signedIn && <Badge tone="warning">{t('accounts.status.signedOut')}</Badge>}
              </span>
              {defaultDetail && <span className="acct-row__detail" title={defaultDetail}>{defaultDetail}</span>}
            </span>
          </button>
        </div>
      )}
      {view?.accounts.map((account) => (
        <AccountRow
          key={account.id}
          agent={agent}
          account={account}
          active={view.activeAccountId === account.id}
          action={action}
          onSelect={() => void select(agent, account.id)}
          onRename={(label) => void rename(agent, account.id, label)}
          onRemove={() => void remove(agent, account.id)}
          onRelogin={() => void relogin(agent, account.id)}
        />
      ))}
      {switched === agent && (
        <p className="st-note st-note--ok" role="status">
          <Check size={12} aria-hidden="true" />
          {t('accounts.switched', { agent: TUI_AGENT_LABEL[agent] })}
        </p>
      )}
    </div>
  )
}

export function AccountsSection() {
  const t = useT()
  const accounts = useAgentAccounts()
  const { state, error } = accounts
  return (
    <section className="st-section" id="settings-accounts" data-testid="settings-accounts">
      <h3 className="st-section__title">
        <span className="st-section__icon st-section__icon--agent" aria-hidden="true"><KeyRound size={14} /></span>
        {t('accounts.title')}
      </h3>
      <div className="st-section__body">
        <p className="st-note">
          <Info size={12} aria-hidden="true" />
          {t('accounts.intro')}
        </p>
        {error && <p className="st-note st-note--warn" role="alert">{error}</p>}
        {AGENTS.map((agent) => (
          <AgentAccounts key={agent} agent={agent} view={state?.[agent]} accounts={accounts} />
        ))}
        <FailoverSettings />
      </div>
    </section>
  )
}
