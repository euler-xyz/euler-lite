import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSSRApp, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import SwapTokenSelector from '~/components/entities/asset/SwapTokenSelector.vue'
import { cozy } from '~/tests/fixtures/static-geo-labels'

const held = { ...cozy, asset: { ...cozy.asset, decimals: 6 } }
const listed = { ...held, address: '0x0000000000000000000000000000000000000002', asset: {
  ...held.asset, address: '0x0000000000000000000000000000000000000003', name: 'Listed asset', symbol: 'LIST',
} }
beforeEach(() => {
  vi.stubGlobal('useVaultRegistry', () => ({
    getByType: (type: string) => type === 'evk' ? [held, listed] : [],
    getAll: () => [{ vault: held, portfolioOnly: true, verified: false }, { vault: listed }],
  }))
  vi.stubGlobal('useWallets', () => ({ getBalance: () => 0n }))
  vi.stubGlobal('useTokenList', () => ({ getAllTokens: () => [], toVaultAsset: vi.fn() }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useClipboardCopy', () => ({ isCopied: () => false, copyToClipboard: vi.fn() }))
  vi.stubGlobal('useCustomTokenResolver', () => ({ customToken: ref(), customTokenBalance: ref(), isLoading: ref(false), error: ref(), resolve: vi.fn(), reset: vi.fn() }))
})
afterEach(() => vi.unstubAllGlobals())
it('does not add held-only vault assets to suggestions or the known-token set', async () => {
  const app = createSSRApp({ render: () => h(SwapTokenSelector, { mode: 'output', onSelect: vi.fn() }) })
  app.config.warnHandler = () => {}
  app.component('BaseModalWrapper', { template: '<main><slot /></main>' })
  const html = await renderToString(app)
  expect(html).toContain(`data-token-address="${listed.asset.address.toLowerCase()}"`)
  expect(html).not.toContain(`data-token-address="${held.asset.address.toLowerCase()}"`)
})
