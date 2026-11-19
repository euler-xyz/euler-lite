import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { useBestMaxROE } from '~/composables/useBestMaxROE'
import {
  BOLD,
  NO_OPERATIONS_HOOKED,
  SBOLD,
  USDC,
  makeLiquityHubOnDemandMarket,
  makeLiquityHubVaults,
} from '~/tests/fixtures/liquity-hub'

vi.mock('~/utils/collateralOptions', () => ({
  computeSupplyApy: (vault: EVault) => vault.interestRates.supplyAPY,
  computeBorrowApy: (vault: EVault) => vault.interestRates.borrowAPY,
  sumBorrowRewardApr: () => 0,
  sumLoopingRewardApr: () => 0,
}))

const USD_TOKENS = new Set([USDC.address, BOLD.address, SBOLD.address].map(address => address.toLowerCase()))

const withRates = (vaults: EVault[]): EVault[] => vaults.map(vault => Object.assign(vault, {
  interestRates: { supplyAPY: vault.asset.symbol === 'sBOLD' ? 8 : 3, borrowAPY: 4 },
}))

const headline = (vaults: EVault[]) => {
  const market = makeLiquityHubOnDemandMarket(withRates(vaults))
  return useBestMaxROE(ref([market])).getBestMaxROE(market.id)
}

beforeEach(() => {
  vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false, enableRewardsApy: false }) }))
  vi.stubGlobal('useApyVisibility', () => ({ viewer: ref(undefined) }))
  vi.stubGlobal('useTokenList', () => ({
    getTokenCategoryTags: (address: string) => USD_TOKENS.has(address.toLowerCase()) ? ['usd'] : [],
  }))
  vi.stubGlobal('ltvToPercent', (ltv: number) => ltv * 100)
})

afterEach(() => vi.unstubAllGlobals())

describe('product Max ROE on a paused product (K3 Liquity Hub)', () => {
  it('leads with the best correlated pair while the vaults are live', () => {
    const best = headline(makeLiquityHubVaults({ hookedOperations: NO_OPERATIONS_HOOKED }))

    expect(best.metric).toBe('max-roe')
    expect(best.pair).toBe('sBOLD/BOLD')
    expect(best.value).toBeGreaterThan(0)
  })

  it('has no headline when every pair is paused', () => {
    const best = headline(makeLiquityHubVaults())

    expect(best.value).toBe(0)
    expect(best.pair).toBe('')
  })

  it('skips a pair whose liability is paused even when the collateral is live', () => {
    const vaults = makeLiquityHubVaults({ hookedOperations: NO_OPERATIONS_HOOKED })
    const [eusdc42, , esbold1, ...rest] = vaults
    const pausedEbold1 = makeLiquityHubVaults()[1]
    const best = headline([eusdc42, pausedEbold1, esbold1, ...rest])

    expect(best.pair).toBe('sBOLD/USDC')
  })
})
