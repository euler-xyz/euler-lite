import { computed, ref, shallowRef, watch, watchEffect, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, EVault, IHasVaultAddress, PortfolioBorrowPosition, SwapQuote, TransactionPlan, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useWalletSwapRepay } from '~/composables/repay/useWalletSwapRepay'

const { USER, borrowVault, collateralVault, walletAsset, planAccount, mocks } = vi.hoisted(() => {
  const USER = '0x0000000000000000000000000000000000000001' as `0x${string}`
  const BORROW_VAULT = '0x0000000000000000000000000000000000000002' as `0x${string}`
  const BORROW_ASSET = '0x0000000000000000000000000000000000000003' as `0x${string}`
  const COLLATERAL_VAULT = '0x0000000000000000000000000000000000000004' as `0x${string}`
  const COLLATERAL_ASSET = '0x0000000000000000000000000000000000000005' as `0x${string}`
  const WALLET_ASSET = '0x0000000000000000000000000000000000000006' as `0x${string}`

  const borrowVault = {
    address: BORROW_VAULT,
    totalCash: 100n,
    totalBorrowed: 100n,
    availableLiquidity: 100n,
    asset: {
      address: BORROW_ASSET,
      symbol: 'USDC',
      decimals: 0,
    },
    shares: {
      address: BORROW_VAULT,
      symbol: 'eUSDC',
      decimals: 0,
    },
    collaterals: [],
  } as unknown as EVault
  const collateralVault = {
    ...borrowVault,
    address: COLLATERAL_VAULT,
    asset: {
      address: COLLATERAL_ASSET,
      symbol: 'WETH',
      decimals: 0,
    },
    shares: {
      address: COLLATERAL_VAULT,
      symbol: 'eWETH',
      decimals: 0,
    },
  } as unknown as EVault

  return {
    USER,
    borrowVault,
    collateralVault,
    walletAsset: {
      address: WALLET_ASSET,
      name: 'Dai Stablecoin',
      symbol: 'DAI',
      decimals: 0,
    },
    planAccount: { chainId: 1 } as Account<IHasVaultAddress>,
    mocks: {
      swapQuoteOptions: [] as Array<{
        buildTxPlanForQuote?: (quote: SwapQuote, provider: string, context: { account?: Account<IHasVaultAddress> }) => Promise<TransactionPlan>
        getPlanAccount?: () => Account<IHasVaultAddress> | string | undefined
      }>,
      quoteStates: [] as Array<{
        selectedQuote: Ref<SwapQuote | null>
        effectiveQuote: Ref<SwapQuote | null>
      }>,
      planSwapAndRepay: vi.fn(),
      runSimulation: vi.fn(),
      getCollateralApySnapshot: vi.fn(),
      getNetAPYFromWeightedSupplySnapshot: vi.fn(() => 10),
      getAssetUsdValueForEstimate: vi.fn(async () => 0 as number | undefined),
    },
  }
})
const rewardsVersion = ref(0)

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

vi.mock('~/utils/vault/apy', () => ({
  getNetAPY: vi.fn(() => 0),
  getNetAPYFromWeightedSupplySnapshot: mocks.getNetAPYFromWeightedSupplySnapshot,
  getPositionMultiplier: vi.fn(() => 1),
}))

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValue: vi.fn(async () => null),
  getAssetUsdValueForEstimate: mocks.getAssetUsdValueForEstimate,
  getTokenUsdValue: vi.fn(async () => null),
}))

vi.mock('~/utils/position-estimates', () => ({
  getTotalCollateralValue: vi.fn(() => 10_000),
}))

vi.mock('~/utils/ltv', () => ({
  getBorrowPositionEffectiveLiquidationLTV: vi.fn(() => 0.8),
  decimalLtvToBps: vi.fn(() => 8_000n),
}))

vi.mock('~/utils/vault-display', () => ({
  getVaultBorrowApy: vi.fn(() => 5),
}))

vi.mock('~/utils/vault-intrinsic-apy', () => ({
  withProjectedVaultIntrinsicApy: vi.fn((_current: number, projected: number) => projected),
}))

vi.mock('~/composables/useSwapPriceImpact', () => ({
  useSwapPriceImpact: () => ({
    priceImpact: ref(null),
  }),
}))

vi.mock('~/composables/useStateOverrideOptions', () => ({
  useStateOverrideOptions: () => ({
    primeSlotHintsFor: vi.fn(),
    buildStateOverrideOptions: vi.fn(() => ({})),
  }),
}))

vi.mock('~/composables/useSwapQuotesParallel', () => ({
  useSwapQuotesParallel: (options: {
    buildTxPlanForQuote?: (quote: SwapQuote, provider: string, context: { account?: Account<IHasVaultAddress> }) => Promise<TransactionPlan>
    getPlanAccount?: () => Account<IHasVaultAddress> | string | undefined
  }) => {
    mocks.swapQuoteOptions.push(options)
    const state = {
      sortedQuoteCards: ref([]),
      selectedProvider: ref(null),
      selectedQuote: ref<SwapQuote | null>(null),
      effectiveQuote: ref<SwapQuote | null>(null),
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
    mocks.quoteStates.push(state)
    return state
  },
}))

const position = {
  borrow: borrowVault,
  collateral: collateralVault,
  subAccount: USER,
  borrowed: 2_000n,
  supplied: 5_000n,
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

const makeCollateralSnapshot = (projected: boolean) => ({
  supplyUsd: 10_000,
  weightedSupplyApy: 5,
  weightedBaseSupplyApy: 5,
  weightedIntrinsicSupplyApy: 0,
  weightedSupplyRewardApy: 0,
  collateralAddresses: [collateralVault.address],
  entries: [],
  liabilityProjectedRates: projected
    ? { supplyAPY: 0n, borrowAPY: 7n * 10n ** 25n }
    : null,
  isComplete: true,
})

describe('useWalletSwapRepay', () => {
  beforeEach(() => {
    vi.stubGlobal('useOperationIntentFactory', () => ({ create: vi.fn() }))
    vi.stubGlobal('useExecutionReview', () => ({ open: vi.fn() }))
    vi.clearAllMocks()
    mocks.swapQuoteOptions.length = 0
    mocks.quoteStates.length = 0
    mocks.planSwapAndRepay.mockResolvedValue({ type: 'wallet-swap-repay-plan' } as unknown as TransactionPlan)
    mocks.getCollateralApySnapshot.mockImplementation(async (_position, _vault, options?: { liabilityRateDelta?: unknown }) =>
      makeCollateralSnapshot(Boolean(options?.liabilityRateDelta)),
    )
    mocks.getNetAPYFromWeightedSupplySnapshot.mockReturnValue(10)
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(0)
    rewardsVersion.value = 0
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('getVaultBorrowApy', () => 5)
    vi.stubGlobal('nanoToValue', () => 7)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('useEulerTx', () => ({
      planSwapAndRepay: mocks.planSwapAndRepay,
      executePlan: vi.fn(),
      prefetchPluginData: vi.fn(),
    }))
    vi.stubGlobal('useStateOverrideOptions', () => ({
      primeSlotHintsFor: vi.fn(),
      buildStateOverrideOptions: vi.fn(() => ({})),
    }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('useWagmi', () => ({
      address: ref(USER),
      isConnected: ref(true),
    }))
    vi.stubGlobal('useSpyMode', () => ({
      isSpyMode: ref(false),
      spyAddress: ref(undefined),
    }))
    vi.stubGlobal('useEffectiveAddress', () => ({
      address: ref(USER),
      isConnected: ref(true),
      isSpyMode: ref(false),
      spyAddress: ref(undefined),
      effectiveAddress: ref(USER),
    }))
    vi.stubGlobal('usePlanAccount', () => ({
      account: shallowRef(planAccount),
    }))
    vi.stubGlobal('useWallets', () => ({
      getBalance: vi.fn(() => 1_000n),
      fetchSingleBalance: vi.fn(async () => 1_000n),
    }))
    vi.stubGlobal('useTxFinalization', () => ({ finalizeTxAndRedirect: vi.fn() }))
    vi.stubGlobal('useVaultRegistry', () => ({ getVault: vi.fn() }))
    vi.stubGlobal('usePositionCollateralApy', () => ({
      getCollateralApySnapshot: mocks.getCollateralApySnapshot,
    }))
    vi.stubGlobal('useRewardsApy', () => ({
      version: rewardsVersion,
      getBorrowRewardApyForCollaterals: vi.fn(() => 0),
      getEligibleLoopingRewardApyForCollaterals: vi.fn(() => 0),
      getBorrowRewardCampaignsForCollaterals: vi.fn(() => []),
      getEligibleLoopingRewardCampaignsForCollaterals: vi.fn(() => []),
    }))
    vi.stubGlobal('useUserSettings', () => ({
      settings: ref({ enableIntrinsicApy: false }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('builds quote-time wallet swap repay plans with the prefetched account', async () => {
    const repay = useWalletSwapRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => collateralVault),
      formTab: ref('wallet'),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      runSimulation: mocks.runSimulation,
      netAPY: ref(0),
      collateralSupplyApy: computed(() => 0),
      borrowApy: computed(() => 0),
      collateralSupplyRewardApy: computed(() => 0),
      borrowRewardApy: computed(() => 0),
      oraclePriceRatio: computed(() => 1),
    })

    repay.selectedAsset.value = walletAsset

    const quote = {
      amountIn: '100',
      amountOut: '200',
      amountOutMin: '190',
      receiver: borrowVault.address,
      accountOut: USER,
    } as SwapQuote
    const plan = await mocks.swapQuoteOptions[0]?.buildTxPlanForQuote?.(quote, 'provider', { account: planAccount })

    expect(mocks.planSwapAndRepay).toHaveBeenCalledWith(expect.objectContaining({
      swapQuote: quote,
      amount: 100n,
      tokenIn: walletAsset.address,
      liabilityVault: borrowVault.address,
      repayAccount: USER,
      account: planAccount,
    }))
    expect(mocks.swapQuoteOptions[0]?.getPlanAccount?.()).toBe(planAccount)
    expect(plan).toEqual({ type: 'wallet-swap-repay-plan' })
  })

  it('clears an earlier Net APY estimate when the next projection rejects', async () => {
    const repay = useWalletSwapRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => collateralVault),
      formTab: ref('wallet'),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      runSimulation: mocks.runSimulation,
      netAPY: ref(1),
      collateralSupplyApy: computed(() => 5),
      borrowApy: computed(() => 5),
      collateralSupplyRewardApy: computed(() => 0),
      borrowRewardApy: computed(() => 0),
      oraclePriceRatio: computed(() => 1),
    })
    repay.selectedAsset.value = walletAsset
    repay.amount.value = '100'

    const firstQuote = {
      amountIn: '100',
      amountOut: '200',
      amountOutMin: '190',
      receiver: borrowVault.address,
      accountOut: USER,
    } as SwapQuote
    mocks.quoteStates[0]!.selectedQuote.value = firstQuote
    mocks.quoteStates[0]!.effectiveQuote.value = firstQuote

    await vi.waitFor(() => expect(repay.estimateNetAPY.value).toBe(5))

    mocks.getCollateralApySnapshot
      .mockResolvedValueOnce(makeCollateralSnapshot(false))
      .mockRejectedValueOnce(new Error('projection failed'))
    mocks.quoteStates[0]!.effectiveQuote.value = { ...firstQuote, amountOut: '210' } as SwapQuote

    await vi.waitFor(() => expect(repay.estimateNetAPY.value).toBeNull())
  })

  it('keeps projected yield unavailable when positive debt has no USD price', async () => {
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(undefined)
    const repay = useWalletSwapRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => collateralVault),
      formTab: ref('wallet'),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      runSimulation: mocks.runSimulation,
      netAPY: ref(1),
      collateralSupplyApy: computed(() => 5),
      borrowApy: computed(() => 5),
      collateralSupplyRewardApy: computed(() => 0),
      borrowRewardApy: computed(() => 0),
      oraclePriceRatio: computed(() => 1),
    })
    repay.selectedAsset.value = walletAsset
    repay.amount.value = '100'

    const quote = {
      amountIn: '100',
      amountOut: '200',
      amountOutMin: '190',
      receiver: borrowVault.address,
      accountOut: USER,
    } as SwapQuote
    mocks.quoteStates[0]!.selectedQuote.value = quote
    mocks.quoteStates[0]!.effectiveQuote.value = quote

    await vi.waitFor(() => expect(mocks.getAssetUsdValueForEstimate).toHaveBeenCalled())
    expect(repay.estimateNetAPY.value).toBeNull()
    expect(repay.projectedYieldDetails.value).toBeNull()
  })

  it('skips projected details when the selected quote fails balance validation', async () => {
    const repay = useWalletSwapRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => collateralVault),
      formTab: ref('wallet'),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      runSimulation: mocks.runSimulation,
      netAPY: ref(1),
      collateralSupplyApy: computed(() => 5),
      borrowApy: computed(() => 5),
      collateralSupplyRewardApy: computed(() => 0),
      borrowRewardApy: computed(() => 0),
      oraclePriceRatio: computed(() => 1),
    })
    repay.selectedAsset.value = walletAsset
    repay.amount.value = '100'
    const validQuote = {
      amountIn: '100',
      amountOut: '200',
      amountOutMin: '190',
      receiver: borrowVault.address,
      accountOut: USER,
    } as SwapQuote
    mocks.quoteStates[0]!.selectedQuote.value = validQuote
    mocks.quoteStates[0]!.effectiveQuote.value = validQuote
    await vi.waitFor(() => expect(repay.projectedYieldDetails.value).not.toBeNull())
    mocks.getCollateralApySnapshot.mockClear()

    repay.amount.value = '2000'
    repay.onAmountInput()
    const invalidQuote = { ...validQuote, amountIn: '2000' } as SwapQuote
    mocks.quoteStates[0]!.selectedQuote.value = invalidQuote
    mocks.quoteStates[0]!.effectiveQuote.value = invalidQuote

    await vi.waitFor(() => expect(repay.estimatesError.value).toBe('Not enough balance'))
    expect(mocks.getCollateralApySnapshot).not.toHaveBeenCalled()
    expect(repay.projectedYieldDetails.value).toBeNull()
  })

  it('invalidates an in-flight projection when the layered position disappears', async () => {
    let resolveProjection!: (value: ReturnType<typeof makeCollateralSnapshot>) => void
    mocks.getCollateralApySnapshot
      .mockResolvedValueOnce(makeCollateralSnapshot(false))
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveProjection = resolve
      }))
    const positionRef = shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position)
    const repay = useWalletSwapRepay({
      position: positionRef,
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => collateralVault),
      formTab: ref('wallet'),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      runSimulation: mocks.runSimulation,
      netAPY: ref(1),
      collateralSupplyApy: computed(() => 5),
      borrowApy: computed(() => 5),
      collateralSupplyRewardApy: computed(() => 0),
      borrowRewardApy: computed(() => 0),
      oraclePriceRatio: computed(() => 1),
    })
    repay.selectedAsset.value = walletAsset
    repay.amount.value = '100'
    const quote = {
      amountIn: '100',
      amountOut: '200',
      amountOutMin: '190',
      receiver: borrowVault.address,
      accountOut: USER,
    } as SwapQuote
    mocks.quoteStates[0]!.selectedQuote.value = quote
    mocks.quoteStates[0]!.effectiveQuote.value = quote
    await vi.waitFor(() => expect(mocks.getCollateralApySnapshot).toHaveBeenCalledTimes(2))

    positionRef.value = undefined
    resolveProjection(makeCollateralSnapshot(true))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(repay.projectedYieldDetails.value).toBeNull()
    expect(repay.isEstimatesLoading.value).toBe(false)
  })
})
