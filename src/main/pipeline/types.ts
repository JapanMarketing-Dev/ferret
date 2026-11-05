/**
 * 分解パイプラインの型。
 * 時刻はすべて「録画開始からのミリ秒」（03_design.md 4章の同じ時計）。
 */

// ───────────────────────── 文字起こし ─────────────────────────

/** マイク系統＝自分、PC音声系統＝相手（02_requirements.md AUD-2） */
export type Speaker = 'self' | 'other';

/** 音声の取得系統。話者の区別をしない運用（対面・マイク1本）では 'mic' のみになる */
export type AudioSource = 'mic' | 'system'

export interface TranscriptSegment {
  /** 開始（録画開始からのms） */
  t0: number;
  /** 終了（録画開始からのms） */
  t1: number
  speaker: Speaker
  text: string;
  /** どの系統から出たか。二重取りの除去で使う */
  source?: AudioSource;
  /** whisper の平均対数確率（あれば）。低信頼の判定に使える */
  confidence?: number;
  /**
   * 話者分離モデルが付けた生のラベル（例 'speaker_1'）。
   * マイク1本に複数人が入る場合に、speaker（self/other）だけでは表せない区別を保持する。
   */
  speakerLabel?: string
  /** 取り込んだ mtg の文字起こしに書かれていた話者の名前（meeting/import.ts）。引用の名前（Quote.name）になる */
  speakerName?: string
  /**
   * 文字起こしに失敗した区切りの代わり（stt/engine.ts の failedChunkSegment）。text は「この区間を動画で確かめて」の案内で、話した言葉ではない。
   * 話した区間を黙って落とさないために残し、指摘は要確認にする
   */
  sttFailed?: true
}

// ───────────────────────── 操作ログ ─────────────────────────

export interface ElementRef {
  selector: string
  /** 要素の表示テキスト */
  text?: string
  /**
   * 入力欄の値など、出力してはいけない文字列か（NF-14）。
   * 注入スクリプトが `input[type=password]` などを見て立てる。
   * 立っていれば `text` は feedback.md に出さない。
   */
  sensitive?: boolean
}

export interface NavEvent {
  t: number
  type: 'nav'
  url: string
  title: string;
  /** 表示幅(px)。PC/スマホ切替（WS-3） */
  viewport?: number
}

/**
 * 座標を記録した時点のビューの大きさ（CSSピクセル）。
 * 表示幅を切り替える（WS-3）ため、ピクセル座標だけでは後から解釈できない。
 * これと併記することで 0〜1 の相対座標に直せる（04_benchmark.md 3.9）。
 */
interface ViewSize {
  width: number
  height: number
}

export interface ClickEvent {
  t: number
  type: 'click'
  x: number
  y: number
  /** この時点のビューの大きさ。無いと座標を再解釈できない */
  view?: ViewSize
  el?: ElementRef
}

export interface ScrollEvent {
  t: number
  type: 'scroll'
  y: number
}

/** ペン書き込み1本。id は feedback.md / LLM 出力から参照される */
export interface PenEvent {
  t: number
  type: 'pen'
  id: string;
  /** 書き終わった時刻（＝画像にすべき時刻） */
  t_end: number;
  /** [x, y, w, h] */
  bbox: [number, number, number, number]
  /** 四角の枠で囲んだとき 'rect'。手書きの線は省略 */
  shape?: 'rect'
  /**
   * 録画中に動かした・元に戻した書き込みは、新しい ID の pen として追記し、ここに前の ID を入れる
   * （操作ログは追記のみ）。前の ID の書き込みは、これに置き換わったものとして扱う（resolveAnnotationEdits）
   */
  replaces?: string
  /** この時点のビューの大きさ */
  view?: ViewSize
  el?: ElementRef
}

/** 録画中に「元に戻す」で取り消した書き込み。その ID の書き込みは無かったものとして扱う */
export interface EraseEvent {
  t: number
  type: 'erase'
  ids: string[]
}

/** 表示幅の切替（WS-3）。nav をまたいで保持される */
export interface ViewportEvent {
  t: number
  type: 'viewport'
  width: number
}

/**
 * 画面に映して書き込むトラック（録画の映像の1本）を切り替えた（@shared/captureTracks）。
 * 録画の開始時に最初のトラック（main）を1件記録し、切り替えるたびに足す。
 * 指摘は、その時刻に映していたトラックの話として扱う（内蔵ブラウザ以外なら URL・要素・直前の操作を付けない）
 */
export interface TrackEvent {
  t: number
  type: 'track'
  /** トラックの id（main・t2 …） */
  track: string
  kind: 'browser' | 'screen' | 'window'
  /** 人が読める名前（「Figma — 画面名」「内蔵ブラウザ」など）。画面由来の文字列 */
  label: string
  /** このトラックの動画（レビューのフォルダからの相対パス。recording.webm・tracks/t2.webm） */
  video?: string
}

/**
 * 操作ログの1件。
 * 録画中に画面へ文字を置く機能（旧 TXT-1）は廃止した（依頼は声とペンで行う）。古いレビューの events.jsonl には
 * type: 'text' の行が残っていることがあるが、どの処理も知らない種類として読み飛ばす（ファイルは移さない）。
 */
export type Event = NavEvent | ClickEvent | ScrollEvent | PenEvent | EraseEvent | ViewportEvent | TrackEvent;

/** 書き込み（annotation）。いまはペンだけ */
export type Annotation = PenEvent

export function isAnnotation(e: Event): e is Annotation {
  return e.type === 'pen'
}

/**
 * 動かした・元に戻した書き込みを反映した操作ログ。
 * - replaces を持つ pen が来たら、置き換えられた（前の位置の）pen を外す。最後の位置の pen だけが残る
 * - erase が来たら、その ID の pen を外す（erase 自体も外す）
 * 古い記録（replaces・erase が無い）はそのまま返る。何度かけても同じ結果になる
 */
export function resolveAnnotationEdits(events: Event[]): Event[] {
  const removed = new Set<string>()
  let edited = false
  for (const e of events) {
    if (e.type === 'erase') {
      edited = true
      for (const id of e.ids) removed.add(id)
    } else if (e.type === 'pen' && e.replaces) {
      edited = true
      removed.add(e.replaces)
    }
  }
  if (!edited) return events
  return events.filter((e) => e.type !== 'erase' && !(e.type === 'pen' && removed.has(e.id)))
}

/** 書き込みが画像として確定する時刻 */
export function annotationFrameTime(a: Annotation): number {
  return a.t_end
}

// ───────────────────────── 静止画 ─────────────────────────

export interface FrameRef {
  /** この画像に描画済みのペンのID（直前の未確定画像を選ばないため） */
  annotationId?: string
  /** 撮影時刻 */
  t: number;
  /** work/ 以下の相対パスなど。パイプラインは中身を読まない */
  path: string;
  /** カーソル位置（リング合成用。EXT-3） */
  cursor?: { x: number; y: number }
  /** この静止画の大きさ（ピクセル）。座標をこの画像に重ねるときに使う */
  size?: ViewSize
  /** ほぼ一色（読み込み途中の白いページなど）。話しただけの指摘の画像には選ばない */
  blank?: boolean
}

// ───────────────────────── 録画セッション ─────────────────────────

export interface SessionMeta {
  /** セッションID（フォルダ名）。例 20261002-104012 */
  id: string;
  /** 収録開始の実時刻（ISO8601） */
  startedAt: string;
  /** 録画の長さ(ms) */
  durationMs: number;
  /** 代表URL（最初の nav） */
  targetUrl?: string;
  /** 相手の声も録ったか。MTGモードの判定に使う（EXT-7） */
  twoSpeakers: boolean
  /**
   * 録画を始めた時点のプロジェクトの登録URL（local / dev / prd）。
   * 指摘を対象ごとにまとめるとき、URL に環境のラベルと区分（デザイン・設計書）を付けるのに使う（shared/reviewTarget.ts）
   */
  urlPresets?: Array<{ id: string; label: string; url: string; purpose?: import('@shared/types').TargetPurpose }>
}

/** 分解の入力一式（①素材化の結果） */
export interface Material {
  meta: SessionMeta
  transcript: TranscriptSegment[]
  events: Event[]
  frames: FrameRef[]
}

// ───────────────────────── ②下書き（ルール） ─────────────────────────

export interface DraftItem {
  /** d1, d2 … */
  id: string;
  /** 指摘の開始時刻 */
  t: number;
  /** 指摘の終了時刻 */
  tEnd: number;
  /** この指摘に属する発話（原文のまま） */
  segments: TranscriptSegment[];
  /** 紐づいたペンのID */
  annotationIds: string[];
  /** 画像にする静止画の時刻（最大3枚） */
  frameTimes: number[];
  /** 発話起点か、書き込み単独か */
  origin: 'speech' | 'annotation'
}

export interface Draft {
  items: DraftItem[]
  /** 意味の通じない発話（「Shh.」などの聞き取りの誤り・つなぎ言葉だけ。pipeline/meaningless.ts）。指摘にせず「除外した発話」に入れる */
  meaningless?: TranscriptSegment[]
}

// ───────────────────────── ③整理（LLM） ─────────────────────────

/** LLM へ渡す入力（テキストのみ。画像は既定で渡さない。NF-2 / 設計5章③） */
export interface OrganizeInput {
  meta: SessionMeta
  transcript: TranscriptSegment[]
  events: Event[];
  /** 静止画の「時刻一覧」だけを渡す（画像そのものは渡さない） */
  frameTimes: number[]
  draft: DraftItem[]
}

export type ItemStatus = 'decided' | 'needs_check'

export interface Quote {
  /**
   * 'text' は打った文の引用。エディタの「文字で指摘」（sessions/notes.ts）で作る。
   * 廃止した「画面に置いたテキスト」から来た古いレビューの引用も同じ印で、表示（確認画面・feedback.md）ではどちらも「書き込み」として出す
   */
  source?: 'text'
  speaker: Speaker
  t: number
  text: string
  /** 取り込んだ mtg の話者の名前（TranscriptSegment.speakerName）。あれば自分・相手の代わりに出す */
  name?: string
}

export interface OrganizedItem {
  title: string
  request: string
  status: ItemStatus
  quotes: Quote[]
  frame_times: number[]
  annotation_ids: string[]
}

interface DroppedUtterance {
  t: number
  text: string
  reason: string
}

/** LLM の出力（JSON Schema で検証する形） */
export interface OrganizeOutput {
  items: OrganizedItem[]
  dropped: DroppedUtterance[]
  /** レビュー全体の短い名前（履歴の見出しに使う。review_title）。古い出力には無い */
  reviewTitle?: string
}

// ───────────────────────── ④出力 ─────────────────────────

/** 機械的に付ける文脈（EXT-4。LLM には書かせない） */
export interface ItemContext {
  url?: string
  title?: string
  viewport?: number;
  /** 指した要素 */
  element?: ElementRef;
  /** 直前の操作の説明（例「トップ →「料金」をクリック」） */
  priorOps?: string
  /**
   * 複数の映像を録って切り替えた録画で、この指摘の時刻に映していた内蔵ブラウザ以外のもの（デスクトップアプリのウインドウ・画面）。
   * あれば URL・要素・直前の操作は付けない（内蔵ブラウザのものなので、映していた画面とは食い違う）
   */
  source?: { track: string; kind: 'screen' | 'window'; label: string }
}

/** 確認画面・feedback.md が扱う最終の指摘 */
export interface FeedbackItem {
  /** 編集をまたいで変わらないID。確認画面の操作はこれで指す */
  id: string
  /** 1 から始まる通し番号（時刻順。並べ替えたらその順。編集のたびに振り直す） */
  index: number;
  /** 指摘の代表時刻（見出しの [00:14]） */
  t: number
  title: string
  request: string
  status: ItemStatus
  quotes: Quote[];
  /** 画像の相対パス（./01.png など）。frameTimes と同じ順 */
  images: string[];
  /** images に対応する静止画の時刻。画像差し替え（REV-3）と保存で使う */
  frameTimes: number[];
  /** context を引いた時刻（画像の時刻）。画像差し替え時に context を引き直すのに使う */
  contextTime: number
  context: ItemContext;
  /** 由来の下書きID（トレース用） */
  draftIds: string[];
  /** 紐づくペンのID。画像を差し替えたときに文脈を引き直すのに使う */
  annotationIds: string[]
  /** 送信対象に含めるか（REV-2。要確認を外せる） */
  include: boolean
  /** 取り込んだ mtg の候補に、判定モデルが付けた確からしさ（@shared/meetingImport） */
  meetingScore?: import('@shared/meetingImport').MeetingItemScore
}

export interface FeedbackDocument {
  meta: SessionMeta
  items: FeedbackItem[]
  dropped: DroppedUtterance[];
  /** 全体への補足コメント（REV-5） */
  note?: string;
  /** 整理に LLM を使えたか。false ならルール下書きのまま（EXT-11） */
  organizedByLlm: boolean
  /**
   * 整理（LLM）が付けたレビューの短い名前。履歴の見出しの自動の名前に使う（sessions/autoName.ts）。
   * 整理していない・指摘を足した後は無い（ルールで作った名前を使う）
   */
  reviewTitle?: string
  /**
   * 確認画面で指摘を並べ替えた（ドラッグ＆ドロップ・↑↓）。true なら items の順が正本で、番号もこの順に振る。
   * 無ければ時刻順（並べ替えより前に保存したレビューも時刻順のまま読む）
   */
  customOrder?: true
}
