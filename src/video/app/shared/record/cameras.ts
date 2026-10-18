/**
 * 撮影の画面のカメラの選び方。複数のカメラを同時に録れ、そのうち1台を「メイン（自分）」にする。
 * メインは最初に録り（camera-1）、take.json で role: 'main' にする（編集で顔を中央に来るように切り抜く）。旧 Solocut の lib/cameras.ts から移した。
 */

/** 選んだカメラのうちのメイン。指定したものが選ばれたままならそれ、無ければ選んだ最初のもの */
export function mainCamera(selected: readonly string[], mainId: string | null | undefined): string | null {
  if (mainId && selected.includes(mainId)) return mainId
  return selected[0] ?? null
}

/** 録る順の選んだカメラ。メインが先頭、残りは選んだ順。重なりは除く */
export function recordingOrder(selected: readonly string[], mainId: string | null | undefined): string[] {
  const uniq = [...new Set(selected)]
  const main = mainCamera(uniq, mainId)
  return main ? [main, ...uniq.filter((x) => x !== main)] : uniq
}

/** 選択に入れる・外す（順は保つ） */
export function toggleCamera(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
}

/** 抜いた機器を選択から外す。available = 今の enumerateDevices() の deviceId */
export function keepAvailable(selected: readonly string[], available: readonly string[]): string[] {
  const set = new Set(available)
  return selected.filter((x) => set.has(x))
}
