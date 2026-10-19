import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import GeoBlockAlert from '~/components/entities/vault/GeoBlockAlert.vue'
import FormAlertStack from '~/components/entities/vault/form/FormAlertStack.vue'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { isVaultBlockedByCountry, isVaultRestrictedByCountry, useGeoBlock } from '~/composables/useGeoBlock'
import { cozy, staticGeoLabels } from '~/tests/fixtures/static-geo-labels'

const registry = vi.hoisted(() => ({ getVault: vi.fn() }))
vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => registry }))
const chainId = ref(1)
const render = async () => {
  const app = createSSRApp({ render: () => h(FormAlertStack, {
    vaultAddresses: [cozy.address],
    isGeoBlocked: isVaultBlockedByCountry(cozy.address),
    swapRestricted: isVaultRestrictedByCountry(cozy.address),
    swapRestrictedDescription: 'Swapping into this vault is not available in your region.',
  }) })
  app.component('GeoBlockAlert', GeoBlockAlert)
  app.component('UiAlert', defineComponent({
    props: { title: String, description: String },
    setup: props => () => h('p', `${props.title}: ${props.description}`),
  }))
  return renderToString(app)
}

beforeEach(() => {
  chainId.value = 1
  vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
  registry.getVault.mockReturnValue(cozy)
  useGeoBlock().country.value = 'NL'
})

describe.each(['v3', 'static'] as const)('%s shared action warnings', (source) => {
  beforeEach(() => __setEulerLabelsDataForTest(source === 'static'
    ? staticGeoLabels()
    : {
        source, sourceFetchedAt: Date.now(), geoFetchedAt: Date.now(),
        geoContext: { chainId: 1, policies: [], productByVault: {} },
      }))
  it('does not warn for a hydrated held vault with no matching rule', async () => {
    expect(isVaultBlockedByCountry(cozy.address)).toBe(false)
    expect(await render()).not.toContain('restricted')
  })
  it.each([null, undefined])('keeps country %s guarded with availability copy', async (country) => {
    useGeoBlock().country.value = country
    expect(isVaultBlockedByCountry(cozy.address)).toBe(true)
    const html = await render()
    expect(html).toContain('Availability not confirmed')
    expect(html).toContain('Your country could not be determined')
    expect(html).not.toContain('your region')
  })
  it('keeps unresolved assets guarded with availability copy', async () => {
    registry.getVault.mockReturnValue(undefined)
    expect(isVaultBlockedByCountry(cozy.address)).toBe(true)
    const html = await render()
    expect(html).toContain('Vault data is unavailable for this network')
    expect(html).not.toContain('your region')
  })
  it('retains confirmed sanction warnings', async () => {
    useGeoBlock().country.value = 'IR'
    const html = await render()
    expect(html).toContain('Region restricted')
    expect(html).toContain('not available in your region')
  })
  it('retains matching asset blocks and soft restriction warnings', async () => {
    for (const policyType of ['block', 'restrict'] as const) {
      __setEulerLabelsDataForTest(source === 'static'
        ? staticGeoLabels({ assets: [{ address: cozy.asset.address, [policyType === 'block' ? 'block' : 'restricted']: ['NL'] }] })
        : { source, sourceFetchedAt: Date.now(), geoFetchedAt: Date.now(), geoContext: { chainId: 1, productByVault: {}, policies: [
            { id: 'USDC', chainId: 1, productId: null, vaultAddress: null, assetAddress: cozy.asset.address, policyType, countries: ['NL'], countriesResolved: ['NL'], reason: null, createdAt: '' },
          ] } })
      expect(isVaultBlockedByCountry(cozy.address)).toBe(policyType === 'block')
      const html = await render()
      expect(html).toContain(policyType === 'block' ? 'Region restricted' : 'Swap restricted')
      expect(html).not.toContain('Availability not confirmed')
    }
  })
})

it('keeps cold policy acquisition guarded, explains availability and preserves the exit exception', async () => {
  __setEulerLabelsDataForTest({ source: 'v3', geoContext: { chainId: null, policies: undefined, productByVault: {} } })
  expect(isVaultBlockedByCountry(cozy.address)).toBe(false)
  expect(isVaultRestrictedByCountry(cozy.address)).toBe(true)
  const html = await render()
  expect(html).toContain('Compliance data unavailable')
  expect(html).not.toContain('your region')
})
