import type { CheckFinding, Target } from '@video/core';
import { PRESETS } from '@video/core';
import { detectBlack, detectFreeze, measureLoudness } from './analyze.js';
import type { ProbeResult } from './probe.js';
import { probe } from './probe.js';

/** Spec compliance of a probed render against a target preset (pure; exported for tests). */
export function specFinding(p: ProbeResult, target?: Target): CheckFinding {
  const preset = target ? PRESETS[target] : undefined;
  const problems: string[] = [];
  const v = p.streams.find((s) => s.type === 'video');
  const a = p.streams.find((s) => s.type === 'audio');
  const measured: Record<string, number | string | null> = { durationSec: Math.round(p.durationSec * 1000) / 1000, container: p.formatName };
  if (!v) problems.push('no video stream');
  else {
    measured.videoCodec = v.codec;
    measured.width = v.width ?? null;
    measured.height = v.height ?? null;
    measured.fps = v.fps ? Math.round((v.fps.num / v.fps.den) * 1000) / 1000 : null;
    measured.pixFmt = v.pixFmt ?? null;
    if (v.codec !== 'h264') problems.push(`video codec ${v.codec} (expected h264)`);
    if (v.pixFmt && v.pixFmt !== 'yuv420p') problems.push(`pixel format ${v.pixFmt} (expected yuv420p)`);
    if (preset?.size && (v.width !== preset.size.width || v.height !== preset.size.height)) {
      problems.push(`size ${v.width}x${v.height} (expected ${preset.size.width}x${preset.size.height})`);
    }
    if (v.vfr) problems.push('variable frame rate');
  }
  if (!a) problems.push('no audio stream');
  else {
    measured.audioCodec = a.codec;
    measured.sampleRate = a.sampleRate ?? null;
    measured.channels = a.channels ?? null;
    if (a.codec !== 'aac') problems.push(`audio codec ${a.codec} (expected aac)`);
    if (a.sampleRate !== 48000) problems.push(`sample rate ${a.sampleRate} (expected 48000)`);
    if (a.channels !== 2) problems.push(`${a.channels} audio channels (expected stereo)`);
  }
  if (preset?.maxDurationSec && p.durationSec > preset.maxDurationSec + 0.05) {
    problems.push(`duration ${p.durationSec.toFixed(1)} s exceeds the ${preset.label} limit of ${preset.maxDurationSec} s`);
  }
  return {
    check: 'spec',
    status: problems.length ? 'fail' : 'pass',
    note: problems.length ? problems.join('; ') : `meets ${preset ? preset.label : 'basic H.264/AAC'} spec`,
    measured,
  };
}

export function loudnessFinding(m: { integrated: number; truePeak: number; lra: number }, target?: Target): CheckFinding {
  const L = (target ? PRESETS[target] : PRESETS.youtube).loudness;
  const measured = {
    integrated: Number.isFinite(m.integrated) ? m.integrated : null,
    truePeak: Number.isFinite(m.truePeak) ? m.truePeak : null,
    lra: Number.isFinite(m.lra) ? m.lra : null,
    target: L.integrated,
    targetTruePeak: L.truePeak,
  };
  if (!Number.isFinite(m.integrated)) return { check: 'loudness', status: 'fail', note: 'audio is silent', measured };
  const problems: string[] = [];
  if (Math.abs(m.integrated - L.integrated) > 1) problems.push(`integrated ${m.integrated.toFixed(1)} LUFS (target ${L.integrated} ±1)`);
  if (m.truePeak > L.truePeak + 0.5) problems.push(`true peak ${m.truePeak.toFixed(1)} dBTP (max ${L.truePeak})`);
  return { check: 'loudness', status: problems.length ? 'fail' : 'pass', note: problems.join('; ') || `${m.integrated.toFixed(1)} LUFS, ${m.truePeak.toFixed(1)} dBTP`, measured };
}

/** Mechanical checks of a rendered file: black frames, freezes, loudness, spec. */
export async function runMachineChecks(rendered: string, o: { target?: Target } = {}): Promise<CheckFinding[]> {
  const p = await probe(rendered);
  const hasVideo = p.streams.some((s) => s.type === 'video');
  const hasAudio = p.streams.some((s) => s.type === 'audio');
  const [black, freeze, loud] = await Promise.all([
    hasVideo ? detectBlack(rendered, { minSec: 0.5 }) : Promise.resolve(null),
    hasVideo ? detectFreeze(rendered, { minSec: 2 }) : Promise.resolve(null),
    hasAudio ? measureLoudness(rendered) : Promise.resolve(null),
  ]);
  const findings: CheckFinding[] = [];
  const ranges = (name: 'black-frames' | 'freeze', r: { start: number; end: number }[] | null, what: string): CheckFinding => {
    if (r === null) return { check: name, status: 'fail', note: 'no video stream' };
    if (r.length === 0) return { check: name, status: 'pass', note: `no ${what}` };
    // Could be intentional (fade to black, a still slide): a human or the decision model decides.
    return { check: name, status: 'needs-human', note: `${r.length} ${what} range(s)`, ranges: r };
  };
  findings.push(ranges('black-frames', black, 'black'));
  findings.push(ranges('freeze', freeze, 'frozen'));
  findings.push(loud ? loudnessFinding(loud, o.target) : { check: 'loudness', status: 'fail', note: 'no audio stream' });
  findings.push(specFinding(p, o.target));
  return findings;
}
