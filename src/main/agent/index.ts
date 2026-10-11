/**
 * Agent への送信と状態検知（要件 OUT-2 / OUT-3、設計7章、04_benchmark.md 3.3・3.5）。
 * Electron にも node-pty にも依存しない。PTY は `AgentTerminal`（write と onData の2つ）で受ける。
 *
 * ──────────────────────────── 使い方 ────────────────────────────
 *
 * 【Agent を起動した直後（1回）】入力欄の準備を待つ
 *   const readiness = new ComposerReadiness(); terminal.onData((c) => readiness.push(c))
 *   const status = await waitForComposer(readiness)      // 静止1500ms・上限8000ms
 *   if (status === 'timeout') …                          // 送らずに理由を出す
 *
 * 【状態を追う】PTY の出力を食べさせる
 *   const tracker = new AgentStateTracker()
 *   const kind = identifyAgent('claude')                 // 同定にだけ使う
 *   terminal.onData((chunk) => {
 *     const title = parseTitle(chunk)
 *     tail = (tail + stripAnsi(chunk)).slice(-4000)
 *     const next = detectState(kind, { title, tail })
 *     if (tracker.observe(next, { visible: isTerminalVisible, visibleIdle: hasVisibleIdle(tail) })) {
 *       notifyUi(tracker.display())                      // idle / working / blocked / done
 *     }
 *   })
 *   tracker.markSeen()                                   // タブを見たら done → idle
 *
 * 【送信】
 *   const prompt = buildPrompt(paths.relativeDir)
 *   const result = await sendToAgent({ terminal, text: prompt, getState: () => tracker.current() })
 *   if (!result.ok) showReason(result.message)            // permission のときは送らない
 *
 * 【コピー】
 *   copyText(buildPrompt(paths.relativeDir))
 */

export * from './protocol'
export * from './sanitize'
export * from './state'
export * from './readiness'
export * from './send'
