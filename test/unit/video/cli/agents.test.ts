import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_CATALOG, BUILTIN_AGENTS } from '@shared/agentCatalog';
import { CLI_AGENTS, detectAgents, getAgent } from '@video/cli/agents.js';
import { fakeNodeCli } from './helpers.js';

// 旧 @solocut/agents の代わり: Ferret の Agent の一覧（src/shared/agentCatalog.ts）から作る
describe('CLI agents from the Ferret catalog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferret-video-agents-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists every built-in agent with its command, aliases and popular flag', () => {
    expect(CLI_AGENTS.map((a) => a.id)).toEqual([...BUILTIN_AGENTS]);
    const claude = CLI_AGENTS.find((a) => a.id === 'claude')!;
    expect(claude).toEqual({ id: 'claude', label: AGENT_CATALOG.claude.label, commands: ['claude'], popular: true });
    for (const a of CLI_AGENTS) expect(a.commands[0]).toBe(AGENT_CATALOG[a.id as keyof typeof AGENT_CATALOG].detectCmd);
    expect(CLI_AGENTS.some((a) => a.commands.length > 1)).toBe(true);
  });

  it('getAgent knows built-ins only', () => {
    expect(getAgent('codex')?.commands[0]).toBe('codex');
    for (const id of ['', 'custom:foo', 'CLAUDE', 'nope', '__proto__']) expect(getAgent(id), id).toBeUndefined();
  });

  it('detectAgents looks on the given PATH only (no versions, nothing is started)', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // 起動されたら失敗させる（版を調べに起動しないこと）
    fakeNodeCli(bin, 'codex', 'process.exit(3)');
    const r = detectAgents({ PATH: bin });
    expect(r).toHaveLength(CLI_AGENTS.length);
    expect(r.find((a) => a.id === 'codex')).toEqual({ id: 'codex', installed: true, path: expect.stringContaining(join(bin, 'codex')) });
    expect(r.find((a) => a.id === 'claude')).toEqual({ id: 'claude', installed: false });
    expect(detectAgents({ PATH: '' }).every((a) => !a.installed)).toBe(true);
    expect(detectAgents({}).every((a) => !a.installed)).toBe(true);
  });

  it('finds an agent by its alias', () => {
    const withAlias = CLI_AGENTS.find((a) => a.commands.length > 1)!;
    const bin = join(dir, 'alias');
    mkdirSync(bin);
    fakeNodeCli(bin, withAlias.commands[1]!, '');
    expect(detectAgents({ PATH: bin }, [withAlias])).toEqual([{ id: withAlias.id, installed: true, path: expect.stringContaining(withAlias.commands[1]!) }]);
  });
});
