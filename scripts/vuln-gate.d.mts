// scripts/vuln-gate.mjs の型（単体テストから読むため）

export interface VulnFinding {
  package: string
  version: string
  id: string
  severity: string
  source: string
}

export const BLOCK_SCORE: number
export function classify(maxSeverity: string | undefined, label: string | undefined): 'block' | 'pass' | 'unknown'
export function blockingFindings(report: unknown): { blocking: VulnFinding[]; unknown: VulnFinding[] }
