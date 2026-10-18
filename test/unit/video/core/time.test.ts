import { describe, expect, it } from 'vitest';
import {
  convertFrames, frameToClock, frameToSeconds, frameToTimecode, nominalFps, parseFrameRange, secondsToFrame, timecodeToFrame,
} from '@video/core';

const F30 = { num: 30, den: 1 };
const F24 = { num: 24, den: 1 };
const F2997 = { num: 30000, den: 1001 };
const F60 = { num: 60, den: 1 };
const F25 = { num: 25, den: 1 };

describe('frameToTimecode', () => {
  it('formats zero and simple values', () => {
    expect(frameToTimecode(0, F30)).toBe('00:00:00:00');
    expect(frameToTimecode(29, F30)).toBe('00:00:00:29');
    expect(frameToTimecode(30, F30)).toBe('00:00:01:00');
    expect(frameToTimecode(30 * 60, F30)).toBe('00:01:00:00');
    expect(frameToTimecode(30 * 3600 + 1, F30)).toBe('01:00:00:01');
  });
  it('uses the nominal rate for 29.97', () => {
    expect(nominalFps(F2997)).toBe(30);
    expect(frameToTimecode(30, F2997)).toBe('00:00:01:00');
  });
  it('handles hours beyond 99', () => {
    expect(frameToTimecode(24 * 3600 * 100, F24)).toBe('100:00:00:00');
  });
  it('rejects negative, fractional and non-finite frames', () => {
    expect(() => frameToTimecode(-1, F30)).toThrow(RangeError);
    expect(() => frameToTimecode(1.5, F30)).toThrow(RangeError);
    expect(() => frameToTimecode(Number.NaN, F30)).toThrow(RangeError);
    expect(() => frameToTimecode(Number.POSITIVE_INFINITY, F30)).toThrow(RangeError);
  });
});

describe('timecodeToFrame', () => {
  it('round-trips HH:MM:SS:FF for many frames at several rates', () => {
    for (const fps of [F24, F25, F30, F2997, F60]) {
      for (let f = 0; f < 200_000; f += 997) {
        expect(timecodeToFrame(frameToTimecode(f, fps), fps)).toBe(f);
      }
      // boundaries around each second/minute/hour
      const r = nominalFps(fps);
      for (const f of [r - 1, r, r + 1, r * 60 - 1, r * 60, r * 3600 - 1, r * 3600]) {
        expect(timecodeToFrame(frameToTimecode(f, fps), fps)).toBe(f);
      }
    }
  });
  it('accepts a semicolon before the frame field', () => {
    expect(timecodeToFrame('00:00:01;05', F30)).toBe(35);
  });
  it('parses MM:SS and HH:MM:SS(.sss) as clock time', () => {
    expect(timecodeToFrame('01:30', F30)).toBe(90 * 30);
    expect(timecodeToFrame('1:02:03', F30)).toBe((3600 + 120 + 3) * 30);
    expect(timecodeToFrame('00:01.5', F30)).toBe(45);
    // clock time uses the real rate: 10 s at 29.97 = 299.7 → 300
    expect(timecodeToFrame('00:10', F2997)).toBe(300);
  });
  it('parses seconds and frame suffixes', () => {
    expect(timecodeToFrame('12.5', F30)).toBe(375);
    expect(timecodeToFrame('12.5s', F30)).toBe(375);
    expect(timecodeToFrame('0', F30)).toBe(0);
    expect(timecodeToFrame('123f', F30)).toBe(123);
    expect(timecodeToFrame('  2  ', F30)).toBe(60);
  });
  it('rejects malformed input', () => {
    for (const bad of ['', 'abc', '1:2:3:4:5', '00:00:00:30', '00:60:00:00', '00:00:60:00', '00:61', '-1', '1.2.3', '12ss']) {
      expect(() => timecodeToFrame(bad, F30), bad).toThrow(SyntaxError);
    }
  });
});

describe('seconds and conversions', () => {
  it('secondsToFrame/frameToSeconds round-trip on frame boundaries', () => {
    for (const fps of [F24, F30, F2997, F60]) {
      for (let f = 0; f < 50_000; f += 113) expect(secondsToFrame(frameToSeconds(f, fps), fps)).toBe(f);
    }
  });
  it('convertFrames between rates', () => {
    expect(convertFrames(60, F60, F30)).toBe(30);
    expect(convertFrames(30, F30, F60)).toBe(60);
    expect(convertFrames(0, F24, F30)).toBe(0);
    expect(convertFrames(24, F24, F30)).toBe(30);
    expect(convertFrames(30000, F2997, F30)).toBe(30030);
    expect(convertFrames(1, F60, F30)).toBe(1); // 0.5 rounds up
  });
  it('frameToClock is human readable', () => {
    expect(frameToClock(0, F30)).toBe('00:00.000');
    expect(frameToClock(95, F30)).toBe('00:03.167');
    expect(frameToClock(30 * 61, F30)).toBe('01:01.000');
  });
  it('parseFrameRange', () => {
    expect(parseFrameRange('00:03:00:00-00:04:00:00', F30)).toEqual([5400, 7200]);
    expect(parseFrameRange('10-20', F30)).toEqual([300, 600]);
    expect(() => parseFrameRange('20-10', F30)).toThrow(RangeError);
    expect(() => parseFrameRange('10', F30)).toThrow(SyntaxError);
  });
});
