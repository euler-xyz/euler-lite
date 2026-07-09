import { computed, ref, shallowRef, watch, watchEffect } from 'vue'
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
      planSwapAndRepay: vi.fn(),
      runSimulation: vi.fn(),
    },
  }
})

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
  getProjectedRates: vi.fn(async () => null),
  getNetAPY: vi.fn(() => 0),
}))

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValue: vi.fn(async () => null),
  getAssetUsdValueOrZero: vi.fn(async () => 0),
  getTokenUsdValue: vi.fn(async () => null),
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

describe('useWalletSwapRepay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.swapQuoteOptions.length = 0
    mocks.planSwapAndRepay.mockResolvedValue({ type: 'wallet-swap-repay-plan' } as unknown as TransactionPlan)
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
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
      getCollateralApySnapshot: vi.fn(async () => ({ supplyUsd: 0, weightedSupplyApy: null })),
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
})
