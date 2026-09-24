import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import BatchOperationLabel from '~/components/BatchOperationLabel.vue'
import type { BatchEntry } from '~/composables/useTxBatch'

const renderLabel = (entry: Partial<BatchEntry>) => renderToString(createSSRApp({
  render: () => h(BatchOperationLabel, { entry: entry as BatchEntry }),
}))

describe('BatchOperationLabel', () => {
  it('preserves the borrow identity when collateral is swapped from another token', async () => {
    const html = await renderLabel({
      label: 'Borrow 100 USDC',
      nameOverride: 'Borrow USDC',
      review: {
        type: 'swap-borrow',
        asset: { symbol: 'WETH', address: '0x0000000000000000000000000000000000000001' },
        amount: '1',
        swapToAsset: { symbol: 'wstETH', address: '0x0000000000000000000000000000000000000002', decimals: 18 },
        swapToAmount: '0.9',
      },
    })
    expect(html).toContain('Borrow USDC')
    expect(html).not.toContain('Swap')
    expect(html).not.toContain('WETH')
  })

  it('keeps the derived borrow label for an operation without a swap', async () => {
    const html = await renderLabel({
      label: 'Borrow 100 USDC',
      review: { type: 'borrow', asset: { symbol: 'USDC', address: '0x0000000000000000000000000000000000000003' }, amount: '100' },
    })
    expect(html).toContain('Borrow')
    expect(html).toContain('USDC')
    expect(html).not.toContain('Swap')
  })
})
