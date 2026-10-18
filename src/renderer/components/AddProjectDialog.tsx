import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Briefcase, Folder, FolderGit2, KeyRound, Laptop, Lock, Network, Server, X } from 'lucide-react'
import type { Project, ProjectsState } from '@shared/types'
import { cloneRepoName, normalizeCloneUrl, tildePath, type CloneFailureKind, type GitHubRepoList, type ProjectSource, type SshConfigHost } from '@shared/projectSource'
import { checkSshTarget } from '@shared/sshCommand'
import type { TranslationKey } from '@shared/i18n'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, Field, IconButton, Modal, Progress, Segmented, useToast } from '../ui'
import { GITLAB_COM, type Forge } from '@shared/forge'
import { VentureCreateStep } from '../venture/VentureCreateStep'

/**
 * 「プロジェクトを追加」。自分の PC で開く / GitHub・GitLab から取得 / SSH で開く の3つから選ぶ。
 * 取得の一覧は GitHub（gh）と GitLab（glab。gitlab.com とセルフホスト）を切り替えて選べる。URL の欄はどちらでも受け付ける。
 *
 * Orca由来（MIT）: ~/bench/orca/src/renderer/src/components/sidebar/AddRepoDialog.tsx の
 *   「最初に開き方を選び、選んだ手順だけを出し、戻れる」流れと、
 *   useAddRepoCloneFlow.ts の「保存先の既定・進み具合・キャンセル・失敗の表示」。
 * リモートホストの選択・worktree・作成の手順は持ち込まない。
 *
 * 開いている間は、呼び出し側が内蔵ブラウザのビューを隠す（Modal はネイティブのビューの下になるため）。
 */
type Step = 'choose' | 'github' | 'ssh' | 'orchestra' | 'venture'

/** 前回の保存先（この端末だけの好み） */
const PARENT_KEY = 'ferret.cloneParent'
function loadParent(): string {
  try { return localStorage.getItem(PARENT_KEY) ?? '' } catch { return '' }
}
function saveParent(parent: string): void {
  try { localStorage.setItem(PARENT_KEY, parent) } catch { /* 保存できなくても次回は既定から */ }
}

export function AddProjectDialog({ onClose, onAdded }: {
  onClose: () => void
  /** 追加して開いたあと。source はどの開き方か */
  onAdded: (state: ProjectsState, source: ProjectSource) => void
}) {
  const t = useT()
  const toast = useToast()
  const [step, setStep] = useState<Step>('choose')

  const addLocal = () => {
    onClose()
    void window.ade.invoke('project:add')
      .then((state) => { if (state) onAdded(state, 'local') })
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  return <Modal className="rv-modal" label={t('projectSource.addChooseTitle')} onClose={onClose}>
    <div className="rv-modal__panel apd" data-testid="add-project-dialog">
      <header className="rv-modal__head apd__head">
        {step !== 'choose' && <IconButton size="sm" label={t('projectSource.back')} icon={<ArrowLeft size={14} strokeWidth={1.5} />} onClick={() => setStep('choose')} data-testid="add-project-back" />}
        <h2>{t(step === 'github' ? 'projectSource.choose.github' : step === 'ssh' ? 'projectSource.choose.ssh' : step === 'orchestra' ? 'orchestra.create' : step === 'venture' ? 'venture.choice' : 'projectSource.addChooseTitle')}</h2>
        <IconButton label={t('common.close')} icon={<X size={16} />} onClick={onClose} />
      </header>
      {step === 'choose' && <div className="apd__choices">
        <p className="apd__group">{t('projectSource.groupProject')}</p>
        <ChoiceButton icon={<Laptop size={18} strokeWidth={1.5} />} title={t('projectSource.choose.local')} hint={t('projectSource.choose.localHint')} onClick={addLocal} testId="add-project-local" />
        <ChoiceButton icon={<FolderGit2 size={18} strokeWidth={1.5} />} title={t('projectSource.choose.github')} hint={t('projectSource.choose.githubHint')} onClick={() => setStep('github')} testId="add-project-github" />
        <ChoiceButton icon={<Server size={18} strokeWidth={1.5} />} title={t('projectSource.choose.ssh')} hint={t('projectSource.choose.sshHint')} onClick={() => setStep('ssh')} testId="add-project-ssh" />
        <p className="apd__group">{t('projectSource.groupOrchestra')}</p>
        <ChoiceButton icon={<Network size={18} strokeWidth={1.5} />} title={t('orchestra.create')} hint={t('orchestra.createHint')} onClick={() => setStep('orchestra')} testId="add-orchestra" />
        <ChoiceButton icon={<Briefcase size={18} strokeWidth={1.5} />} title={t('venture.choice')} hint={t('venture.choiceHint')} onClick={() => setStep('venture')} testId="add-venture" />
      </div>}
      {step === 'orchestra' && <OrchestraStep onDone={(state) => { onClose(); onAdded(state, 'local') }} />}
      {step === 'venture' && <VentureCreateStep onDone={(state) => { onClose(); onAdded(state, 'local') }} />}
      {step === 'github' && <GitHubStep onDone={(state) => { onClose(); onAdded(state, 'github') }} />}
      {step === 'ssh' && <SshStep onDone={(state) => { onClose(); onAdded(state, 'ssh') }} />}
    </div>
  </Modal>
}

function ChoiceButton({ icon, title, hint, onClick, testId }: { icon: React.ReactNode; title: string; hint: string; onClick: () => void; testId: string }) {
  return <button type="button" className="apd__choice" onClick={onClick} data-testid={testId}>
    <span className="apd__choice-icon" aria-hidden="true">{icon}</span>
    <span className="apd__choice-text"><span className="apd__choice-title">{title}</span><span className="apd__choice-hint">{hint}</span></span>
  </button>
}

function GitHubStep({ onDone }: { onDone: (state: ProjectsState) => void }) {
  const t = useT()
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState(loadParent)
  const [home, setHome] = useState('')
  const [repos, setRepos] = useState<GitHubRepoList | null>(null)
  const [forge, setForge] = useState<Forge>('github')
  const [gitlabRepos, setGitlabRepos] = useState<GitHubRepoList | null>(null)
  const [filter, setFilter] = useState('')
  const [progress, setProgress] = useState<{ phase: string; percent: number } | null>(null)
  const [cloning, setCloning] = useState(false)
  const [failure, setFailure] = useState<{ kind: CloneFailureKind; detail: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.ade.invoke('project:cloneDefaults').then((d) => { if (!cancelled) { setHome(d.home); setParent((p) => p || d.parent) } }).catch(() => undefined)
    void window.ade.invoke('project:githubRepos').then((list) => { if (!cancelled) setRepos(list) })
      .catch(() => { if (!cancelled) setRepos({ ghInstalled: true, loggedIn: false, repos: [] }) })
    const off = window.ade.on('project:cloneProgress', setProgress)
    return () => { cancelled = true; off() }
  }, [])

  const checked = normalizeCloneUrl(url)
  const name = checked.ok ? cloneRepoName(checked.url) : null
  const destination = name && parent ? `${parent.replace(/[\\/]+$/, '')}/${name}` : null
  // GitLab の一覧は、切り替えたときに初めて読む（glab を毎回起こさない）
  useEffect(() => {
    if (forge !== 'gitlab' || gitlabRepos) return
    let cancelled = false
    void window.ade.invoke('project:gitlabRepos').then((list) => { if (!cancelled) setGitlabRepos(list) })
      .catch(() => { if (!cancelled) setGitlabRepos({ ghInstalled: true, loggedIn: false, repos: [] }) })
    return () => { cancelled = true }
  }, [forge, gitlabRepos])

  const list = forge === 'gitlab' ? gitlabRepos : repos
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (list?.repos ?? []).filter((r) => !q || r.nameWithOwner.toLowerCase().includes(q)).slice(0, 50)
  }, [list, filter])

  const clone = () => {
    if (!checked.ok || !parent) return
    setCloning(true)
    setFailure(null)
    setProgress(null)
    void window.ade.invoke('project:clone', checked.url, parent).then((result) => {
      setCloning(false)
      if (result.ok) { saveParent(parent); onDone(result.state) } else setFailure({ kind: result.kind, detail: result.detail })
    }).catch((err) => { setCloning(false); setFailure({ kind: 'failed', detail: errorMessage(err) }) })
  }

  return <div className="apd__body">
    <label className="pt-field">
      <span>{t('projectSource.github.url')}</span>
      <Field mono autoFocus placeholder={t('projectSource.github.urlPlaceholder')} value={url} disabled={cloning} autoComplete="off" spellCheck={false}
        invalid={url.trim() !== '' && !checked.ok} onChange={(e) => { setUrl(e.target.value); setFailure(null) }} data-testid="clone-url" />
    </label>
    {url.trim() !== '' && !checked.ok && <p className="st-note st-note--warn">{t('projectSource.github.urlInvalid')}</p>}

    <div className="apd__repos">
      <span className="apd__repos-head">
        <span className="pt-editor__caption">{t('projectSource.github.yourRepos')}</span>
        <Segmented<Forge> ariaLabel={t('projectSource.github.yourRepos')} value={forge} onChange={(next) => { setForge(next); setFilter('') }} options={[
          { value: 'github', label: 'GitHub', testId: 'clone-forge-github' },
          { value: 'gitlab', label: 'GitLab', testId: 'clone-forge-gitlab' }
        ]} />
      </span>
      {list === null ? <p className="st-note">{t('projectSource.github.loading')}</p>
        : !list.ghInstalled ? <p className="st-note">{t(forge === 'gitlab' ? 'projectSource.gitlab.noGlab' : 'projectSource.github.noGh')}</p>
          : !list.loggedIn ? <p className="st-note">{t(forge === 'gitlab' ? 'projectSource.gitlab.notLoggedIn' : 'projectSource.github.notLoggedIn')}</p>
            : list.error ? <p className="st-note st-note--warn">{list.error}</p>
              : <>
                <Field placeholder={t('projectSource.github.filter')} aria-label={t('projectSource.github.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} disabled={cloning} />
                <ul className="apd__repo-list" data-testid="clone-repo-list">
                  {shown.map((repo) => <li key={`${repo.host ?? ''}/${repo.nameWithOwner}`}>
                    <button type="button" className={`apd__repo${url === repo.url ? ' is-selected' : ''}`} disabled={cloning} onClick={() => { setUrl(repo.url); setFailure(null) }}>
                      <span className="apd__repo-name">{repo.nameWithOwner}</span>
                      {repo.host && repo.host !== GITLAB_COM && <span className="apd__repo-host">{repo.host}</span>}
                      {repo.isPrivate && <span className="apd__repo-private"><Lock size={10} aria-hidden="true" />{t('projectSource.github.private')}</span>}
                    </button>
                  </li>)}
                </ul>
              </>}
    </div>

    <label className="pt-field">
      <span>{t('projectSource.github.parent')}</span>
      <span className="apd__parent">
        <Field mono value={tildePath(parent, home)} readOnly title={parent} aria-label={t('projectSource.github.parent')} data-testid="clone-parent" />
        <Button disabled={cloning} onClick={() => void window.ade.invoke('project:pickParent', parent).then((p) => { if (p) setParent(p) })}>{t('projectSource.github.choose')}</Button>
      </span>
    </label>
    {destination && <p className="st-note" data-testid="clone-destination"><Folder size={11} aria-hidden="true" />{t('projectSource.github.destination', { path: tildePath(destination, home) })}</p>}

    {cloning && <div className="apd__progress" data-testid="clone-progress">
      <Progress value={progress ? progress.percent / 100 : undefined} />
      <span className="st-note">{progress ? `${progress.phase} ${progress.percent}%` : t('projectSource.github.cloning')}</span>
    </div>}
    {failure && <div className="apd__failure" role="alert" data-testid="clone-error">
      <p className="st-note st-note--warn">{t(`projectSource.clone.error.${failure.kind}` as TranslationKey)}</p>
      {failure.detail && failure.kind !== 'cancelled' && <code className="apd__detail">{failure.detail}</code>}
    </div>}

    <div className="apd__actions">
      {cloning
        ? <Button variant="ghost" onClick={() => void window.ade.invoke('project:cloneCancel')} data-testid="clone-cancel">{t('common.cancel')}</Button>
        : <Button variant="primary" disabled={!checked.ok || !parent} onClick={clone} data-testid="clone-start">{t('projectSource.github.clone')}</Button>}
    </div>
  </div>
}

function SshStep({ onDone }: { onDone: (state: ProjectsState) => void }) {
  const t = useT()
  const toast = useToast()
  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null)
  const [host, setHost] = useState('')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.ade.invoke('project:sshHosts').then(setHosts).catch(() => setHosts([]))
  }, [])
  const checked = checkSshTarget({ host, path })
  const hostError = host.trim() !== '' && !checked.ok && checked.reason === 'host'
  const pathError = path.trim() !== '' && !checked.ok && checked.reason === 'path'

  const add = () => {
    if (!checked.ok) return
    setBusy(true)
    void window.ade.invoke('project:addSsh', checked.target, name.trim() || undefined)
      .then(onDone)
      .catch((err) => { setBusy(false); toast({ tone: 'warning', message: errorMessage(err) }) })
  }

  return <div className="apd__body">
    <label className="pt-field">
      <span>{t('projectSource.ssh.host')}</span>
      <Field mono autoFocus list="apd-ssh-hosts" placeholder={t('projectSource.ssh.hostPlaceholder')} value={host} invalid={hostError} autoComplete="off" spellCheck={false}
        onChange={(e) => setHost(e.target.value)} data-testid="ssh-host" />
      <datalist id="apd-ssh-hosts">
        {(hosts ?? []).map((h) => <option key={h.host} value={h.host}>{[h.user, h.hostname].filter(Boolean).join('@')}</option>)}
      </datalist>
    </label>
    <p className="st-note">{hosts && hosts.length === 0 ? t('projectSource.ssh.noHosts') : t('projectSource.ssh.hostHint')}</p>
    {hostError && <p className="st-note st-note--warn">{t('projectSource.errors.host')}</p>}
    <label className="pt-field">
      <span>{t('projectSource.ssh.path')}</span>
      <Field mono placeholder={t('projectSource.ssh.pathPlaceholder')} value={path} invalid={pathError} autoComplete="off" spellCheck={false}
        onChange={(e) => setPath(e.target.value)} data-testid="ssh-path" />
    </label>
    {pathError && <p className="st-note st-note--warn">{t('projectSource.errors.path')}</p>}
    <label className="pt-field">
      <span>{t('projectSource.ssh.name')}</span>
      <Field value={name} onChange={(e) => setName(e.target.value)} data-testid="ssh-name" />
    </label>
    <p className="st-note"><KeyRound size={11} aria-hidden="true" />{t('projectSource.ssh.auth')}</p>
    <p className="st-note">{t('projectSource.ssh.limits')}</p>
    <div className="apd__actions">
      <Button variant="primary" disabled={!checked.ok} busy={busy} onClick={add} data-testid="ssh-add">{t('projectSource.ssh.add')}</Button>
    </div>
  </div>
}

/** 一覧に出す、プロジェクトの出どころの印（ローカルは今までのフォルダの印のまま） */
export function ProjectSourceIcon({ project, open, size = 14 }: { project: Project; open?: boolean; size?: number }) {
  if (project.source === 'ssh') return <Server size={size} strokeWidth={1.5} />
  if (project.source === 'github') return <FolderGit2 size={size} strokeWidth={1.5} />
  return open ? <Folder size={size} strokeWidth={1.5} fill="currentColor" fillOpacity={0.12} /> : <Folder size={size} strokeWidth={1.5} />
}

/** SSH のプロジェクトでは、右のファイルツリーの代わりにこれを出す */
export function RemoteFilesNotice({ project }: { project: Project }) {
  const t = useT()
  return <aside className="explorer apd-remote-files" data-testid="remote-files-notice">
    <p className="st-note"><Server size={12} aria-hidden="true" />{t('projectSource.remoteFiles', { host: project.ssh?.host ?? '' })}</p>
  </aside>
}


/** 新しいオーケストラ（名前だけ）。作るとそのオーケストラが開き、そのあと足したプロジェクトはその下に入る */
function OrchestraStep({ onDone }: { onDone: (state: ProjectsState) => void }) {
  const t = useT()
  const toast = useToast()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const create = () => {
    if (!name.trim() || busy) return
    setBusy(true)
    void window.ade.invoke('orchestra:create', name.trim())
      .then(onDone)
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setBusy(false))
  }
  return <div className="apd__body">
    <label className="pt-field">
      <span>{t('orchestra.createName')}</span>
      <Field autoFocus value={name} maxLength={80} placeholder={t('orchestra.createNamePlaceholder')} disabled={busy}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) create() }} data-testid="orchestra-create-name" />
    </label>
    <p className="st-note">{t('orchestra.createHint')}</p>
    <div className="apd__actions">
      <Button variant="primary" disabled={!name.trim() || busy} onClick={create} data-testid="orchestra-create">{t('orchestra.createButton')}</Button>
    </div>
  </div>
}
