import type { DisplayStep } from '~/utils/stepDecoding'

export interface AuthorizationStepsDisplay {
  detailHeading: 'Authorization transactions' | 'Signatures'
  summaryHeading: 'Authorization transactions' | 'Signatures needed'
  itemCountLabel: '1 transaction' | '1 signature'
}

export const isBundledReviewEntry = (
  hasLatchedBundledExecution: boolean,
  hasBundledExecutionBuilder: boolean,
): boolean => hasLatchedBundledExecution && hasBundledExecutionBuilder

export const groupRestorationSummaryRows = <TRow extends { step: Pick<DisplayStep, 'isSeparateTx'> }>(
  rows: readonly TRow[],
): { bundled: TRow[], postExecution: TRow[] } => ({
  bundled: rows.filter(({ step }) => !step.isSeparateTx),
  postExecution: rows.filter(({ step }) => step.isSeparateTx),
})

export const getAuthorizationStepDisplay = (
  isSeparateTx: DisplayStep['isSeparateTx'],
): AuthorizationStepsDisplay => {
  return isSeparateTx
    ? {
        detailHeading: 'Authorization transactions',
        summaryHeading: 'Authorization transactions',
        itemCountLabel: '1 transaction',
      }
    : {
        detailHeading: 'Signatures',
        summaryHeading: 'Signatures needed',
        itemCountLabel: '1 signature',
      }
}

type RestorationSummaryRow = {
  step: Pick<DisplayStep, 'isSeparateTx' | 'txKey'>
}

/**
 * Standalone prerequisites resolve sequentially, so a repeated restoration
 * transaction is sent only once. Bundled Safe calls are already resolved and
 * every collected call remains in the proposal, so every row stays visible.
 */
export const consolidateRestorationSummaryRows = <TRow extends RestorationSummaryRow>(
  rows: readonly TRow[],
): TRow[] => {
  const seenStandaloneTransactions = new Set<string>()
  return rows.filter(({ step }) => {
    if (!step.isSeparateTx || !step.txKey) return true
    if (seenStandaloneTransactions.has(step.txKey)) return false
    seenStandaloneTransactions.add(step.txKey)
    return true
  })
}
