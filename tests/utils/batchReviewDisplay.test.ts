import { describe, expect, it } from 'vitest'
import { consolidateRestorationSummaryRows, getAuthorizationStepDisplay } from '~/utils/batchReviewDisplay'

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

describe('consolidateRestorationSummaryRows', () => {
  it('keeps every bundled Safe call visible', () => {
    const first = { id: 'first', step: { isSeparateTx: false, txKey: 'same-transaction' } }
    const second = { id: 'second', step: { isSeparateTx: false, txKey: 'same-transaction' } }

    expect(consolidateRestorationSummaryRows([first, second])).toEqual([first, second])
  })

  it('consolidates identical standalone restorations resolved sequentially', () => {
    const first = { id: 'first', step: { isSeparateTx: true, txKey: 'same-transaction' } }
    const second = { id: 'second', step: { isSeparateTx: true, txKey: 'same-transaction' } }

    expect(consolidateRestorationSummaryRows([first, second])).toEqual([first])
  })
})
