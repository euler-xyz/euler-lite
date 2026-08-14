import type { DisplayStep } from '~/utils/stepDecoding'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'

export interface AuthorizationStepsDisplay {
  detailHeading: 'Authorization transactions' | 'Signatures'
  summaryHeading: 'Authorization transactions' | 'Signatures needed'
  itemCountLabel: '1 transaction' | '1 signature'
}

export const isBundledReviewEntry = (
  hasLatchedBundledExecution: boolean,
  hasBundledExecutionBuilder: boolean,
): boolean => hasLatchedBundledExecution && hasBundledExecutionBuilder

/** Prefer the fresh per-entry plan owned by the Safe review ceremony. */
export const getBatchReviewDisplayPlan = (
  ceremonyPlan: TransactionPlan | undefined,
  capturedDisplayPlan: TransactionPlan | undefined,
  entryPlan: TransactionPlan | undefined,
): TransactionPlan | undefined => ceremonyPlan ?? capturedDisplayPlan ?? entryPlan

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
