import { computed, ref, shallowRef, watch, watchEffect } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault, PortfolioBorrowPosition, PortfolioSavingsPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useSavingsRepay } from '~/composables/repay/useSavingsRepay'

const { USER, VAULT, sameVault, mocks } = vi.hoisted(() => {
  const USER = '0x0000000000000000000000000000000000000001'
  const VAULT = '0x0000000000000000000000000000000000000002'
  const ASSET = '0x0000000000000000000000000000000000000003'
  const sameVault = {
    address: VAULT,
    totalCash: 100n,
    availableLiquidity: 100n,
    asset: {
      address: ASSET,
      symbol: 'USDe',
      decimals: 0,
    },
    shares: {
      address: VAULT,
      symbol: 'eUSDe',
      decimals: 0,
    },
    collaterals: [],
  } as unknown as EVault

  return {
    USER,
    VAULT,
    sameVault,
    mocks: {
      getSavingsPosition: vi.fn(),
      runSimulation: vi.fn(),
    },
  }
})

vi.mock('@wagmi/vue', () => ({
  useAccount: () => ({
    isConnected: ref(true),
    address: ref(USER),
  }),
}))

vi.mock('#components', () => ({
  OperationReviewModal: {},
}))

vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({
    open: vi.fn(),
    close: vi.fn(),
  }),
}))

vi.mock('~/components/ui/composables/useToast', () => ({
  useToast: () => ({
    error: vi.fn(),
  }),
}))

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValue: vi.fn(async () => null),
}))

vi.mock('~/composables/repay/useRepaySwapDetails', () => ({
  useRepaySwapDetails: () => ({
    currentPrice: ref(null),
    summary: ref([]),
    priceImpact: ref(null),
    leveragedPriceImpact: ref(null),
    routedVia: ref(null),
    routeEmptyMessage: ref(null),
    routeItems: ref([]),
  }),
}))

vi.mock('~/composables/repay/useRepayHealthMetrics', () => ({
  useRepayHealthMetrics: () => ({
    roeBefore: ref(null),
    roeAfter: ref(null),
    currentHealth: ref(null),
    currentLtv: ref(null),
    nextLtv: ref(null),
    nextHealth: ref(null),
    currentLiquidationPrice: ref(null),
    nextLiquidationPrice: ref(null),
  }),
}))

vi.mock('~/composables/useEulerLabels', () => ({
  useEulerProductOfVault: () => computed(() => 'Euler Yield'),
}))

vi.mock('~/composables/useRepaySavingsOptions', () => ({
  useRepaySavingsOptions: () => {
    const savingsVaults = ref([sameVault])
    const savingsPosition = {
      position: {},
      vault: sameVault,
      subAccount: USER,
      assets: 1_000n,
      shares: 1_000n,
    } as PortfolioSavingsPosition<VaultEntity>

    mocks.getSavingsPosition.mockImplementation((vaultAddress: string) =>
      vaultAddress.toLowerCase() === VAULT.toLowerCase() ? savingsPosition : undefined,
    )

    return {
      savingsPositions: ref([savingsPosition]),
      savingsVaults,
      savingsOptions: ref([]),
      getSavingsPosition: mocks.getSavingsPosition,
    }
  },
}))

const position = {
  borrow: sameVault,
  collateral: sameVault,
  subAccount: USER,
  borrowed: 2_000n,
  supplied: 0n,
  collaterals: [],
  health: 0n,
  userLTV: 0n,
  price: 0n,
  borrowLTV: 0n,
  liquidationLTV: 0n,
  initialLiquidationLTV: 0n,
  targetLiquidationLTV: 0n,
  targetTimestamp: 0n,
  rampDuration: 0n,
  liabilityValueBorrowing: 0n,
  liabilityValueLiquidation: 0n,
  timeToLiquidation: 0n,
  collateralValueLiquidation: 0n,
  collateralVaults: [],
  liquidatable: false,
} as unknown as PortfolioBorrowPosition<VaultEntity>

describe('useSavingsRepay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('usePriceInvert', () => ({ autoInvert: vi.fn() }))
    vi.stubGlobal('useEulerOperations', () => ({
      buildSwapPlan: vi.fn(),
      buildSavingsRepayPlan: vi.fn(),
      buildSavingsFullRepayPlan: vi.fn(),
      buildSwapFullRepayPlan: vi.fn(),
      executeTxPlan: vi.fn(),
    }))
    vi.stubGlobal('useEulerAccount', () => ({ refreshAllPositions: vi.fn() }))
    vi.stubGlobal('useEulerAddresses', () => ({ eulerLensAddresses: ref({}) }))
    vi.stubGlobal('useVaultRegistry', () => ({ getVault: vi.fn() }))
    vi.stubGlobal('useTxFinalization', () => ({ finalizeTxAndRedirect: vi.fn() }))
    vi.stubGlobal('useSwapApi', () => ({
      getSwapProviders: vi.fn(async () => []),
      getSwapQuotes: vi.fn(async () => []),
    }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref(null) }))
    vi.stubGlobal('useWagmi', () => ({
      address: ref(USER),
      chain: ref({ nativeCurrency: { decimals: 18 } }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('skips the cash cap for same-vault savings repay max amount', () => {
    const repay = useSavingsRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => sameVault),
      collateralVault: computed(() => sameVault),
      formTab: ref('savings'),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0.5),
      oraclePriceRatio: computed(() => 1),
      clearSimulationError: vi.fn(),
      runSimulation: mocks.runSimulation,
      getCurrentDebt: () => position.borrowed,
      collateralSupplyApy: computed(() => 0),
      borrowApy: computed(() => 0),
    })

    repay.initVault()

    expect(repay.sourceVault.value?.address).toBe(VAULT)
    expect(repay.sourceBalance.value).toBe(1_000n)

    repay.onSourceMax()

    expect(repay.amount.value).toBe('1000')
    expect(repay.isSubmitDisabled.value).toBe(false)
    expect(repay.disabledReason.value).toBeUndefined()
  })
})
