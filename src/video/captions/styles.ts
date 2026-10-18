import type { Caption } from '@video/core';

export interface CaptionStyle {
  id: string;
  label: { ja: string; en: string };
  font: string;
  /** Font size as a fraction of the canvas short side. */
  size: number;
  bold: boolean;
  /** Font weight (100–900) applied with \b<weight>; overrides `bold` when set (Noto Sans JP ships 400/700/900). */
  weight?: number;
  /** Text color (#RRGGBB or #RRGGBBAA). With karaoke: the not-yet-spoken color. */
  color: string;
  /** Karaoke: color of spoken words. */
  highlight: string;
  outline: string;
  /** Outline width as a fraction of the font size. */
  outlineWidth: number;
  /** Shadow depth as a fraction of the font size. */
  shadow: number;
  /** Opaque box behind the text (ASS BorderStyle 3) in this color. */
  box?: string;
  /** Word-by-word highlight with ASS \k. */
  karaoke: boolean;
  emphasis: { color: string; scale: number; box: string };
  position: Caption['position'];
  maxCharsPerLine: { ja: number; en: number };
  maxLines: number;
  /** Letter spacing in pixels at 1080 short side. */
  spacing?: number;
}

/** Built-in caption styles. Fonts are OFL fonts bundled with the app (docs/06). */
export const CAPTION_STYLES: Record<string, CaptionStyle> = {
  // the default of the tech template: popular Japanese tech YouTube — heavy gothic, white with a thick dark outline,
  // bottom centre ~8 % above the edge, 16–18 characters a line, key terms in yellow
  'tech-bold': {
    id: 'tech-bold',
    label: { ja: '解説動画（極太・白文字に太い縁・キーワード黄色）', en: 'Tech bold (white, thick outline, yellow keywords)' },
    font: 'Noto Sans JP',
    size: 0.06,
    bold: true,
    weight: 900,
    color: '#FFFFFF',
    highlight: '#FFFFFF',
    outline: '#101418',
    outlineWidth: 0.16,
    shadow: 0.04,
    karaoke: false,
    emphasis: { color: '#FFE600', scale: 1.08, box: '#FFE600' },
    position: { anchor: 'bottom', y: 0.92 },
    maxCharsPerLine: { ja: 18, en: 34 },
    maxLines: 2,
  },
  'tiktok-bold': {
    id: 'tiktok-bold',
    label: { ja: 'ショート向け（太字・黄色ハイライト）', en: 'Shorts bold (yellow highlight)' },
    font: 'Noto Sans JP',
    size: 0.075,
    bold: true,
    weight: 900,
    color: '#FFFFFF',
    highlight: '#FFE600',
    outline: '#000000',
    outlineWidth: 0.14,
    shadow: 0.04,
    karaoke: true,
    emphasis: { color: '#FF3B30', scale: 1.2, box: '#FFE600' },
    position: { anchor: 'bottom', y: 0.7 },
    maxCharsPerLine: { ja: 11, en: 20 },
    maxLines: 2,
  },
  'youtube-clean': {
    id: 'youtube-clean',
    label: { ja: 'YouTube 標準（白・細い縁）', en: 'YouTube clean' },
    font: 'Noto Sans JP',
    size: 0.05,
    bold: true,
    weight: 700,
    color: '#FFFFFF',
    highlight: '#FFFFFF',
    outline: '#000000',
    outlineWidth: 0.08,
    shadow: 0.03,
    karaoke: false,
    emphasis: { color: '#FFD60A', scale: 1.1, box: '#FFD60A' },
    position: { anchor: 'bottom', y: 0.92 },
    maxCharsPerLine: { ja: 22, en: 40 },
    maxLines: 2,
  },
  boxed: {
    id: 'boxed',
    label: { ja: '帯付き（読みやすさ優先）', en: 'Boxed' },
    font: 'Noto Sans JP',
    size: 0.05,
    bold: false,
    color: '#FFFFFF',
    highlight: '#FFFFFF',
    outline: '#000000',
    outlineWidth: 0.25,
    shadow: 0,
    box: '#000000B0',
    karaoke: false,
    emphasis: { color: '#4CD964', scale: 1.1, box: '#4CD964' },
    position: { anchor: 'bottom', y: 0.9 },
    maxCharsPerLine: { ja: 20, en: 38 },
    maxLines: 2,
  },
};

/** What a benchmark measured about a reference's captions (template `captionLook`, core profileToTemplatePatch). */
export interface CaptionLook { size: number; fill?: string; stroke?: { color: string; widthRatio: number }; box: boolean; emphasisColor?: string; emphasisScale?: number }

const HEX = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

/**
 * A style adjusted toward a reference's look: font size from the measured line height (a line box is ~1.25× the
 * font size; kept between 4.5 % and 9 % so text is never tiny or huge), fill / outline / box / emphasis colors when
 * measured and valid. Fields that were not measured keep the style's own.
 */
export function styleWithLook(style: CaptionStyle, look: CaptionLook | undefined): CaptionStyle {
  if (!look) return style;
  const size = Number.isFinite(look.size) && look.size > 0 ? Math.min(0.09, Math.max(0.045, Math.round((look.size / 1.25) * 1000) / 1000)) : style.size;
  return {
    ...style,
    size,
    ...(look.fill && HEX.test(look.fill) ? { color: look.fill, highlight: style.karaoke ? style.highlight : look.fill } : {}),
    ...(look.stroke && HEX.test(look.stroke.color) ? { outline: look.stroke.color, ...(look.stroke.widthRatio > 0 ? { outlineWidth: Math.min(0.25, look.stroke.widthRatio) } : {}) } : {}),
    ...(look.box ? { box: style.box ?? '#000000A0' } : {}),
    emphasis: {
      ...style.emphasis,
      ...(look.emphasisColor && HEX.test(look.emphasisColor) ? { color: look.emphasisColor } : {}),
      ...(look.emphasisScale && look.emphasisScale >= 1 && look.emphasisScale <= 1.5 ? { scale: look.emphasisScale } : {}),
    },
  };
}
