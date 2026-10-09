import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

// Route-level wiring guards: the direct-repay fallback is a different form from
// the selected-token swap composable, so its controls must share the same gate.
describe('selected spending token route wiring', () => {
  it('gates the direct repay fallback while the selected token is unresolved', () => {
    const page = source('pages/position/[number]/repay.vue')
    for (const start of ['const reviewRepayDisabled = computed', 'const onSubmitForm = async', 'const canAddToBatch = computed']) {
      const body = page.slice(page.indexOf(start), page.indexOf(start) + 250)
      expect(body).toContain('walletSwap.spending.isBlocked.value')
    }
    const direct = page.slice(page.indexOf('<!-- Direct repay (no swap) -->'), page.indexOf('<!-- Swap + repay -->'))
    expect(direct).toContain(':readonly="walletSwap.spending.isBlocked.value"')
    expect(direct).toContain(':maxable="!walletSwap.spending.isBlocked.value"')
  })

  it.each(['pages/lend/[vault]/index.vue', 'pages/position/[number]/supply.vue'])('disables supply entry and Max during verification: %s', (file) => {
    const page = source(file)
    expect(page).toContain(':readonly="spendingBlocked"')
    expect(page).toContain(':maxable="!spendingBlocked"')
    expect(page).toContain('@retry="spending.retry"')
    const batch = page.slice(page.indexOf('const canAddToBatch = computed'), page.indexOf('const canAddToBatch = computed') + 180)
    expect(batch).toContain('spendingBlocked.value')
  })

  it('does not move verification into picker rendering or token listing', () => {
    for (const file of ['components/entities/asset/SwapTokenSelector.vue', 'composables/useTokenList.ts']) {
      expect(source(file)).not.toContain('useVerifiedSpendingAsset')
      expect(source(file)).not.toContain('erc20DecimalsAbi')
    }
  })
})
