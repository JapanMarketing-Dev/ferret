/** 内蔵ブラウザを browser-use で動かすためにターミナルへ渡す環境変数の名前（main の browserAutomation.ts・terminal.ts） */
export const BROWSER_CDP_ENV = 'FERRET_BROWSER_CDP_URL'
/** browser-use（browser-harness）が読む CDP の HTTP の口 */
export const BU_CDP_ENV = 'BU_CDP_URL'
/** ferret-browser のフォルダ（terminal.ts が PATH の先頭に置き、この変数は消す） */
export const BROWSER_BIN_ENV = 'FERRET_BROWSER_BIN'
