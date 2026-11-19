import type { AdeApi, IpcRequestChannel, IpcResult } from '@shared/ipc'

/**
 * Storybook 用の window.ade。アプリでは preload が main とつなぐが、デザインシステムでは main が無いので、
 * story が決めた返事だけを返す（決めていない呼び出しは「設定なし」の空の値で返し、画面を止めない）。
 * story ごとに setAdeResponse で返事を差し替える（例: デザインシステムのタブの3つの状態）。
 */

type Responder = (...args: unknown[]) => unknown
const responses = new Map<string, Responder>()
/** 呼ばれた記録。［Agent に作ってもらう］などのボタンが本当に呼んでいるかを story で見せる */
export const adeCalls: Array<{ channel: string; args: unknown[] }> = []

export function setAdeResponse<C extends IpcRequestChannel>(channel: C, value: IpcResult<C> | ((...args: unknown[]) => IpcResult<C>)): void {
  responses.set(channel, typeof value === 'function' ? (value as Responder) : () => value)
}

export function resetAdeResponses(): void {
  responses.clear()
  adeCalls.length = 0
}

export function installAdeStub(): void {
  const api: AdeApi = {
    invoke: (async (channel: string, ...args: unknown[]) => {
      adeCalls.push({ channel, args })
      const responder = responses.get(channel)
      return responder ? responder(...args) : null
    }) as AdeApi['invoke'],
    on: () => () => {},
    platform: 'darwin',
    systemVersion: '',
    demo: false,
    initialTheme: 'dark',
    initialLocale: 'ja',
    inspectDrop: async () => []
  }
  Object.defineProperty(window, 'ade', { value: api, configurable: true, writable: true })
}
