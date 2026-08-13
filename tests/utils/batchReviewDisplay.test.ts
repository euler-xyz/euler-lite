import { describe, expect, it } from 'vitest'
import { getAuthorizationStepDisplay, groupRestorationSummaryRows, isBundledReviewEntry } from '~/utils/batchReviewDisplay'

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
