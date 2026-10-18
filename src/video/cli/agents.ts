import { AGENT_CATALOG, BUILTIN_AGENTS, isBuiltinAgent } from '@shared/agentCatalog';
import { whichSync } from '@video/toolchain';

// Agent CLI の一覧は Ferret の src/shared/agentCatalog.ts を正本にする（旧パッケージの agents は持ち込まない）。
// ここは doctor と feedback organize が使う最小限だけ。

export interface CliAgent {
  id: string;
  label: string;
  /** PATH で探すコマンド（先頭が本名、続きが別名） */
  commands: string[];
  popular: boolean;
}

export const CLI_AGENTS: readonly CliAgent[] = BUILTIN_AGENTS.map((id) => {
  const e = AGENT_CATALOG[id];
  return { id, label: e.label, commands: [e.detectCmd, ...(e.aliases ?? [])], popular: !!e.popular };
});

/** Ferret の一覧にある Agent（無ければ undefined）。custom:<名前> などは扱わない */
export function getAgent(id: string): CliAgent | undefined {
  return isBuiltinAgent(id) ? CLI_AGENTS.find((a) => a.id === id) : undefined;
}

/** PATH（env の PATH）で見つかるかを調べる。版は調べない（Agent を起動しないので速い） */
export function detectAgents(env: NodeJS.ProcessEnv, defs: readonly CliAgent[] = CLI_AGENTS): { id: string; installed: boolean; path?: string }[] {
  return defs.map((d) => {
    const path = d.commands.map((c) => whichSync(c, env)).find((p): p is string => !!p);
    return path ? { id: d.id, installed: true, path } : { id: d.id, installed: false };
  });
}
