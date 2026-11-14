import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ArrowUp, Check, Folder, KeyRound, Server } from 'lucide-react'
import type { Project, ProjectsState } from '@shared/types'
import { tildePath, type ProjectSource, type SshConfigHost } from '@shared/projectSource'
import { isValidNewFolderName, type FolderListing } from '@shared/remoteFiles'
import { isValidSshHost, sshTargetLabel } from '@shared/sshCommand'
import { errorMessage } from '../lib/errors'
import { joinFolder, registeredSshConnections } from '../lib/newProjectPlaces'
import { useT } from '../lib/i18n'
import { Button, Field, IconButton, Segmented, Spinner } from '../ui'

/**
 * 左サイドバーの「新しいプロジェクト」。PC か SSH の接続先で場所をたどり、その場でフォルダを作ってプロジェクトにする。
 * 既にあるフォルダは「いまの場所をそのまま開く」で取り込める。
 *
 * - PC: ホームから始める。OS のフォルダ選択（Finder・エクスプローラー）で選ぶ今までの方法もリンクで残す
 * - SSH: 登録済みの SSH 接続・~/.ssh/config の Host・手入力の user@host から選んでつなぎ、リモートで同じ操作をする
 * フォルダの一覧と作成は main（src/main/folderBrowse.ts・remoteFiles.ts）。ここは画面だけ。
 */
export type NewProjectKind = 'pc' | 'ssh'

export function NewProjectPanel({ kind, projects, onKindChange, onClose, onAdded }: {
  kind: NewProjectKind
  projects: readonly Project[]
  onKindChange: (kind: NewProjectKind) => void
  onClose: () => void
  onAdded: (state: ProjectsState, source: ProjectSource) => void
}) {
  const t = useT()
  // SSH の接続先（選んでつないだもの）。null ならホストを選ぶ画面
  const [host, setHost] = useState<string | null>(null)
  const [startPath, setStartPath] = useState<string | null>(null)

  return <div className="npp" data-testid="new-project-panel">
    <div className="npp__head">
      <IconButton size="sm" label={t('newProject.back')} title={t('newProject.back')} icon={<ArrowLeft size={14} strokeWidth={1.5} />} onClick={onClose} data-testid="new-project-back" />
      <span className="npp__title">{t('newProject.title')}</span>
    </div>
    <Segmented
      className="npp__kind"
      ariaLabel={t('newProject.title')}
      value={kind}
      onChange={(next) => { setHost(null); onKindChange(next) }}
      options={[
        { value: 'pc', label: t('newProject.pc'), testId: 'new-project-pc' },
        { value: 'ssh', label: t('newProject.ssh'), testId: 'new-project-ssh' }
      ]}
    />
    {kind === 'pc' && <FolderPicker key="pc" mode={{ kind: 'pc' }} onAdded={(state) => onAdded(state, 'local')} />}
    {kind === 'ssh' && (host === null
      ? <HostChooser projects={projects} onConnect={(h, path) => { setStartPath(path); setHost(h) }} />
      : <>
        <div className="npp__connected" data-testid="new-project-connected">
          <Server size={12} aria-hidden="true" />
          <span className="npp__connected-host">{host}</span>
          <span className="npp__connected-state"><Check size={11} aria-hidden="true" />{t('newProject.connected')}</span>
          <button type="button" className="npp__link" onClick={() => setHost(null)} data-testid="new-project-change-host">{t('newProject.changeHost')}</button>
        </div>
        <FolderPicker key={`ssh:${host}:${startPath ?? ''}`} mode={{ kind: 'ssh', host, start: startPath }} onAdded={(state) => onAdded(state, 'ssh')} />
      </>)}
  </div>
}

/** SSH の接続先を選ぶ（登録済みの接続・~/.ssh/config の Host・手入力） */
function HostChooser({ projects, onConnect }: { projects: readonly Project[]; onConnect: (host: string, path: string | null) => void }) {
  const t = useT()
  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null)
  const [typed, setTyped] = useState('')
  useEffect(() => {
    void window.ade.invoke('project:sshHosts').then(setHosts).catch(() => setHosts([]))
  }, [])
  const registered = registeredSshConnections(projects)
  const typedHost = typed.trim()
  const typedOk = isValidSshHost(typedHost)

  return <div className="npp__body">
    {registered.length > 0 && <>
      <p className="npp__caption">{t('newProject.registered')}</p>
      <ul className="npp__list" data-testid="new-project-registered">
        {registered.map((c) => <li key={`${c.host}\n${c.path}`}>
          <button type="button" className="npp__item npp__item--registered" title={c.name} onClick={() => onConnect(c.host, c.path)}>
            <span className="npp__item-name">{sshTargetLabel(c)}</span>
          </button>
        </li>)}
      </ul>
    </>}
    <p className="npp__caption">{t('newProject.configHosts')}</p>
    {hosts === null ? <Spinner size={12} />
      : hosts.length === 0 ? <p className="st-note">{t('newProject.noConfigHosts')}</p>
        : <ul className="npp__list" data-testid="new-project-config-hosts">
          {hosts.map((h) => <li key={h.host}>
            <button type="button" className="npp__item" onClick={() => onConnect(h.host, null)}>
              <span className="npp__item-name">{h.host}</span>
              {(h.user || h.hostname) && <span className="npp__item-hint">{[h.user, h.hostname].filter(Boolean).join('@')}</span>}
            </button>
          </li>)}
        </ul>}
    <p className="npp__caption">{t('newProject.otherHost')}</p>
    <div className="npp__row">
      <Field mono placeholder={t('projectSource.ssh.hostPlaceholder')} aria-label={t('newProject.otherHost')} value={typed} invalid={typedHost !== '' && !typedOk}
        autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && typedOk) onConnect(typedHost, null) }} data-testid="new-project-host" />
      <Button variant="primary" disabled={!typedOk} onClick={() => onConnect(typedHost, null)} data-testid="new-project-connect">{t('newProject.connect')}</Button>
    </div>
    {typedHost !== '' && !typedOk && <p className="st-note st-note--warn">{t('projectSource.errors.host')}</p>}
    <p className="st-note"><KeyRound size={11} aria-hidden="true" />{t('projectSource.ssh.auth')}</p>
  </div>
}

type PickerMode = { kind: 'pc' } | { kind: 'ssh'; host: string; start: string | null }

/** 場所をたどって、フォルダを作る・そのまま開く */
function FolderPicker({ mode, onAdded }: { mode: PickerMode; onAdded: (state: ProjectsState) => void }) {
  const t = useT()
  const windows = mode.kind === 'pc' && window.ade?.platform === 'win32'
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [home, setHome] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  // mode は描くたびに作り直されるので、中の値で決める（そのまま deps にすると読み込みが止まらない）
  const sshHost = mode.kind === 'ssh' ? mode.host : null
  const start = mode.kind === 'ssh' ? mode.start : null
  const browse = useCallback((path: string | null) => {
    setLoading(true)
    setError(null)
    const request = sshHost === null
      ? window.ade.invoke('project:browseFolders', path)
      : window.ade.invoke('project:sshBrowse', sshHost, path)
    void request.then((next) => {
      setListing(next)
      if (path === null) setHome(next.path)
    }).catch((err) => setError(errorMessage(err))).finally(() => setLoading(false))
  }, [sshHost])

  useEffect(() => { browse(start) }, [browse, start])

  const trimmed = name.trim()
  const nameOk = isValidNewFolderName(trimmed)
  const here = listing?.path ?? ''
  const shown = (path: string) => (home ? tildePath(path, home) : path)
  const label = (path: string) => (mode.kind === 'ssh' ? `${mode.host}:${shown(path)}` : shown(path))

  const finish = (promise: Promise<ProjectsState>) => {
    setBusy(true)
    setError(null)
    void promise.then(onAdded).catch((err) => { setError(errorMessage(err)); setBusy(false) })
  }
  const create = () => {
    if (!listing || !nameOk || busy) return
    finish(mode.kind === 'pc'
      ? window.ade.invoke('project:createFolder', listing.path, trimmed)
      : window.ade.invoke('project:sshCreateFolder', mode.host, listing.path, trimmed))
  }
  const openHere = () => {
    if (!listing || busy) return
    finish(mode.kind === 'pc'
      ? window.ade.invoke('project:openBrowsed', listing.path)
      : window.ade.invoke('project:addSsh', { host: mode.host, path: listing.path }))
  }
  const pickWithDialog = () => {
    void window.ade.invoke('project:add').then((state) => { if (state) onAdded(state) }).catch((err) => setError(errorMessage(err)))
  }

  return <div className="npp__body">
    <p className="npp__caption">{t('newProject.location')}</p>
    <div className="npp__where">
      <span className="npp__path" title={here} data-testid="new-project-path">{listing ? shown(here) : '…'}</span>
      <IconButton size="sm" label={t('newProject.up')} title={t('newProject.up')} icon={<ArrowUp size={13} strokeWidth={1.75} />}
        disabled={!listing?.parent || loading} onClick={() => listing?.parent && browse(listing.parent)} data-testid="new-project-up" />
    </div>
    <ul className="npp__folders" data-testid="new-project-folders">
      {loading && !listing && <li className="npp__note"><Spinner size={12} /></li>}
      {listing?.folders.map((folder) => <li key={folder}>
        <button type="button" className="npp__folder" disabled={loading} onClick={() => browse(joinFolder(listing.path, folder, windows))}>
          <Folder size={13} strokeWidth={1.5} aria-hidden="true" /><span className="npp__item-name">{folder}</span>
        </button>
      </li>)}
      {listing && listing.folders.length === 0 && <li className="npp__note">{t('newProject.noFolders')}</li>}
    </ul>
    <p className="npp__hint">{t('newProject.clickToEnter')}</p>
    {error && <p className="st-note st-note--warn" role="alert" data-testid="new-project-error">{error}</p>}

    <label className="pt-field npp__name">
      <span>{t('newProject.folderName')}</span>
      <Field mono value={name} placeholder="my-app" invalid={trimmed !== '' && !nameOk} disabled={busy} autoComplete="off" spellCheck={false}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) create() }} data-testid="new-project-name" />
    </label>
    {listing && nameOk && <p className="npp__hint" data-testid="new-project-preview">{t('newProject.willCreate', { path: label(joinFolder(listing.path, trimmed, windows)) })}</p>}
    {trimmed !== '' && !nameOk && <p className="st-note st-note--warn">{t('newProject.errors.name')}</p>}
    <div className="npp__actions">
      <Button variant="primary" disabled={!listing || !nameOk || loading} busy={busy} onClick={create} data-testid="new-project-create">{t('newProject.create')}</Button>
      <Button disabled={!listing || loading || busy} onClick={openHere} data-testid="new-project-open-here">{t('newProject.openHere')}</Button>
      {mode.kind === 'pc' && <button type="button" className="npp__link" onClick={pickWithDialog} disabled={busy} data-testid="new-project-pick">{t('newProject.pickWithDialog')}</button>}
    </div>
  </div>
}
