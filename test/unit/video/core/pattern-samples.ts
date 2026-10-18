import type { Scene } from '@video/core';

/** Sample slots for every built-in pattern. Sources used: image asset "ill", video "scr" (screen). */
export const SAMPLE_SLOTS: Record<string, Scene['slots']> = {
  'explain-illust-bubbles': { illustration: { kind: 'image', asset: 'ill' }, bubbleLeft: { kind: 'text', text: 'AIに全部まかせたい' }, bubbleRight: { kind: 'text', text: 'でも品質が心配…' } },
  'title-card': { title: { kind: 'text', text: '設定の3つのコツ' }, subtitle: { kind: 'text', text: 'Claude Code を使い始めた人へ' }, number: { kind: 'number', value: 2 } },
  'bullet-points': { title: { kind: 'text', text: '今日のポイント' }, items: { kind: 'list', items: ['テンプレートを選ぶ', 'エージェントに任せる', '人は最後に確認するだけ'] } },
  'compare-2col': { leftTitle: { kind: 'text', text: 'Before' }, rightTitle: { kind: 'text', text: 'After' }, left: { kind: 'list', items: ['編集に3時間', '字幕を手で打つ'] }, right: { kind: 'list', items: ['編集は10分', '字幕は自動'] } },
  ranking: { title: { kind: 'text', text: 'よく使う機能' }, items: { kind: 'list', items: ['自動カット', '字幕', 'BGM'] } },
  'big-number': { value: { kind: 'number', value: 90, unit: '%' }, label: { kind: 'text', text: '編集時間を削減' } },
  quote: { text: { kind: 'text', text: '撮るのは一人でも、編集はチームでできる。' }, by: { kind: 'text', text: 'Ferret' } },
  'code-focus': { title: { kind: 'text', text: 'settings.json' }, code: { kind: 'code', language: 'json', code: '{\n  "model": "opus",\n  "permissions": {\n    "allow": ["Bash(ls)"]\n  }\n}', highlight: [2] } },
  'terminal-typing': { command: { kind: 'code', language: 'sh', code: 'ferret-video render --preview' }, output: { kind: 'text', text: 'rendered 12 chunks (3 reused)\nrenders/preview.mp4' } },
  'screen-zoom-callout': { screen: { kind: 'video', source: 'scr', from: 0 }, x: { kind: 'number', value: 0 }, y: { kind: 'number', value: 0 }, w: { kind: 'number', value: 320 }, h: { kind: 'number', value: 180 }, label: { kind: 'text', text: 'ここをクリック' } },
  'cta-subscribe': {},
};
