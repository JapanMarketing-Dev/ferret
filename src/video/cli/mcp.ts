import { readFileSync } from 'node:fs';
import { CLI_VERSION } from './ctx.js';

// `ferret-video mcp`: Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0), implemented directly.
// Every tool runs the matching CLI command with --json, so MCP clients and the CLI behave identically.

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  argv: (a: Record<string, unknown>) => string[];
  /** Attach the PNG at result.path as image content (frame). */
  image?: boolean;
}

const str = { type: 'string' };
const bool = { type: 'boolean' };
const project = {
  project: { type: 'string', description: 'Project folder (default: the server working directory)' },
};
const obj = (properties: Record<string, unknown>, required: string[] = []): McpTool['inputSchema'] => ({ type: 'object', properties: { ...properties, ...project }, ...(required.length ? { required } : {}), additionalProperties: false });
const s = (v: unknown) => String(v);
const opt = (flag: string, v: unknown) => (v === undefined || v === null || v === '' ? [] : [flag, s(v)]);
const flag = (f: string, v: unknown) => (v === true ? [f] : []);

export const MCP_TOOLS: McpTool[] = [
  { name: 'status', description: 'Template step progress, project overview and the next step.', inputSchema: obj({}), argv: () => ['status'] },
  { name: 'next', description: 'The one next thing to do (step, why, do, commands). Call this first and after every step.', inputSchema: obj({ autopilot: bool }), argv: (a) => ['next', '--with-prompt', ...flag('--autopilot', a.autopilot)] },
  { name: 'step', description: 'Mark a template step: todo | running | done | needs-human | skipped.', inputSchema: obj({ step: str, state: { type: 'string', enum: ['todo', 'running', 'done', 'needs-human', 'skipped'] }, note: str }, ['step', 'state']), argv: (a) => ['step', s(a.step), s(a.state), ...opt('--note', a.note)] },
  { name: 'tl_summary', description: 'Structure, counts and open items of timeline.json. Read this before anything else.', inputSchema: obj({}), argv: () => ['tl', 'summary'] },
  { name: 'tl_show', description: 'One timeline element and its neighbors.', inputSchema: obj({ id: str }, ['id']), argv: (a) => ['tl', 'show', s(a.id)] },
  { name: 'tl_range', description: 'Elements in a time range, e.g. "00:01:00-00:02:00".', inputSchema: obj({ range: str, kind: str }, ['range']), argv: (a) => ['tl', 'range', s(a.range), ...opt('--kind', a.kind)] },
  { name: 'tl_query', description: 'Filter elements, e.g. "segments[role=demo]".', inputSchema: obj({ query: str }, ['query']), argv: (a) => ['tl', 'query', s(a.query)] },
  { name: 'tl_why', description: 'Why an element is the way it is: its decided record and related history.', inputSchema: obj({ id: str }, ['id']), argv: (a) => ['tl', 'why', s(a.id)] },
  {
    name: 'edit', description: 'Apply timeline ops atomically (same ops as `ferret-video edit --ops`). Ops that need a reason must carry decided {by, reason}.',
    inputSchema: obj({ ops: { type: 'array', items: { type: 'object' } }, dryRun: bool }, ['ops']),
    argv: (a) => ['edit', '--ops', JSON.stringify(a.ops ?? []), ...flag('--dry-run', a.dryRun)],
  },
  { name: 'undo', description: 'Undo the last edit.', inputSchema: obj({}), argv: () => ['undo'] },
  { name: 'redo', description: 'Redo the last undone edit.', inputSchema: obj({}), argv: () => ['redo'] },
  { name: 'validate', description: 'Validate timeline.json (schema + semantics).', inputSchema: obj({}), argv: () => ['validate'] },
  { name: 'propose_cuts', description: 'Build segments from silence, fillers, retakes and NG markers.', inputSchema: obj({ replace: bool, dryRun: bool }), argv: (a) => ['propose', 'cuts', ...flag('--replace', a.replace), ...flag('--dry-run', a.dryRun)] },
  { name: 'captions_build', description: 'Build captions from the transcript.', inputSchema: obj({}), argv: () => ['captions', 'build'] },
  { name: 'render', description: 'Render the preview, or the final video (renders/youtube/final.mp4).', inputSchema: obj({ quality: { type: 'string', enum: ['preview', 'final'] } }), argv: (a) => ['render', a.quality === 'final' ? '--final' : '--preview'] },
  { name: 'check', description: 'Machine checks on the preview (black frames, freezes, loudness, spec); writes checks/<run>/report.md.', inputSchema: obj({}), argv: () => ['check'] },
  { name: 'multicam_material', description: 'Per segment: which cameras could show it, face visibility/gaze/sharpness, speech and emphasized words, plus the camera-switch check. Decide switches following prompts/multicam.md.', inputSchema: obj({}), argv: () => ['multicam', 'material'] },
  { name: 'split_for_switch', description: 'Split a segment at source frames where the camera should switch (then setCamera each piece).', inputSchema: obj({ segment: str, at: { type: 'array', items: { type: 'integer' } }, reason: str }, ['segment', 'at']), argv: (a) => ['edit', 'split-for-switch', '--segment', s(a.segment), '--at', (Array.isArray(a.at) ? a.at : []).join(','), ...opt('--reason', a.reason)] },
  { name: 'sfx_apply', description: 'Place sound effects from the template sfx rules (replaces earlier template-placed ones).', inputSchema: obj({ dryRun: bool }), argv: (a) => ['sfx', 'apply', ...flag('--dry-run', a.dryRun)] },
  { name: 'tracks_apply', description: 'Keep the person\'s face centred in the camera (template faceReframe), face/cursor-following zoom (and click punch-ins when the template follows clicks) plus click-ring and keystroke overlays from the input logs.', inputSchema: obj({ followClicks: bool, overlays: bool, dryRun: bool }), argv: (a) => ['tracks', 'apply', ...(a.followClicks === true ? ['--follow-clicks'] : a.followClicks === false ? ['--no-follow-clicks'] : []), ...(a.overlays === false ? ['--no-overlays'] : []), ...flag('--dry-run', a.dryRun)] },
  { name: 'masks_from_analysis', description: 'Pixelate private text found on screen (derived/analysis/pii.*.json); the masks are marked for review.', inputSchema: obj({ source: str, kinds: str, kind: { type: 'string', enum: ['pixelate', 'blur', 'fill'] }, dryRun: bool }), argv: (a) => ['masks', 'from-analysis', ...opt('--source', a.source), ...opt('--kinds', a.kinds), ...opt('--kind', a.kind), ...flag('--dry-run', a.dryRun)] },
  { name: 'thumb_pick', description: 'Use an image in the project as the video\'s thumbnail (publish.json "thumbnail").', inputSchema: obj({ image: str }, ['image']), argv: (a) => ['thumb', 'pick', s(a.image)] },
  { name: 'frame', description: 'A still of one timeline frame (frame number or timecode). Returns the image.', inputSchema: obj({ at: str, width: { type: 'integer' } }, ['at']), argv: (a) => ['frame', '--at', s(a.at), ...opt('--width', a.width ?? 960)], image: true },
  { name: 'past_list', description: 'Past videos in the archive, newest first.', inputSchema: obj({ kind: str, template: str, limit: { type: 'integer' } }), argv: (a) => ['past', 'list', ...opt('--kind', a.kind), ...opt('--template', a.template), ...opt('--limit', a.limit)] },
  { name: 'past_search', description: 'Full-text search over past videos (titles, chapters, captions).', inputSchema: obj({ query: str }, ['query']), argv: (a) => ['past', 'search', s(a.query)] },
  { name: 'past_show', description: 'Summary and stats of a past video.', inputSchema: obj({ id: str }, ['id']), argv: (a) => ['past', 'show', s(a.id)] },
  { name: 'past_timeline', description: 'Part of a past timeline.json.', inputSchema: obj({ id: str, range: str, only: str }, ['id']), argv: (a) => ['past', 'timeline', s(a.id), ...opt('--range', a.range), ...opt('--only', a.only)] },
  { name: 'past_reuse', description: 'Ops (and a template patch) that apply parts of a past video to this one.', inputSchema: obj({ id: str, what: str, apply: bool }, ['id']), argv: (a) => ['past', 'reuse', s(a.id), ...opt('--what', a.what), ...flag('--apply', a.apply)] },
  { name: 'feedback_list', description: 'Video feedback sessions.', inputSchema: obj({}), argv: () => ['feedback', 'list'] },
  { name: 'feedback_show', description: 'One feedback session (feedback.md).', inputSchema: obj({ id: str }, ['id']), argv: (a) => ['feedback', 'show', s(a.id)] },
  {
    name: 'meta_set', description: 'Write the post to publish.json: title, description (chapters and credits are added), tags, YouTube privacy, TikTok on/off. Never publishes.',
    inputSchema: obj({ title: str, description: str, tags: { type: 'array', items: str }, privacy: { type: 'string', enum: ['private', 'unlisted', 'public'] }, tiktok: bool, thumbnail: str }),
    argv: (a) => ['meta', 'set', ...opt('--title', a.title), ...opt('--description', a.description), ...(Array.isArray(a.tags) ? ['--tags', a.tags.join(',')] : []), ...opt('--privacy', a.privacy),
      ...(a.tiktok === true ? ['--tiktok'] : a.tiktok === false ? ['--no-tiktok'] : []), ...opt('--thumbnail', a.thumbnail)],
  },
  { name: 'meta_check', description: 'Validate publish.json (limits of YouTube / TikTok, files exist).', inputSchema: obj({}), argv: () => ['meta', 'check'] },
];

export type RunCli = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

interface JsonRpc { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function checkArgs(tool: McpTool, a: Record<string, unknown>): string | null {
  for (const r of tool.inputSchema.required ?? []) if (a[r] === undefined || a[r] === null || a[r] === '') return `missing argument: ${r}`;
  for (const k of Object.keys(a)) if (!(k in tool.inputSchema.properties)) return `unknown argument: ${k}`;
  return null;
}

/** A transport-free MCP server: feed it parsed messages, get responses (null for notifications). */
export function createMcpServer(run: RunCli, o: { defaultProject?: string } = {}) {
  const ok = (id: JsonRpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
  const fail = (id: JsonRpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function handle(msg: unknown): Promise<object | null> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, -32600, 'invalid request');
    const m = msg as JsonRpc;
    const isNotification = m.id === undefined;
    if (typeof m.method !== 'string') return isNotification ? null : fail(m.id, -32600, 'invalid request');
    switch (m.method) {
      case 'initialize': {
        const requested = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : PROTOCOL_VERSIONS[0]!;
        return ok(m.id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ferret-video', version: CLI_VERSION },
          instructions: 'Ferret edits videos by template. Call `next` first and follow it; read `tl_summary` before reading parts of the timeline; edit only with `edit` ops.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok(m.id, {});
      case 'tools/list':
        return ok(m.id, { tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const name = m.params?.name;
        const tool = MCP_TOOLS.find((x) => x.name === name);
        if (!tool) return fail(m.id, -32602, `unknown tool: ${String(name)}`);
        const a = (m.params?.arguments ?? {}) as Record<string, unknown>;
        if (typeof a !== 'object' || Array.isArray(a)) return fail(m.id, -32602, 'arguments must be an object');
        const bad = checkArgs(tool, a);
        if (bad) return ok(m.id, { content: [{ type: 'text', text: bad }], isError: true });
        const proj = (a.project as string | undefined) ?? o.defaultProject;
        const argv = [...tool.argv(a), '--json', ...(proj ? ['--project', proj] : [])];
        const r = await run(argv);
        const content: object[] = [{ type: 'text', text: r.stdout.trim() || r.stderr.trim() }];
        if (tool.image && r.code === 0) {
          try {
            const path = (JSON.parse(r.stdout) as { path?: string }).path;
            if (path) content.push({ type: 'image', data: readFileSync(path).toString('base64'), mimeType: 'image/png' });
          } catch {
            /* text only */
          }
        }
        return ok(m.id, { content, isError: r.code !== 0 });
      }
      default:
        return isNotification ? null : fail(m.id, -32601, `method not found: ${m.method}`);
    }
  }

  /** One raw line in, zero or one raw line out. */
  async function handleLine(line: string): Promise<string | null> {
    if (!line.trim()) return null;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return JSON.stringify(fail(null, -32700, 'parse error'));
    }
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(handle))).filter((x) => x !== null);
      return out.length ? JSON.stringify(out) : null;
    }
    const r = await handle(msg);
    return r ? JSON.stringify(r) : null;
  }

  return { handle, handleLine };
}
