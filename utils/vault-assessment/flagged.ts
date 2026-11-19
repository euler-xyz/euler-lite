import type { VaultAssessment, VaultAssessmentContext, VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'

export interface VaultVerdictLike {
  status: string
  reason?: string | null
  decidedBy?: string | null
}

export type VaultVisibilityMap = Readonly<Record<string, VaultVerdictLike>> | undefined

export const FLAGGED_VAULT_LABEL = 'Flagged'
export const FLAGGED_VAULT_TITLE = 'Vault flagged'
export const FLAGGED_VAULT_ACTION = 'Review flagged vault'
export const PAUSED_VAULT_LABEL = 'Paused'
export const PAUSED_VAULT_TITLE = 'Vault paused'
export const PAUSED_VAULT_FALLBACK_REASON = 'This vault is paused.'

export type VaultPairSide = 'collateral' | 'borrow'

export const PAIR_SIDE_BADGE_LABELS: Readonly<Record<VaultPairSide, { warning: string, flagged: string, paused: string }>> = {
  collateral: { warning: 'Collateral warning', flagged: 'Collateral flagged', paused: 'Collateral paused' },
  borrow: { warning: 'Borrow warning', flagged: 'Borrow flagged', paused: 'Borrow paused' },
}

const withReason = (lead: string, reason?: string | null): string => {
  const text = reason?.trim()
  if (!text) return `${lead}.`
  return `${lead}: ${text}${/[.!?]$/.test(text) ? '' : '.'}`
}

export const getFlaggedVaultLine = (reason?: string | null): string =>
  withReason('Euler\'s checks flagged this vault', reason)

export const getFlaggedTransactionLine = (reason?: string | null): string =>
  withReason('This transaction uses a flagged vault', reason)

export const getFlaggedOpeningText = (reasons: readonly (string | null | undefined)[]): string =>
  [...new Set(reasons.map(getFlaggedVaultLine)), 'Continue only if you understand the risk.'].join(' ')

export const getFlaggedVerdict = (
  address: string,
  source: string | undefined,
  visibility: VaultVisibilityMap,
): VaultVerdictLike | undefined => {
  if (source !== 'v3') return undefined
  const verdict = visibility?.[address.toLowerCase()]
  return verdict?.status === 'hidden' ? verdict : undefined
}

const CONFIG_HIDING_REASONS: ReadonlySet<string> = new Set(['config-suspended', 'config-failed', 'config-revoked'])
const PAUSE_CAUSE_CODES: ReadonlySet<string> = new Set(['exit-operations-disabled', 'vault-paused'])

export interface VaultPauseEvidence {
  family: 'evk' | 'earn' | null
  /** Undefined when the vault's hooks are not loaded; the assessment then stands in for them. */
  onchainPaused?: boolean
  assessment?: Pick<VaultAssessment, 'configContext'>
}

const ZERO_ADDRESS_PATTERN = /^0x0{40}$/i

const isPauseFinding = (finding: VaultAssessmentFinding): boolean => {
  if (finding.outcome !== 'fail' || !PAUSE_CAUSE_CODES.has(finding.cause?.code ?? '')) return false
  if (finding.cause?.code !== 'exit-operations-disabled') return true
  const governor = (finding.observed as { governorAdmin?: unknown } | undefined)?.governorAdmin
  return typeof governor === 'string' && /^0x[0-9a-f]{40}$/i.test(governor) && !ZERO_ADDRESS_PATTERN.test(governor)
}

/** Any configuration verdict can come from a pause, and none proves one, so the pause itself must be seen. */
export const isPausedVerdict = (verdict: VaultVerdictLike | undefined, evidence: VaultPauseEvidence): boolean => {
  if (verdict?.status !== 'hidden' || !CONFIG_HIDING_REASONS.has(verdict.decidedBy ?? '')) return false
  if (evidence.family === 'earn') return false
  if (evidence.onchainPaused !== undefined) return evidence.onchainPaused
  return evidence.assessment?.configContext?.findings.some(isPauseFinding) ?? false
}
const CLEAR_CONSISTENCY_STATUSES: ReadonlySet<string> = new Set(['verified', 'not_applicable'])
const REQUIRED_GOVERNANCE_RULES: Readonly<Record<string, readonly string[]>> = {
  'euler-evk': ['governance.no-deprecated-governor', 'governance.router'],
  'euler-securitize': ['governance.no-deprecated-governor'],
  'euler-earn': ['governance.timelock'],
}
const GOVERNANCE_FINDING_KEY = /^(scheduled\.)?governance\./

export interface VaultGovernanceEvidence {
  status: string
  assessment?: Pick<VaultAssessment, 'configContext' | 'consistencyContext'>
  consistencyStatus?: string | null
}

const isUnresolvedFinding = (finding: VaultAssessmentFinding): boolean =>
  !finding.exempted && (finding.outcome === 'fail' || finding.outcome === 'unknown')

const isGovernanceFinding = (finding: VaultAssessmentFinding): boolean =>
  GOVERNANCE_FINDING_KEY.test(finding.key)

const hasPolicyGovernanceRules = (configContext: VaultAssessmentContext): boolean => {
  const rules = REQUIRED_GOVERNANCE_RULES[typeof configContext.policyId === 'string' ? configContext.policyId : '']
  return !!rules && rules.every(key => configContext.findings.some(finding => finding.key === key
    && (finding.outcome === 'pass' || finding.outcome === 'not_applicable' || !!finding.exempted)))
}

/**
 * A configuration verdict can mask a consistency failure and Layer 1 holds governance rules, so the
 * reason alone never proves the hiding is unrelated to governance: the assessment has to show it.
 */
export const isHiddenForNonGovernanceCause = (
  verdict: VaultVerdictLike | undefined,
  evidence: VaultGovernanceEvidence | undefined,
): boolean => {
  if (verdict?.status !== 'hidden' || !CONFIG_HIDING_REASONS.has(verdict.decidedBy ?? '')) return false
  const configContext = evidence?.status === 'available' ? evidence.assessment?.configContext : null
  if (!configContext || !CLEAR_CONSISTENCY_STATUSES.has(evidence?.consistencyStatus ?? '')) return false
  if (!hasPolicyGovernanceRules(configContext)) return false
  const findings = [...configContext.findings, ...(evidence?.assessment?.consistencyContext?.findings ?? [])]
  if (findings.some(finding => isGovernanceFinding(finding) && isUnresolvedFinding(finding))) return false
  return configContext.findings.some(finding => finding.required && finding.outcome === 'fail' && !finding.exempted
    && !isGovernanceFinding(finding) && !finding.key.startsWith('scheduled.'))
}

/** Without the label deprecation there is no Deprecated badge, so the verdict stays the only signal. */
export const isDeprecationWarning = (verdict: VaultVerdictLike | undefined, deprecatedInLabels: boolean): boolean =>
  verdict?.status === 'warning' && verdict.decidedBy === 'deprecated' && deprecatedInLabels

/** The lighter confirmation applies only when every unverified vault in the transaction is flagged. */
export const getFlaggedActionNotice = (
  addresses: readonly string[],
  source: string | undefined,
  visibility: VaultVisibilityMap,
): string | null => {
  if (!addresses.length) return null
  const verdicts = addresses.map(address => getFlaggedVerdict(address, source, visibility))
  if (verdicts.some(verdict => !verdict)) return null
  return [...new Set(verdicts.map(verdict => getFlaggedTransactionLine(verdict?.reason)))].join(' ')
}

export type VaultOpeningNotice = { kind: 'unknown' } | { kind: 'flagged', text: string }

export const getVaultOpeningNotice = (
  addresses: readonly string[],
  context: { isVerified: (address: string) => boolean, source: string | undefined, visibility: VaultVisibilityMap },
): VaultOpeningNotice | null => {
  const unverified = addresses.filter(address => !context.isVerified(address))
  if (!unverified.length) return null
  const verdicts = unverified.map(address => getFlaggedVerdict(address, context.source, context.visibility))
  if (verdicts.some(verdict => !verdict)) return { kind: 'unknown' }
  return { kind: 'flagged', text: getFlaggedOpeningText(verdicts.map(verdict => verdict?.reason)) }
}
