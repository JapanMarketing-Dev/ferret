import type { VideoLibraryIpc, VideoLibraryEvents } from './ipc/library'
import { VIDEO_LIBRARY_REQUESTS, VIDEO_LIBRARY_EVENTS } from './ipc/library'
import type { VideoRecordIpc, VideoRecordEvents } from './ipc/record'
import { VIDEO_RECORD_REQUESTS, VIDEO_RECORD_EVENTS } from './ipc/record'
import type { VideoReviewIpc, VideoReviewEvents } from './ipc/review'
import { VIDEO_REVIEW_REQUESTS, VIDEO_REVIEW_EVENTS } from './ipc/review'
import type { VideoPublishIpc, VideoPublishEvents } from './ipc/publish'
import { VIDEO_PUBLISH_REQUESTS, VIDEO_PUBLISH_EVENTS } from './ipc/publish'

/**
 * 動画づくりの IPC（renderer ⇄ main）。src/shared/ipc.ts の IpcRequests / IpcEvents がこれを継ぐ。
 * チャネル名はすべて `video:` で始める。機能ごとのファイル（ipc/*.ts）が正本。
 */
export interface VideoIpcRequests extends VideoLibraryIpc, VideoRecordIpc, VideoReviewIpc, VideoPublishIpc {}
export interface VideoIpcEvents extends VideoLibraryEvents, VideoRecordEvents, VideoReviewEvents, VideoPublishEvents {}

export type VideoIpcRequestChannel = keyof VideoIpcRequests
export type VideoIpcEventChannel = keyof VideoIpcEvents

export const VIDEO_IPC_REQUEST_CHANNELS = [
  ...VIDEO_LIBRARY_REQUESTS, ...VIDEO_RECORD_REQUESTS, ...VIDEO_REVIEW_REQUESTS, ...VIDEO_PUBLISH_REQUESTS
] as const satisfies readonly VideoIpcRequestChannel[]

export const VIDEO_IPC_EVENT_CHANNELS = [
  ...VIDEO_LIBRARY_EVENTS, ...VIDEO_RECORD_EVENTS, ...VIDEO_REVIEW_EVENTS, ...VIDEO_PUBLISH_EVENTS
] as const satisfies readonly VideoIpcEventChannel[]
