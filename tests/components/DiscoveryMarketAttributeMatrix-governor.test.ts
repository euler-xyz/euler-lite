import { createSSRApp, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import DiscoveryMarketAttributeMatrix from '~/components/entities/vault/discovery/DiscoveryMarketAttributeMatrix.vue'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { getAttributeMatrix, getMarketVaultResolver } from '~/utils/discoveryCalculations'
import type { PublicEulerLabelsData } from '~/utils/public-labels'
import {
  LIQUITY_HUB_ENTITY,
  LIQUITY_HUB_GOVERNOR,
  makeEusdc42,
  makeLiquityHubOnDemandMarket,
} from '~/tests/fixtures/liquity-hub'

vi.mock('#components', () => ({ VaultHooksInfoModal: {} }))
vi.mock('~/composables/useTokenList', () => ({ getAssetLogoUrl: () => '' }))

const SECURITIZE = getAddress('0x00000000000000000000000000000000000000c5')
const securitize = {
  ...makeEusdc42(),
  type: 'SecuritizeCollateral',
  address: SECURITIZE,
  asset: { address: getAddress('0x00000000000000000000000000000000000000a5'), symbol: 'STAC', decimals: 6, name: 'Securitize token' },
  governor: LIQUITY_HUB_GOVERNOR,
} as unknown as SecuritizeCollateralVault

const identified = new Set<string>()

beforeEach(() => {
  identified.clear()
  __setEulerLabelsDataForTest({
    source: 'v3',
    entities: { [LIQUITY_HUB_ENTITY]: { name: 'K3 Capital', addresses: { [LIQUITY_HUB_GOVERNOR]: 'K3 governor' } } },
    managingEntityByVault: { [SECURITIZE.toLowerCase()]: LIQUITY_HUB_ENTITY },
  } as unknown as Partial<PublicEulerLabelsData>)
  vi.stubGlobal('useVaults', () => ({
    isVaultGovernorIdentified: () => true,
    isSecuritizeGovernorIdentified: (vault: { address: string }) => identified.has(vault.address.toLowerCase()),
  }))
  vi.stubGlobal('useVaultRegistry', () => ({ getVaultCategory: () => 'standard' }))
  vi.stubGlobal('useCollateralOpenInterest', () => ({
    load: vi.fn(),
    getOpenInterestForVault: () => ({}),
    hasError: ref(false),
    isLoaded: ref(false),
    isOpenInterestEnabled: ref(false),
  }))
})

afterEach(() => vi.unstubAllGlobals())

const renderConfigMatrix = () => {
  const market = { ...makeLiquityHubOnDemandMarket([makeEusdc42()]), externalCollateral: [securitize] }
  const app = createSSRApp({
    render: () => h(DiscoveryMarketAttributeMatrix, {
      data: getAttributeMatrix(market, 'config'),
      view: 'config',
      usdCache: new Map(),
      apyCache: new Map(),
      badDebtCache: new Map(),
      isBadDebtLoading: false,
      showBadDebtColumn: false,
      selectedHeader: null,
      resolveVault: getMarketVaultResolver(market, () => undefined),
    }),
  })
  app.config.warnHandler = () => undefined
  app.component('VaultTypeChip', { props: ['type'], setup: (props: { type: string }) => () => h('span', { 'data-test-chip': props.type }) })
  return renderToString(app)
}

const securitizeRow = (html: string) => {
  const start = html.indexOf('STAC')
  return start < 0 ? '' : html.slice(start, html.indexOf('</tr>', start))
}

describe('Governor cell of a Securitize collateral in the configuration matrix', () => {
  it('reads Unknown until the Securitize governor is identified', async () => {
    const row = securitizeRow(await renderConfigMatrix())

    expect(row).toContain('data-test-chip="unknown"')
    expect(row).not.toContain('K3 Capital')
  })

  it('names the curator once the Securitize governor is identified', async () => {
    identified.add(SECURITIZE.toLowerCase())
    const row = securitizeRow(await renderConfigMatrix())

    expect(row).toContain('K3 Capital')
    expect(row).not.toContain('data-test-chip="unknown"')
  })
})
