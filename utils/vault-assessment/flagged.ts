export interface VaultVerdictLike {
  status: string
  reason?: string | null
  decidedBy?: string | null
}

export type VaultVisibilityMap = Readonly<Record<string, VaultVerdictLike>> | undefined

export const FLAGGED_VAULT_LABEL = 'Flagged'
export const FLAGGED_VAULT_TITLE = 'Vault flagged'
export const FLAGGED_VAULT_ACTION = 'Review flagged vault'

export type VaultPairSide = 'collateral' | 'borrow'

export const PAIR_SIDE_BADGE_LABELS: Readonly<Record<VaultPairSide, { warning: string, flagged: string }>> = {
  collateral: { warning: 'Collateral warning', flagged: 'Collateral flagged' },
  borrow: { warning: 'Borrow warning', flagged: 'Borrow flagged' },
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
