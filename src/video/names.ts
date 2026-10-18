/**
 * 動画づくり（旧 Solocut）の名前の正本。CLI・アプリ・テンプレート・Agent 向けの文がこの値を使う。
 * Solocut のブランドは公開をやめたので、ユーザーに見える名前は Ferret に合わせる。
 * 旧 Solocut のプロジェクト（solocut.json・.solocut/）は `ferret-video migrate` で移せる。
 * Electron にも Node の API にも依存しない（CLI・main・renderer・単体テストで共用）。
 */

/** 内蔵ターミナルの PATH に置くコマンド名 */
export const VIDEO_CLI = 'ferret-video'
/** 動画1本のプロジェクトのフォルダにある設定ファイル（旧 solocut.json） */
export const VIDEO_PROJECT_FILE = 'ferret-video.json'
/** 動画1本のプロジェクトの作業用フォルダ（旧 .solocut/） */
export const VIDEO_STATE_DIR = '.ferret-video'
/** 旧 Solocut の名前（読み取り・移行のためだけに使う） */
export const LEGACY_PROJECT_FILE = 'solocut.json'
export const LEGACY_STATE_DIR = '.solocut'
/** 環境変数の接頭辞（旧 SOLOCUT_）。例: FERRET_VIDEO_HOME, FERRET_VIDEO_FFMPEG */
export const VIDEO_ENV_PREFIX = 'FERRET_VIDEO_'
/** 利用者ごとの置き場（ツール・設定・キャッシュ）。既定は ~/.ferret/video。FERRET_VIDEO_HOME で変えられる */
export const VIDEO_HOME_ENV = 'FERRET_VIDEO_HOME'
export const VIDEO_HOME_DEFAULT_PARTS = ['.ferret', 'video'] as const
/** PATH の先頭に置くフォルダを pty に渡すための変数（src/main/terminal.ts の ptyEnv が PATH へ移して消す） */
export const VIDEO_BIN_ENV = 'FERRET_VIDEO_BIN'
/** CLI を Electron の Node で動かすための実行ファイル（ELECTRON_RUN_AS_NODE=1 で使う） */
export const VIDEO_ELECTRON_ENV = 'FERRET_VIDEO_ELECTRON'
/** 旧 Solocut の利用者ごとの置き場（~/.solocut）。中の tools/ は、新しい置き場に無いときだけ読み取り専用で使う */
export const LEGACY_HOME_PARTS = ['.solocut'] as const
/** 旧 Solocut が tools/<tool>/<version>/ に置いた目印のファイル */
export const LEGACY_TOOL_MARKER = '.solocut-tool.json'
/** 旧い tools/ の場所を変える（空にすると使わない）。既定は FERRET_VIDEO_HOME を変えていないときだけ ~/.solocut/tools */
export const VIDEO_LEGACY_TOOLS_ENV = 'FERRET_VIDEO_LEGACY_TOOLS'
