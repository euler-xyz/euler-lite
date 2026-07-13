import { computed, nextTick, ref, shallowRef, watch, watchEffect } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, EVault, IHasVaultAddress, PortfolioBorrowPosition, PortfolioSavingsPosition, SwapQuote, TransactionPlan, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useSavingsRepay } from '~/composables/repay/useSavingsRepay'

const { USER, VAULT, sameVault, borrowVault, planAccount, mocks } = vi.hoisted(() => {
  const USER = '0x0000000000000000000000000000000000000001'
  const VAULT = '0x0000000000000000000000000000000000000002'
  const ASSET = '0x0000000000000000000000000000000000000003'
  const BORROW_VAULT = '0x0000000000000000000000000000000000000004'
  const BORROW_ASSET = '0x0000000000000000000000000000000000000005'
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
  const borrowVault = {
    ...sameVault,
    address: BORROW_VAULT,
    asset: {
      address: BORROW_ASSET,
      symbol: 'WETH',
      decimals: 0,
    },
    shares: {
      address: BORROW_VAULT,
      symbol: 'eWETH',
      decimals: 0,
    },
  } as unknown as EVault

  return {
    USER,
    VAULT,
    sameVault,
    borrowVault,
    planAccount: { chainId: 1 } as Account<IHasVaultAddress>,
    mocks: {
      swapQuoteOptions: [] as Array<{
        buildTxPlanForQuote?: (quote: SwapQuote, provider: string, context: { account?: Account<IHasVaultAddress> }) => Promise<TransactionPlan>
        getPlanAccount?: () => Account<IHasVaultAddress> | string | undefined
      }>,
      getSavingsPosition: vi.fn(),
      planRepayFromSource: vi.fn(),
      runSimulation: vi.fn(),
      getCollateralApySnapshot: vi.fn(),
      healthOptions: [] as Array<{
        repayAddsCash?: { value: boolean }
        collateralValueUsd?: { value: number | null }
        collateralAddresses?: { value: string[] }
        collateralSnapshotComplete?: { value: boolean }
      }>,
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
  useRepayHealthMetrics: (options: {
    repayAddsCash?: { value: boolean }
    collateralValueUsd?: { value: number | null }
    collateralAddresses?: { value: string[] }
    collateralSnapshotComplete?: { value: boolean }
  }) => {
    mocks.healthOptions.push(options)
    return {
      roeBefore: ref(null),
      roeAfter: ref(null),
      currentHealth: ref(null),
      currentLtv: ref(null),
      nextLtv: ref(null),
      nextHealth: ref(null),
      currentLiquidationPrice: ref(null),
      nextLiquidationPrice: ref(null),
    }
  },
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

vi.mock('~/composables/useSwapQuotesParallel', () => ({
  useSwapQuotesParallel: (options: {
    buildTxPlanForQuote?: (quote: SwapQuote, provider: string, context: { account?: Account<IHasVaultAddress> }) => Promise<TransactionPlan>
  }) => {
    mocks.swapQuoteOptions.push(options)
    return {
      sortedQuoteCards: ref([]),
      selectedProvider: ref(null),
      selectedQuote: ref(null),
      effectiveQuote: ref(null),
      effectiveQuoteFetchedAt: ref(null),
      providersCount: ref(0),
      isLoading: ref(false),
      quoteError: ref(null),
      statusLabel: ref(null),
      getQuoteDiffPct: vi.fn(() => null),
      reset: vi.fn(),
      requestQuotes: vi.fn(),
      selectProvider: vi.fn(),
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
    mocks.swapQuoteOptions.length = 0
    mocks.healthOptions.length = 0
    mocks.planRepayFromSource.mockResolvedValue({ type: 'repay-plan' } as unknown as TransactionPlan)
    mocks.getCollateralApySnapshot.mockResolvedValue({
      supplyUsd: 0,
      weightedSupplyApy: 0,
      collateralAddresses: [],
      isComplete: true,
    })
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('usePriceInvert', () => ({ autoInvert: vi.fn() }))
    vi.stubGlobal('useEulerTx', () => ({
      planRepayFromDeposit: vi.fn(),
      planRepayWithSwap: vi.fn(),
      planRepayFromSource: mocks.planRepayFromSource,
      executePlan: vi.fn(),
      prefetchPluginData: vi.fn(),
    }))
    vi.stubGlobal('usePlanAccount', () => ({
      account: shallowRef(planAccount),
    }))
    vi.stubGlobal('useEulerAddresses', () => ({ eulerLensAddresses: ref({}) }))
    vi.stubGlobal('useVaultRegistry', () => ({ getVault: vi.fn() }))
    vi.stubGlobal('useTxFinalization', () => ({ finalizeTxAndRedirect: vi.fn() }))
    vi.stubGlobal('usePositionCollateralApy', () => ({
      getCollateralApySnapshot: mocks.getCollateralApySnapshot,
    }))
    vi.stubGlobal('useSwapApi', () => ({
      getSwapProviders: vi.fn(async () => []),
      getSwapQuotes: vi.fn(async () => []),
    }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref(null) }))
    vi.stubGlobal('useWagmi', () => ({
      address: ref(USER),
      isConnected: ref(true),
      chain: ref({ nativeCurrency: { decimals: 18 } }),
    }))
    vi.stubGlobal('useSpyMode', () => ({
      isSpyMode: ref(false),
      spyAddress: ref(null),
    }))
    vi.stubGlobal('useEffectiveAddress', () => ({
      address: ref(USER),
      isConnected: ref(true),
      isSpyMode: ref(false),
      spyAddress: ref(null),
      effectiveAddress: ref(USER),
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
      borrowRewardApy: computed(() => 0),
    })

    repay.initVault()

    expect(repay.sourceVault.value?.address).toBe(VAULT)
    expect(repay.sourceBalance.value).toBe(1_000n)

    repay.onSourceMax()

    expect(repay.amount.value).toBe('1000')
    expect(repay.isSubmitDisabled.value).toBe(false)
    expect(repay.disabledReason.value).toBeUndefined()
    expect(mocks.healthOptions[0]?.repayAddsCash?.value).toBe(false)
  })

  it('builds quote-time gas estimation plans from the candidate savings repay quote', async () => {
    const repay = useSavingsRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
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
      borrowRewardApy: computed(() => 0),
    })

    repay.initVault()

    const quote = { amountIn: '100', amountOut: '200' } as SwapQuote
    const plan = await mocks.swapQuoteOptions[0]?.buildTxPlanForQuote?.(quote, 'provider', { account: planAccount })

    expect(mocks.planRepayFromSource).toHaveBeenCalledWith(expect.objectContaining({
      fromVault: VAULT,
      fromAccount: USER,
      liabilityVault: borrowVault.address,
      receiver: USER,
      swapQuote: quote,
      account: planAccount,
    }))
    expect(mocks.swapQuoteOptions[0]?.getPlanAccount?.()).toBe(planAccount)
    expect(plan).toEqual({ type: 'repay-plan' })
  })

  it('keeps collateral summary cleared when an in-flight snapshot resolves after invalidation', async () => {
    let resolveSnapshot: ((value: {
      supplyUsd: number
      weightedSupplyApy: number
      collateralAddresses: string[]
      isComplete: boolean
    }) => void) | undefined
    mocks.getCollateralApySnapshot.mockReturnValueOnce(new Promise((resolve) => {
      resolveSnapshot = resolve
    }))
    const positionRef = shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position)

    useSavingsRepay({
      position: positionRef,
      borrowVault: computed(() => borrowVault),
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
      borrowRewardApy: computed(() => 0),
    })

    expect(mocks.getCollateralApySnapshot).toHaveBeenCalledTimes(1)
    positionRef.value = undefined
    await nextTick()

    resolveSnapshot?.({
      supplyUsd: 123,
      weightedSupplyApy: 4.5,
      collateralAddresses: [VAULT],
      isComplete: true,
    })
    await Promise.resolve()
    await nextTick()

    const healthOptions = mocks.healthOptions[0]
    expect(healthOptions?.collateralValueUsd?.value).toBeNull()
    expect(healthOptions?.collateralAddresses?.value).toEqual([])
    expect(healthOptions?.collateralSnapshotComplete?.value).toBe(false)
  })

  it('projects a savings-vault cash withdrawal when that vault is also position collateral', async () => {
    const sameAssetBorrowVault = {
      ...borrowVault,
      asset: sameVault.asset,
    } as EVault
    const overlapPosition = {
      ...position,
      borrow: sameAssetBorrowVault,
      collateralVaults: [VAULT],
    } as unknown as PortfolioBorrowPosition<VaultEntity>
    const repay = useSavingsRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(overlapPosition),
      borrowVault: computed(() => sameAssetBorrowVault),
      collateralVault: computed(() => sameVault),
      formTab: ref('savings'),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0.5),
      oraclePriceRatio: computed(() => 1),
      clearSimulationError: vi.fn(),
      runSimulation: mocks.runSimulation,
      getCurrentDebt: () => overlapPosition.borrowed,
      collateralSupplyApy: computed(() => 0),
      borrowApy: computed(() => 0),
      borrowRewardApy: computed(() => 0),
    })

    repay.initVault()
    mocks.getCollateralApySnapshot.mockClear()
    repay.amount.value = '100'
    repay.onAmountInput()

    await vi.waitFor(() => expect(mocks.getCollateralApySnapshot).toHaveBeenCalledWith(
      overlapPosition,
      sameAssetBorrowVault,
      {
        deltas: [{
          vaultAddress: VAULT,
          assetsDelta: 0n,
          cashDelta: -100n,
          projectRates: true,
        }],
      },
    ))
  })
})
