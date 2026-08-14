import { describe, expect, it } from 'vitest'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getAuthorizationStepDisplay, getBatchReviewDisplayPlan, groupRestorationSummaryRows, isBundledReviewEntry } from '~/utils/batchReviewDisplay'

describe('getAuthorizationStepDisplay', () => {
  it('describes signature-mode authorization rows as signatures', () => {
    expect(getAuthorizationStepDisplay(false)).toEqual({
      detailHeading: 'Signatures',
      summaryHeading: 'Signatures needed',
      itemCountLabel: '1 signature',
    })
  })

  it('describes standalone authorization rows as transactions', () => {
    expect(getAuthorizationStepDisplay(true)).toEqual({
      detailHeading: 'Authorization transactions',
      summaryHeading: 'Authorization transactions',
      itemCountLabel: '1 transaction',
    })
  })
})

describe('isBundledReviewEntry', () => {
  it('requires both a latched ceremony and a bundled execution builder', () => {
    expect(isBundledReviewEntry(true, true)).toBe(true)
    expect(isBundledReviewEntry(false, true)).toBe(false)
    expect(isBundledReviewEntry(true, false)).toBe(false)
  })
})

describe('getBatchReviewDisplayPlan', () => {
  it('uses the ceremony plan for display and disclosure instead of a stale captured preview', () => {
    const freshCeremonyPlan = [{ type: 'evcBatch', items: [{ name: 'fresh-execution' }] }] as unknown as TransactionPlan
    const stalePreviewPlan = [{ type: 'evcBatch', items: [{ name: 'stale-preview' }] }] as unknown as TransactionPlan
    const entryPlan = [{ type: 'evcBatch', items: [{ name: 'entry-plan' }] }] as unknown as TransactionPlan

    expect(getBatchReviewDisplayPlan(freshCeremonyPlan, stalePreviewPlan, entryPlan)).toBe(freshCeremonyPlan)
  })
})

describe('groupRestorationSummaryRows', () => {
  it('separates in-proposal restorations from post-execution transactions', () => {
    const bundled = { id: 'bundled', step: { isSeparateTx: false } }
    const postExecution = { id: 'post-execution', step: { isSeparateTx: true } }

    expect(groupRestorationSummaryRows([bundled, postExecution])).toEqual({
      bundled: [bundled],
      postExecution: [postExecution],
    })
  })

  it('returns empty groups when there are no restoration rows', () => {
    expect(groupRestorationSummaryRows([])).toEqual({
      bundled: [],
      postExecution: [],
    })
  })
})
