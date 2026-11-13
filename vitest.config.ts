import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 分解パイプラインとセッション保存の単体テスト。
 * whisper・LLM・ネットワークは呼ばない（固定入力で常に通る）。
 * E2E（画面を操作するテスト）は置かない。単体と結合だけで、全部が10秒程度で終わるようにする。
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // 収録日時はローカル時刻で書くので、CI（UTC）でも手元（日本時間）と同じ結果になるよう固定する
    env: { TZ: 'Asia/Tokyo' },
    // 親の Ferret のターミナルから受け継いだ変数を消してから流す（手元でだけ落ちるのを防ぐ）
    setupFiles: ['test/setup/isolateEnv.ts', 'test/setup/i18n.ts'],
    testTimeout: 10_000
  }
})
