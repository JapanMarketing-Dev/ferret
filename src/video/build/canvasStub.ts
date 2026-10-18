/**
 * budoux が使う linkedom の任意の依存 canvas の代わり（ferret-video のまとめだけで使う。src/video/build/cliPlugin.ts）。
 * CLI は HTML を描かないので中身は要らない。Vite に任せると NODE_ENV によって「読むと例外」の代わりが入るため、ここで決める。
 */
export default {}
