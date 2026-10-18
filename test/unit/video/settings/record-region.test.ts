import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsError, defaultSettings, loadSettings, parseSettings, setSetting } from '@video/settings';
import { RecordRegionSchema } from '@video/settings/schema.js';

let home: string;
const saved = process.env.FERRET_VIDEO_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ferret-video-region-'));
  process.env.FERRET_VIDEO_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FERRET_VIDEO_HOME;
  else process.env.FERRET_VIDEO_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const R = { displayId: '1', x: 0, y: 50, width: 2880, height: 1700 };

describe('record.region', () => {
  it('defaults to null (whole display)', () => {
    expect(defaultSettings().record.region).toBeNull();
  });

  it('sets, persists and clears a region', () => {
    expect(setSetting('record.region', R).record.region).toEqual(R);
    expect(loadSettings().record.region).toEqual(R);
    expect(setSetting('record.region', null).record.region).toBeNull();
    expect(loadSettings().record.region).toBeNull();
  });

  it('sets single fields by dot path', () => {
    setSetting('record.region', R);
    expect(setSetting('record.region.width', 1280).record.region).toEqual({ ...R, width: 1280 });
  });

  it.each([
    ['negative x', { ...R, x: -1 }],
    ['negative y', { ...R, y: -2 }],
    ['too narrow', { ...R, width: 31 }],
    ['too short', { ...R, height: 0 }],
    ['fractional', { ...R, width: 100.5 }],
    ['empty display id', { ...R, displayId: '' }],
    ['numeric display id', { ...R, displayId: 1 }],
    ['missing height', { displayId: '1', x: 0, y: 0, width: 100 }],
    ['a string', 'all'],
  ])('rejects %s', (_name, value) => {
    expect(() => setSetting('record.region', value)).toThrow(SettingsError);
    expect(RecordRegionSchema.safeParse(value).success).toBe(false);
  });

  it('accepts the smallest region', () => {
    expect(RecordRegionSchema.safeParse({ ...R, width: 32, height: 32 }).success).toBe(true);
  });

  it('a broken region in the file falls back to null, keeping the other sections', () => {
    const r = parseSettings(JSON.stringify({ language: 'en', record: { region: { displayId: '1', x: 'a' } } }));
    expect(r.settings.record.region).toBeNull();
    expect(r.settings.language).toBe('en');
    expect(r.errors.some((e) => e.path.startsWith('record.region'))).toBe(true);
  });
});
