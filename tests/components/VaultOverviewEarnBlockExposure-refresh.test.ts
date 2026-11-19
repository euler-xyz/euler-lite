import { createRenderer, h, nextTick, ref, shallowRef, ssrContextKey } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EulerEarn, EVault } from '@eulerxyz/euler-v2-sdk'
import VaultOverviewEarnBlockExposure from '~/components/entities/vault/overview/earn/VaultOverviewEarnBlockExposure.vue'
import { UNCOVERED_EXPOSURE_LABEL, type VaultExposureDisplayItem } from '~/utils/vault/exposure-display'
import { EBOLD_1, EUSDC_42, NO_OPERATIONS_HOOKED, makeEbold1, makeEusdc42 } from '~/tests/fixtures/liquity-hub'

const ebold1 = makeEbold1({ hookedOperations: NO_OPERATIONS_HOOKED })

vi.mock('#components', () => ({ VaultApyModal: {}, UiModalPreviewTrigger: { render: () => null } }))
vi.mock('~/composables/useVaultWarnings', () => ({ getStrategyHookWarning: () => null }))
vi.mock('~/composables/useVaultRegistry', () => ({
  useVaultRegistry: () => ({
    getOrFetch: vi.fn(),
    get: (address: string) => address.toLowerCase() === EBOLD_1.toLowerCase() ? { vault: ebold1 } : undefined,
    isVerifiedVault: () => false,
  }),
}))
const pricing = vi.hoisted(() => ({ held: new Set<object>(), releases: [] as Array<() => void> }))

vi.mock('~/utils/sdk-prices', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/sdk-prices')>()),
  getAssetUsdValue: (amount: bigint, vault: EVault) => {
    const usd = Number(amount) / 10 ** vault.asset.decimals
    if (!pricing.held.has(vault)) return Promise.resolve(usd)
    return new Promise<number>(resolve => pricing.releases.push(() => resolve(usd)))
  },
}))

const usdc = (value: number) => BigInt(value) * 1_000_000n

// $2,000 of supply, $80 of V3 bad debt and $20 of V3 open interest throughout; only the borrows change.
const strategyVault = (borrowsUsd: number): EVault => Object.assign(makeEusdc42({ hookedOperations: NO_OPERATIONS_HOOKED }), {
  totalAssets: usdc(2_000),
  totalBorrowed: usdc(borrowsUsd),
  utilization: borrowsUsd / 2_000 * 100,
  interestRates: { supplyAPY: 0, borrowAPY: 0 },
})

const earnVault = (strategy: EVault): EulerEarn => ({
  address: '0x00000000000000000000000000000000000000e1',
  strategies: [{
    address: EUSDC_42,
    vault: strategy,
    allocatedAssets: usdc(2_000),
    allocationCap: { current: 2n ** 136n - 1n },
    removableAt: 0,
  }],
}) as unknown as EulerEarn

type ExposureBlockState = {
  headerAssetsByStrategy: Map<string, { label?: string }>
  getStrategyExposureDisplay: (vault: EVault | undefined) => { items: VaultExposureDisplayItem[] }
  exposureRows: Array<{ vault?: EVault }>
}

// The SFC compiles for SSR under vitest, so the block runs with its real setup and watchers but no
// template, and the test reads the same state the template binds to the header and the breakdown.
const mount = (props: { value: { vault: EulerEarn } }) => {
  const renderer = createRenderer<object, object>({
    patchProp: () => {}, insert: () => {}, remove: () => {},
    createElement: (type: string) => ({ type }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), setText: () => {}, setElementText: () => {},
    parentNode: () => null, nextSibling: () => null,
  })
  const block = { ...VaultOverviewEarnBlockExposure, render: () => null }
  const app = renderer.createApp({ render: () => h(block, props.value) })
  app.provide(ssrContextKey, {})
  app.mount({ type: 'root' })
  const state = () => ((app._instance?.subTree.component as { setupState?: unknown } | null)?.setupState ?? {}) as ExposureBlockState
  return { app, state }
}

const read = (state: ExposureBlockState) => {
  const strategy = state.exposureRows[0]?.vault
  const items = state.getStrategyExposureDisplay(strategy).items
  const valueOf = (label: string) => items.find(item => (item.label ?? item.asset.symbol) === label)?.valueUsd ?? 0
  return {
    uncovered: valueOf(UNCOVERED_EXPOSURE_LABEL),
    bold: valueOf('BOLD'),
    label: strategy ? state.headerAssetsByStrategy.get(strategy.address.toLowerCase())?.label : undefined,
  }
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  pricing.held.clear()
  pricing.releases.splice(0)
  vi.stubGlobal('useCollateralOpenInterest', () => ({
    load: vi.fn(),
    getOpenInterestForVault: (address: string) => address.toLowerCase() === EUSDC_42.toLowerCase() ? { [EBOLD_1]: 20 } : {},
    hasError: ref(false),
    isLoaded: ref(true),
    isOpenInterestEnabled: ref(true),
  }))
  vi.stubGlobal('useVaultBadDebt', () => ({
    getVaultBadDebt: (address: string) => address.toLowerCase() === EUSDC_42.toLowerCase() ? { badDebtUsd: 80 } : undefined,
    isBadDebtEnabled: ref(false),
    isBadDebtLoading: ref(false),
    loadBadDebtForChain: vi.fn(),
  }))
  vi.stubGlobal('useVaults', () => ({ isEscrowLoadedOnce: ref(true), isMarketDataResolved: ref(true) }))
  vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false }) }))
  vi.stubGlobal('useRewardsApy', () => ({ getSupplyRewardApy: () => 0, hasSupplyRewards: () => false, getSupplyRewardCampaigns: () => [] }))
  vi.stubGlobal('until', () => ({ toBe: async () => {} }))
  vi.stubGlobal('getVaultSupplyApy', () => 0)
})

afterEach(() => vi.unstubAllGlobals())

describe('Earn strategy header after the strategy vault refreshes', () => {
  it('reprices the strategy so the header and the breakdown agree', async () => {
    const props = shallowRef({ vault: earnVault(strategyVault(100)) })
    const { app, state } = mount(props)
    await settle()

    expect(read(state())).toEqual({ uncovered: expect.closeTo(80, 6), bold: expect.closeTo(20, 6), label: 'Mostly uncovered debt; rest backed by BOLD' })

    props.value = { vault: earnVault(strategyVault(1_000)) }
    await settle()

    expect(read(state())).toEqual({ uncovered: expect.closeTo(80, 6), bold: expect.closeTo(920, 6), label: 'Backed by BOLD' })
    app.unmount()
  })

  it('keeps the newer pricing when an older one answers last', async () => {
    const slow = strategyVault(100)
    pricing.held.add(slow)
    const props = shallowRef({ vault: earnVault(slow) })
    const { app, state } = mount(props)
    await settle()

    props.value = { vault: earnVault(strategyVault(1_000)) }
    await settle()
    pricing.releases.splice(0).forEach(release => release())
    await settle()

    expect(read(state())).toEqual({ uncovered: expect.closeTo(80, 6), bold: expect.closeTo(920, 6), label: 'Backed by BOLD' })
    app.unmount()
  })
})
