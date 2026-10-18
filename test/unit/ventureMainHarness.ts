/**
 * ビジネスの main（src/main/venture）のテストの共通: 一時フォルダ・偽の wiring（登録・開く・ダイアログ・ターミナル）。Electron は import しない
 */
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserWindow, MessageBoxOptions, OpenDialogOptions } from 'electron'
import { UserFacingError } from '../../src/shared/errors'
import type { Project } from '../../src/shared/types'
import { ventureOpsHandlers, type VentureOpsHandlers, type VentureOpsWiring } from '../../src/main/venture/wire'

export async function tmp(prefix = 'venture-'): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)))
}

export interface FakeTerminals {
  sent: Array<{ id: string; text: string }>
  active: string | null
  agents: Record<string, 'claude' | 'codex' | null>
  result: { ok: boolean; message: string }
  throws: boolean
}

export interface Harness {
  w: VentureOpsWiring
  projects: Project[]
  /** showOpenDialog の答え（先頭から。null はやめた） */
  picks: Array<string | null>
  /** showMessageBox の答え（0 = する、1 = やめる。無ければ 1） */
  answers: number[]
  boxes: MessageBoxOptions[]
  opens: OpenDialogOptions[]
  registered: Array<{ folder: string; options: { name?: string; orchestra?: boolean; orchestraId?: string } }>
  opened: string[]
  notified: number
  recording: boolean
  consent: boolean
  windowGone: boolean
  terminals: FakeTerminals | null
  openId: string | null
  locale: 'ja' | 'en'
  /** ダイアログを出している間に走らせる（確かめている間の変更） */
  onBox: (() => Promise<void> | void) | null
  onOpen: (() => Promise<void> | void) | null
  handlers(): VentureOpsHandlers
  call<C extends keyof VentureOpsHandlers>(channel: C, ...args: Parameters<VentureOpsHandlers[C]>): Promise<any>
  project(folder: string): Project | undefined
}

export function harness(userData: string, over: Partial<VentureOpsWiring> = {}): Harness {
  let n = 0
  const h: Harness = {
    projects: [],
    picks: [],
    answers: [],
    boxes: [],
    opens: [],
    registered: [],
    opened: [],
    notified: 0,
    recording: false,
    consent: true,
    windowGone: false,
    terminals: { sent: [], active: 't1', agents: { t1: 'claude', t2: 'codex' }, result: { ok: true, message: 'sent' }, throws: false },
    openId: null,
    locale: 'en',
    onBox: null,
    onOpen: null,
    w: undefined as unknown as VentureOpsWiring,
    handlers: () => cached ?? (cached = ventureOpsHandlers(h.w)),
    call: async (channel, ...args) => (h.handlers()[channel] as (...a: unknown[]) => unknown)(...args),
    project: (folder) => h.projects.find((p) => path.resolve(p.folderPath) === path.resolve(folder))
  }
  let cached: VentureOpsHandlers | null = null
  const win = { isDestroyed: () => h.windowGone } as unknown as BrowserWindow
  const dialog = {
    showMessageBox: async (_w: unknown, options: MessageBoxOptions) => {
      h.boxes.push(options)
      await h.onBox?.()
      return { response: h.answers.length ? h.answers.shift()! : 1, checkboxChecked: false }
    },
    showOpenDialog: async (_w: unknown, options: OpenDialogOptions) => {
      h.opens.push(options)
      await h.onOpen?.()
      const p = h.picks.length ? h.picks.shift()! : null
      return p === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [p] }
    }
  } as unknown as VentureOpsWiring['dialog']
  h.w = {
    userData,
    isPackaged: false,
    isE2E: false,
    safeStorage: {} as VentureOpsWiring['safeStorage'],
    dialog,
    window: () => win,
    root: () => {
      const p = h.projects.find((x) => x.id === h.openId)
      return p && p.source !== 'ssh' ? p.folderPath : null
    },
    openProjectId: () => h.openId,
    projects: () => h.projects,
    registerFolder: (folder, options) => {
      h.registered.push({ folder, options })
      let p = h.project(folder)
      if (!p) {
        p = { id: `p${++n}`, name: path.basename(folder), folderPath: folder, urls: [] }
        h.projects.push(p)
      }
      const named = options.name ? { name: options.name } : {}
      const merged: Project = options.orchestra
        ? { ...p, ...named, orchestrator: true, editorWorkspace: true }
        : { ...p, ...named, ...(options.orchestraId && !p.editorWorkspace ? { orchestraId: options.orchestraId } : {}) }
      h.projects.splice(h.projects.indexOf(p), 1, merged)
      return merged
    },
    openProject: (id) => {
      h.opened.push(id)
      h.openId = id
    },
    projectsState: () => ({ projects: [...h.projects], activeProjectId: h.openId }),
    assertNotRecording: () => {
      if (h.recording) throw new UserFacingError('recording now')
    },
    terminals: () => {
      const t = h.terminals
      if (!t) return null
      return {
        resolveSendTarget: async () => t.active,
        agentState: async (id: string) => {
          if (!(id in t.agents)) throw new Error('gone')
          return { kind: t.agents[id] ? 'tui' : 'unknown', state: 'idle', agent: t.agents[id] }
        },
        sendReview: async (id: string, text: string) => {
          if (t.throws) throw new Error('pty broke')
          if (t.result.ok) t.sent.push({ id, text })
          return t.result
        }
      } as unknown as ReturnType<VentureOpsWiring['terminals']>
    },
    consentSend: () => {
      const c = h.consent
      return c
    },
    locale: () => h.locale,
    notify: () => { h.notified++ },
    ...over
  }
  return h
}

/** 新しいビジネスを作って開く（venture:create）。ビジネスのフォルダ */
export async function createVenture(h: Harness, parent: string, name = 'Shop'): Promise<string> {
  h.picks.push(parent)
  await h.call('venture:create', { name })
  return path.join(parent, name)
}
