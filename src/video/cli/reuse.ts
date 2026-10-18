import type { ArchiveEntry, ArchiveStats } from '@video/archive';
import type { Decided, Op, Scene, Sfx, Source, Timeline } from '@video/core';
import { allIds, freshId } from '@video/core';

// `past reuse` (docs/17): turn parts of a past video's design into ops for the current timeline, plus a template patch
// for what lives in the template (pacing, caption style). Pure; the CLI prints or applies the result.

export const REUSE_PARTS = ['pacing', 'scenes', 'captions', 'sfx', 'thumbnail-style'] as const;
export type ReusePart = (typeof REUSE_PARTS)[number];

export interface ReuseResult {
  ops: Op[];
  /** YAML-ready object to merge into the project's template (templates/<id>/template.yaml with `extends`). */
  templatePatch: Record<string, unknown>;
  notes: string[];
  skipped: string[];
}

const durOf = (t: Timeline) => t.segments.reduce((m, s) => Math.max(m, s.range.end), 0);

export function planReuse(
  past: { entry: ArchiveEntry; timeline: Timeline; stats: ArchiveStats },
  cur: Timeline,
  curStats: ArchiveStats,
  what: ReusePart[],
  o: { lang: 'ja' | 'en'; by: Decided['by']; agent?: string },
): ReuseResult {
  const ja = o.lang === 'ja';
  const id = past.entry.id;
  const decided = (reason: string): Decided => ({ by: o.by, ...(o.agent && o.by === 'agent' ? { agent: o.agent } : {}), reason, needsReview: true });
  const ops: Op[] = [];
  const notes: string[] = [];
  const skipped: string[] = [];
  const templatePatch: Record<string, unknown> = {};
  const curDur = durOf(cur);
  const pastDur = durOf(past.timeline);
  const taken = allIds(cur);
  const sourcesToCopy = new Map<string, Source>();
  const needSource = (sid: string): boolean => {
    if (cur.sources[sid]) return true;
    const s = past.timeline.sources[sid];
    if (s?.kind === 'asset') {
      sourcesToCopy.set(sid, s);
      return true;
    }
    return false;
  };

  if (what.includes('pacing')) {
    const a = past.stats;
    const b = curStats;
    notes.push(ja
      ? `テンポ: 過去の回は区間の平均 ${a.avgSegmentSec} 秒・切った割合 ${Math.round(a.cutRatio * 100)}%（今は ${b.avgSegmentSec} 秒・${Math.round(b.cutRatio * 100)}%）`
      : `pacing: past avg segment ${a.avgSegmentSec}s, cut ${Math.round(a.cutRatio * 100)}% (now ${b.avgSegmentSec}s, ${Math.round(b.cutRatio * 100)}%)`);
    // tighter past cuts → shorter silences get removed; scale the silence threshold by the ratio of average segment length
    if (a.avgSegmentSec > 0 && b.avgSegmentSec > 0) {
      const ratio = Math.max(0.5, Math.min(2, a.avgSegmentSec / b.avgSegmentSec));
      if (Math.abs(ratio - 1) > 0.15) {
        templatePatch.cut = { silence: { minMs: Math.round(Math.max(150, Math.min(1500, 400 * ratio)) / 10) * 10 } };
        notes.push(ja ? `cut.silence.minMs を調整する案を出しました（${ratio < 1 ? '詰める' : '緩める'}方向）。適用したら \`ferret-video propose cuts --replace\`` : `suggested cut.silence.minMs (${ratio < 1 ? 'tighter' : 'looser'}); after applying run \`ferret-video propose cuts --replace\``);
      }
    }
    if (a.jumpCutsPerMin > 0 && a.zooms > 0) {
      const every = Math.max(1, Math.round(a.segments / Math.max(1, a.zooms)));
      templatePatch.cut = { ...(templatePatch.cut as object | undefined), jumpZoom: { every, scale: 1.12 } };
    }
  }

  if (what.includes('scenes')) {
    if (!curDur || !pastDur) skipped.push(ja ? 'シーン: 区間がまだないので位置を決められません' : 'scenes: no segments yet');
    else {
      for (const sc of past.timeline.scenes) {
        const len = sc.range.end - sc.range.start;
        const start = Math.round((sc.range.start / pastDur) * curDur);
        const end = Math.min(curDur, start + len);
        if (end <= start) continue;
        const slots: Scene['slots'] = {};
        for (const [k, v] of Object.entries(sc.slots)) {
          if ((v.kind === 'image' && !needSource(v.asset)) || (v.kind === 'video' && !cur.sources[v.source])) continue;
          slots[k] = v;
        }
        const nid = taken.has(sc.id) ? freshId(`scn_reuse`, taken) : sc.id;
        taken.add(nid);
        ops.push({ op: 'addScene', scene: { ...sc, id: nid, range: { start, end }, slots, decided: decided(ja ? `${id} のシーン ${sc.pattern.id} を同じ位置（全体の ${Math.round((sc.range.start / pastDur) * 100)}%）に。中身は今回の話に合わせて直す` : `scene ${sc.pattern.id} from ${id} at the same relative position; adapt its content`) } });
      }
      if (!past.timeline.scenes.length) skipped.push(ja ? 'シーン: 過去の回にシーンがありません' : 'scenes: the past video has none');
    }
  }

  if (what.includes('captions')) {
    const styles = new Map<string, number>();
    for (const c of past.timeline.captions) styles.set(c.style, (styles.get(c.style) ?? 0) + 1);
    const style = [...styles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!style) skipped.push(ja ? '字幕: 過去の回に字幕がありません' : 'captions: the past video has none');
    else {
      templatePatch.captions = { style };
      for (const c of cur.captions) if (c.style !== style) ops.push({ op: 'updateCaption', id: c.id, patch: { style } });
      notes.push(ja ? `字幕: スタイル ${style}、強調の割合 ${Math.round(past.stats.emphasisRatio * 100)}%（今は ${Math.round(curStats.emphasisRatio * 100)}%）` : `captions: style ${style}, emphasis ${Math.round(past.stats.emphasisRatio * 100)}% (now ${Math.round(curStats.emphasisRatio * 100)}%)`);
    }
  }

  if (what.includes('sfx')) {
    const starts = {
      section: cur.outline.map((c) => c.start),
      'scene-in': [...cur.scenes.map((s) => s.range.start), ...ops.filter((x): x is Extract<Op, { op: 'addScene' }> => x.op === 'addScene').map((x) => x.scene.range.start)],
      cut: cur.segments.slice(1).map((s) => s.range.start),
    };
    const byTrigger = new Map<string, Sfx>();
    for (const s of past.timeline.audio.sfx) if (!byTrigger.has(s.trigger)) byTrigger.set(s.trigger, s);
    const used = new Set(cur.audio.sfx.map((s) => `${s.asset}@${s.at}`));
    for (const [trigger, tmpl] of byTrigger) {
      const ats = trigger in starts ? starts[trigger as keyof typeof starts] : [];
      if (!ats.length || !needSource(tmpl.asset)) {
        skipped.push(ja ? `効果音 ${trigger}: 当てはめる位置がありません（人が選ぶもの）` : `sfx ${trigger}: no matching positions (manual)`);
        continue;
      }
      // keep the past rate for this trigger
      const pastCount = past.timeline.audio.sfx.filter((s) => s.trigger === trigger).length;
      const pastPositions = trigger === 'section' ? past.timeline.outline.length : trigger === 'scene-in' ? past.timeline.scenes.length : Math.max(1, past.timeline.segments.length - 1);
      const rate = Math.min(1, pastCount / Math.max(1, pastPositions));
      const step = rate > 0 ? Math.max(1, Math.round(1 / rate)) : Infinity;
      ats.forEach((at, i) => {
        if (i % step !== 0 || at >= curDur || used.has(`${tmpl.asset}@${at}`)) return;
        const nid = freshId('sfx_reuse', taken);
        taken.add(nid);
        ops.push({ op: 'addSfx', sfx: { ...tmpl, id: nid, at, decided: decided(ja ? `${id} と同じく ${trigger} で効果音` : `sfx on ${trigger} as in ${id}`) } });
      });
    }
    if (!past.timeline.audio.sfx.length) skipped.push(ja ? '効果音: 過去の回に効果音がありません' : 'sfx: the past video has none');
  }

  if (what.includes('thumbnail-style')) {
    notes.push(past.entry.thumbnail
      ? (ja ? `サムネイル: ~/.ferret/video/archive/${id}/${past.entry.thumbnail} を参考にする（ferret-video thumb gen --reference で渡せます）` : `thumbnail: use ~/.ferret/video/archive/${id}/${past.entry.thumbnail} as the reference`)
      : (ja ? 'サムネイル: 過去の回にサムネイルが保存されていません' : 'thumbnail: the past video has no stored thumbnail'));
  }

  // copied asset sources go first so the added elements can reference them
  const sourceOps: Op[] = [...sourcesToCopy].map(([sid, s]) => ({ op: 'addSource', id: sid, source: s }));
  const refs = cur.meta.references.filter((r) => r.archive !== id);
  const use = what.map((w) => (w === 'thumbnail-style' ? 'thumbnail-style' : w)) as Timeline['meta']['references'][number]['use'];
  const refOp: Op = { op: 'setMeta', patch: { references: [...refs, { archive: id as `arc_${string}`, use, note: ja ? 'past reuse で取り込んだ' : 'applied with past reuse' }] } };
  return { ops: [...sourceOps, refOp, ...ops], templatePatch, notes, skipped };
}
