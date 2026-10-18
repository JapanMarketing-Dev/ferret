import { describe, expect, it } from 'vitest';
import { emptyTimeline, type Caption, type Timeline } from '@video/core';
import {
  buildItems, captionBox, feedbackMarkdown, frameAt, overlayBox, splitRemarks, strokesAss, strokesBox, targetsAt, type FeedbackSession,
} from '@video/cli/feedback.js';
import { MCP_TOOLS, createMcpServer } from '@video/cli/mcp.js';

const fps = { num: 30, den: 1 };
const decided = { by: 'rule' as const, reason: 't' };

function tl(): Timeline {
  const t = emptyTimeline({ title: 'x', kind: 'talk', template: { id: 'talk-youtube', version: '1' }, canvas: { width: 1920, height: 1080, fps }, language: 'ja', targets: ['youtube'] });
  t.sources.cam = { kind: 'camera', path: 'a.mp4', take: 'take_1', role: 'front', fps, size: { width: 1920, height: 1080 }, offset: 0 };
  t.outline = [{ id: 'ch_1', title: 'c', start: 0, end: 600, points: [], importance: 'core' }];
  t.segments = [
    { id: 'seg_1', range: { start: 0, end: 300 }, src: { from: 0, to: 300, take: 'take_1' }, text: '最初の話', chapter: 'ch_1', role: 'explain', video: { layout: 'camera-full', camera: 'cam' }, decided },
    { id: 'seg_2', range: { start: 300, end: 600 }, src: { from: 400, to: 700, take: 'take_1' }, text: '次の話', chapter: 'ch_1', role: 'explain', video: { layout: 'camera-full', camera: 'cam' }, decided },
  ];
  const cap = (id: string, start: number, end: number, text: string): Caption => ({
    id, range: { start, end }, text, spoken: text, words: [], lines: [text], emphasis: [], style: 'youtube-clean', position: { anchor: 'bottom', y: 0.92 }, decided,
  });
  t.captions = [cap('cap_1', 0, 100, 'この設定を変えると'), cap('cap_2', 100, 200, '速くなります')];
  t.overlays = [{ kind: 'logo', id: 'ov_1', range: { start: 0, end: 600 }, asset: 'cam', corner: 'tr' }];
  return t;
}

describe('playback → frame', () => {
  const s: FeedbackSession = { schema: 1, playback: [{ atMs: 1000, state: 'playing', frame: 0 }, { atMs: 3000, state: 'paused', frame: 60 }, { atMs: 5000, state: 'playing', frame: 300 }] };
  it('follows play, pause and seek', () => {
    expect(frameAt(s, 0, fps)).toBe(0);
    expect(frameAt(s, 2000, fps)).toBe(30);
    expect(frameAt(s, 4000, fps)).toBe(60);
    expect(frameAt(s, 6000, fps)).toBe(330);
    expect(frameAt({ schema: 1 }, 5000, fps)).toBe(0);
  });
});

describe('remarks and items', () => {
  const words = [
    { w: 'ここ、', start: 0.0, end: 0.4 }, { w: '字幕が', start: 0.4, end: 0.8 }, { w: '顔に', start: 0.8, end: 1.1 }, { w: 'かぶってる。', start: 1.1, end: 1.6 },
    { w: 'あと', start: 3.0, end: 3.3 }, { w: 'ロゴが', start: 3.3, end: 3.7 }, { w: '大きい', start: 3.7, end: 4.1 },
  ];
  it('splits on pauses and sentence ends', () => {
    const r = splitRemarks(words, 1000, 'ja');
    expect(r.map((x) => x.text)).toEqual(['ここ、字幕が顔にかぶってる。', 'あとロゴが大きい']);
    expect(r[0]).toMatchObject({ startMs: 1000, endMs: 2600 });
    expect(splitRemarks([{ w: 'Hello', start: 0, end: 0.3 }, { w: 'world.', start: 0.3, end: 0.6 }], 0, 'en')[0]!.text).toBe('Hello world.');
    expect(splitRemarks([], 0, 'ja')).toEqual([]);
  });

  it('strokes join the nearest remark; far strokes and notes become their own items', () => {
    const s: FeedbackSession = {
      schema: 1, playback: [{ atMs: 0, state: 'paused', frame: 50 }],
      strokes: [
        { startMs: 1500, endMs: 1900, frame: 50, points: [[0.3, 0.85], [0.7, 0.95]] },
        { startMs: 30_000, endMs: 30_500, points: [[0.9, 0.05], [0.98, 0.15]] },
        { startMs: 31_000, endMs: 31_100, points: [] },
      ],
      notes: [{ atMs: 4500, text: 'BGM 小さく' }, { atMs: 60_000, text: '最後のまとめを短く', frame: 590 }],
    };
    const items = buildItems(s, splitRemarks(words, 1000, 'ja'), fps);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ speech: 'ここ、字幕が顔にかぶってる。', frame: 50 });
    expect(items[0]!.strokes).toHaveLength(1);
    expect(items[1]!.notes).toEqual(['BGM 小さく']);
    expect(items[2]).toMatchObject({ speech: '', frame: 50 });
    expect(items[3]).toMatchObject({ notes: ['最後のまとめを短く'], frame: 590 });
  });
});

describe('what is under the pen', () => {
  it('captions by geometry; segments always; logo by its corner', () => {
    const t = tl();
    const bottom = [{ startMs: 0, endMs: 1, points: [[0.35, 0.8], [0.65, 0.9]] as [number, number][] }];
    const ids = targetsAt(t, 50, bottom, 'ja').map((x) => x.id);
    expect(ids).toEqual(['cap_1', 'seg_1']);
    const corner = [{ startMs: 0, endMs: 1, points: [[0.93, 0.03], [0.99, 0.12]] as [number, number][] }];
    expect(targetsAt(t, 50, corner, 'ja').map((x) => x.id)).toEqual(['ov_1', 'seg_1']);
    // no strokes → everything at that frame
    expect(targetsAt(t, 150, [], 'en').map((x) => x.id)).toEqual(['cap_2', 'ov_1', 'seg_1']);
    expect(targetsAt(t, 150, [], 'en')[0]!.label).toBe('caption cap_2 ("速くなります")');
    expect(targetsAt(t, 150, [], 'ja')[0]!.label).toBe('字幕 cap_2（「速くなります」）');
    // beyond the timeline nothing is found
    expect(targetsAt(t, 5000, [], 'ja')).toEqual([]);
  });

  it('boxes', () => {
    const t = tl();
    const b = captionBox(t.captions[0]!, 1920, 1080);
    expect(b.y + b.h).toBeCloseTo(0.92 * 1080, 5);
    expect(b.x + b.w / 2).toBeCloseTo(960, 5);
    expect(overlayBox(t.overlays[0]!, 1920, 1080).x).toBeGreaterThan(1700);
    expect(strokesBox([], 10, 10)).toBeNull();
    expect(strokesBox([{ startMs: 0, endMs: 0, points: [[0.5, 0.5]] }], 100, 100)).toEqual({ x: 50, y: 50, w: 1, h: 1 });
  });

  it('strokes ASS is an unfilled back-and-forth path in the stroke color', () => {
    const ass = strokesAss([{ startMs: 0, endMs: 1, color: '#00FF00', points: [[0, 0], [0.5, 0.5], [1, 1]] }], 100, 100);
    expect(ass).toContain('m 0 0 l 50 50 100 100 50 50');
    expect(ass).toContain('\\3c&H00FF00&');
    expect(ass).toContain('\\1a&HFF&');
  });

  it('feedback.md follows docs/04', () => {
    const t = tl();
    const md = feedbackMarkdown('fb_1', [
      { index: 3, atMs: 0, frame: 50, speech: 'ここ、字幕が顔にかぶってて見づらい', strokes: [{ startMs: 0, endMs: 1, points: [[0.1, 0.1]] }], notes: [], targets: targetsAt(t, 50, [], 'ja'), title: '字幕が顔にかかっている', request: 'この区間の字幕を下へずらす' },
      { index: 4, atMs: 0, frame: 120, speech: '', strokes: [], notes: ['メモ'], targets: [] },
    ], t, 'ja');
    expect(md).toContain('## 3. [00:00:01:20] 字幕が顔にかかっている');
    expect(md).toContain('- 要望: この区間の字幕を下へずらす');
    expect(md).toContain('- 発話（原文）: 「ここ、字幕が顔にかぶってて見づらい」');
    expect(md).toContain('- 画像: ./03.png（ペンの囲み入り）');
    expect(md).toContain('字幕 cap_1（「この設定を変えると」）');
    expect(md).toContain('## 4. [00:00:04:00] メモ');
    expect(md).toContain('（未整理）');
    expect(md).toContain('ferret-video feedback done fb_1');
  });
});

describe('mcp server', () => {
  const calls: string[][] = [];
  const server = createMcpServer(async (argv) => {
    calls.push(argv);
    if (argv[0] === 'frame') return { code: 0, stdout: JSON.stringify({ ok: true, path: '/nonexistent.png' }), stderr: '' };
    if (argv[0] === 'undo') return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'nothing-to-undo' } }), stderr: '' };
    return { code: 0, stdout: JSON.stringify({ ok: true, argv }), stderr: '' };
  }, { defaultProject: '/p' });

  it('initialize negotiates the protocol version and advertises tools', async () => {
    const r = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })) as { result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } } };
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe('ferret-video');
    const unknown = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as { result: { protocolVersion: string } };
    expect(unknown.result.protocolVersion).toBe('2025-06-18');
  });

  it('tools/list has a schema for every tool', async () => {
    const r = (await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
    expect(r.result.tools.map((x) => x.name)).toEqual(MCP_TOOLS.map((x) => x.name));
    for (const name of ['status', 'next', 'tl_summary', 'tl_show', 'tl_range', 'tl_query', 'edit', 'render', 'check', 'frame', 'past_list', 'past_show']) expect(r.result.tools.map((x) => x.name)).toContain(name);
    for (const t of r.result.tools) expect(t.inputSchema.type).toBe('object');
  });

  it('tools/call maps to CLI argv with --json and the project', async () => {
    const r = (await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'edit', arguments: { ops: [{ op: 'setMeta', patch: {} }], dryRun: true } } })) as { result: { content: { type: string; text: string }[]; isError: boolean } };
    expect(r.result.isError).toBe(false);
    expect(calls.at(-1)).toEqual(['edit', '--ops', '[{"op":"setMeta","patch":{}}]', '--dry-run', '--json', '--project', '/p']);
    await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'render', arguments: { quality: 'final', project: '/other' } } });
    expect(calls.at(-1)).toEqual(['render', '--final', '--json', '--project', '/other']);
    await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'meta_set', arguments: { title: 'T', tags: ['a', 'b'], privacy: 'unlisted', tiktok: true } } });
    expect(calls.at(-1)).toEqual(['meta', 'set', '--title', 'T', '--tags', 'a,b', '--privacy', 'unlisted', '--tiktok', '--json', '--project', '/p']);
    await server.handle({ jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'meta_check', arguments: {} } });
    expect(calls.at(-1)).toEqual(['meta', 'check', '--json', '--project', '/p']);
    await server.handle({ jsonrpc: '2.0', id: 63, method: 'tools/call', params: { name: 'check', arguments: {} } });
    expect(calls.at(-1)).toEqual(['check', '--json', '--project', '/p']);
  });

  it('one video: no derive tool, no variant argument', async () => {
    const names = MCP_TOOLS.map((x) => x.name);
    expect(names).not.toContain('derive');
    for (const t of MCP_TOOLS) expect(Object.keys(t.inputSchema.properties)).not.toContain('variant');
    const n = calls.length;
    const r = (await server.handle({ jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: 'tl_summary', arguments: { variant: 'tiktok' } } })) as { result: { isError: boolean } };
    expect(r.result.isError).toBe(true);
    expect(calls.length).toBe(n);
    const d = (await server.handle({ jsonrpc: '2.0', id: 64, method: 'tools/call', params: { name: 'derive', arguments: {} } })) as { error?: { code: number } };
    expect(d.error?.code).toBe(-32602);
  });

  it('CLI failures become isError results; bad args are reported without running', async () => {
    const n = calls.length;
    const fail = (await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'undo', arguments: {} } })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(fail.result.isError).toBe(true);
    expect(fail.result.content[0]!.text).toContain('nothing-to-undo');
    const missing = (await server.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'tl_show', arguments: {} } })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(missing.result).toMatchObject({ isError: true, content: [{ text: 'missing argument: id' }] });
    const extra = (await server.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'status', arguments: { evil: 1 } } })) as { result: { isError: boolean } };
    expect(extra.result.isError).toBe(true);
    expect(calls.length).toBe(n + 1);
    const frame = (await server.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'frame', arguments: { at: '10' } } })) as { result: { content: unknown[] } };
    expect(frame.result.content).toHaveLength(1); // image missing on disk → text only
  });

  it('protocol errors, notifications, ping and batches', async () => {
    expect(await server.handleLine('{oops')).toBe(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
    expect(await server.handleLine('')).toBeNull();
    expect(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull();
    expect(JSON.parse((await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' })))!)).toEqual({ jsonrpc: '2.0', id: 11, result: {} });
    expect(JSON.parse((await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'resources/list' })))!).error.code).toBe(-32601);
    expect(JSON.parse((await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'nope' } })))!).error.code).toBe(-32602);
    expect(JSON.parse((await server.handleLine('[1]'))!)[0].error.code).toBe(-32600);
    const batch = JSON.parse((await server.handleLine(JSON.stringify([{ jsonrpc: '2.0', id: 14, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])))!);
    expect(batch).toEqual([{ jsonrpc: '2.0', id: 14, result: {} }]);
  });
});
