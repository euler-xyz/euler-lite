import type { VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import {
  getVaultCheckFindingRank,
  getVaultCheckTitle,
  type VaultCheckFindingTone,
  type VaultCheckLine,
} from '~/utils/vault-assessment/presentation'
import { getVaultCheckSubject, vaultCheckSubjectKey, type VaultCheckSubject } from '~/utils/vault-assessment/subjects'

export interface VaultCheckRow {
  key: string
  subject: VaultCheckSubject | null
  findings: VaultAssessmentFinding[]
}

export interface VaultCheckView {
  key: string
  title: string
  status: string
  tone: VaultCheckFindingTone
  icon: string
  parts: NonNullable<VaultCheckLine['parts']>
  tag: string | null
}

export interface VaultCheckRowView {
  key: string
  subject: VaultCheckSubject | null
  weight: string | null
  checks: VaultCheckView[]
}

const NAMESPACE_ORDER = { strategy: 0, collateral: 1 } as const

const worstRank = (row: VaultCheckRow) => Math.min(...row.findings.map(getVaultCheckFindingRank))

const byRankThenTitle = (a: VaultAssessmentFinding, b: VaultAssessmentFinding) =>
  getVaultCheckFindingRank(a) - getVaultCheckFindingRank(b)
  || getVaultCheckTitle(a.key).localeCompare(getVaultCheckTitle(b.key))

/** A strategy's weight is a share and a collateral's is USD, so weights are compared within one namespace only. */
export const groupVaultCheckRows = (
  findings: readonly VaultAssessmentFinding[],
  weightValueOf: (subject: VaultCheckSubject) => number | null = () => null,
): VaultCheckRow[] => {
  const rows = new Map<string, VaultCheckRow>()
  findings.forEach((finding, index) => {
    const subject = getVaultCheckSubject(finding.key)
    const key = subject ? vaultCheckSubjectKey(subject) : `${finding.key}#${index}`
    const row = rows.get(key)
    rows.set(key, row ? { ...row, findings: [...row.findings, finding] } : { key, subject, findings: [finding] })
  })
  const weights = new Map([...rows.values()].map(row => [row.key, (row.subject ? weightValueOf(row.subject) : null) ?? -1]))
  const namespaceOrder = (row: VaultCheckRow) => row.subject ? NAMESPACE_ORDER[row.subject.namespace] : 2
  return [...rows.values()]
    .map(row => ({ ...row, findings: [...row.findings].sort(byRankThenTitle) }))
    .sort((a, b) => worstRank(a) - worstRank(b)
      || namespaceOrder(a) - namespaceOrder(b)
      || weights.get(b.key)! - weights.get(a.key)!)
}
