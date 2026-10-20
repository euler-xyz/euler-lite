import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import GeoBlockAlert from '~/components/entities/vault/GeoBlockAlert.vue'
import RestrictedBadge from '~/components/entities/vault/RestrictedBadge.vue'
import FormAlertStack from '~/components/entities/vault/form/FormAlertStack.vue'
import VaultLabelsAndAssets from '~/components/entities/vault/VaultLabelsAndAssets.vue'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { useGeoBlock } from '~/composables/useGeoBlock'
import { staticGeoLabels } from '~/tests/fixtures/static-geo-labels'

const registry = vi.hoisted(() => ({ getVault: vi.fn(() => undefined), getVaultCategory: () => 'standard', isVerifiedVault: () => false }))
vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => registry }))
vi.mock('~/composables/useEulerLabels', async original => ({
  ...await original<typeof import('~/composables/useEulerLabels')>(),
  useEulerProductOfVault: () => ({ name: 'Unlisted SDK-resolved vault' }),
}))
vi.mock('#components', () => ({ RestrictedInfoModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: vi.fn() }) }))
const vault = {
  type: 'EVault', address: '0x63bA834bFf27Dd1d80533a56cA27Aa058AAA1130', chainId: 1,
  shares: { name: 'Cozy USDC' },
  asset: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', name: 'USD Coin', symbol: 'USDC', decimals: 6 },
}
const resolvedVault = vault as unknown as EVault
const chainId = ref(1)
const render = async () => {
  const app = createSSRApp({ render: () => h(VaultLabelsAndAssets, { vault: resolvedVault, assets: [resolvedVault.asset] }) })
  app.config.warnHandler = () => {}
  app.component('RestrictedBadge', RestrictedBadge)
  app.component('UiHoverPreviewTooltip', { template: '<span><slot /></span>' })
  return renderToString(app)
}
beforeEach(() => {
  chainId.value = 1
  registry.getVault.mockReturnValue(vault)
  vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
  vi.stubGlobal('useVaultRegistry', () => registry)
  useGeoBlock().country.value = 'NL'
  __setEulerLabelsDataForTest({ geoContext: { chainId: 1, policies: [], productByVault: {} } })
})
describe.each(['hosted', 'static'] as const)('%s detail header geo badge', (source) => {
  beforeEach(() => {
    if (source === 'static') __setEulerLabelsDataForTest(staticGeoLabels())
  })
  it('does not render a restriction for an unlisted vault with a resolved asset', async () => {
    expect(await render()).not.toContain('Restricted')
  })
  it.each([null, undefined])('does not claim a confirmed restriction for country %s', async (country) => {
    useGeoBlock().country.value = country
    expect(await render()).not.toContain('Restricted')
  })
  it('does not claim a confirmed restriction for a stale vault after switching chains', async () => {
    chainId.value = 8453
    expect(await render()).not.toContain('Restricted')
  })
  it('renders an authored asset restriction without discovery membership', async () => {
    __setEulerLabelsDataForTest(source === 'static'
      ? staticGeoLabels({ assets: [{ address: vault.asset.address, block: ['EEA'] }] })
      : { geoContext: { chainId: 1, policies: [{ id: 'asset', chainId: 1, productId: null, vaultAddress: null, assetAddress: vault.asset.address, policyType: 'block', countries: ['NL'], countriesResolved: ['NL'], reason: null, createdAt: '' }], productByVault: {} } })
    expect(await render()).toContain('Restricted')
  })
  it('renders a confirmed sanction restriction', async () => {
    useGeoBlock().country.value = 'IR'
    expect(await render()).toContain('Restricted')
  })
})

describe('action availability warning', () => {
  it.each([null, undefined])('keeps missing country %s separate from an affirmative restriction', async (country) => {
    useGeoBlock().country.value = country
    const app = createSSRApp({ render: () => h(FormAlertStack, {
      isGeoBlocked: true, vaultAddresses: [resolvedVault.address],
    }) })
    app.component('GeoBlockAlert', GeoBlockAlert)
    app.component('UiAlert', defineComponent({
      props: { title: String, description: String },
      setup: props => () => h('p', `${props.title}: ${props.description}`),
    }))
    const html = await renderToString(app)
    expect(html).toContain('Availability not confirmed')
    expect(html).toContain('Your country could not be determined')
    expect(html).not.toContain('Region restricted')
  })
})
