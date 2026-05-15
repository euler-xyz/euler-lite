import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, watch, watchEffect } from 'vue'
import type { Address } from 'viem'
import type { Vault } from '~/entities/vault'
import type { AccountBorrowPosition } from '~/entities/account'
import type { SwapApiQuote } from '~/entities/swap'
import { SwapperMode } from '~/entities/swap'
import { useMultiplyCowSwap } from '~/composables/borrow/useMultiplyCowSwap'
import { useCollateralSwapRepay } from '~/composables/repay/useCollateralSwapRepay'

const { mocks, USER, SUBACCOUNT, SHORT_VAULT } = vi.hoisted(() => ({
  USER: '0x0000000000000000000000000000000000000001',
  SUBACCOUNT: '0x0000000000000000000000000000000000000002',
  SHORT_VAULT: '0x0000000000000000000000000000000000000012',
  mocks: {
    openCowSwapReviewModal: vi.fn(),
    toastError: vi.fn(),
    getNewSubAccount: vi.fn(),
    getClosePositionCollateralShares: vi.fn(),
    readContract: vi.fn(),
    getCode: vi.fn(),
    vaultAccountInfo: { assets: 0n, shares: 0n },
    repayCore: null as unknown,
  },
}))

vi.mock('@wagmi/vue', () => ({
  useAccount: () => ({
    isConnected: ref(true),
    address: ref(USER),
  }),
}))

vi.mock('#components', () => ({
  OperationReviewModal: {},
}))

vi.mock('~/entities/account', () => ({
  getNewSubAccount: mocks.getNewSubAccount,
}))

vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({
    open: vi.fn(),
    close: vi.fn(),
  }),
}))

vi.mock('~/components/ui/composables/useToast', () => ({
  useToast: () => ({
    error: mocks.toastError,
  }),
}))

vi.mock('~/composables/cowswap', () => ({
  useCowSwapOpenPositionExecution: () => ({
    reset: vi.fn(),
    status: ref('idle'),
    orderUid: ref(undefined),
  }),
  useCowSwapClosePositionExecution: () => ({
    reset: vi.fn(),
    status: ref('idle'),
    orderUid: ref(undefined),
  }),
  useCowSwapOrderStatus: () => ({
    orderStatus: ref(null),
  }),
  buildApprovalSignSteps: ({ startIndex }: { startIndex: number }) => ({
    steps: [],
    nextIndex: startIndex,
  }),
  openCowSwapReviewModal: mocks.openCowSwapReviewModal,
}))

vi.mock('~/composables/repay/closePositionShares', () => ({
  getClosePositionCollateralShares: mocks.getClosePositionCollateralShares,
}))

vi.mock('~/composables/repay/useRepaySwapCore', () => ({
  useRepaySwapCore: () => mocks.repayCore,
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
    currentLiquidationLtv: ref(null),
    nextLtv: ref(null),
    nextHealth: ref(null),
    currentLiquidationPrice: ref(null),
    nextLiquidationPrice: ref(null),
  }),
}))

vi.mock('~/composables/useSwapCollateralOptions', () => ({
  useSwapCollateralOptions: () => ({
    collateralOptions: ref([]),
    collateralVaults: ref([]),
  }),
}))

vi.mock('~/composables/useEulerLabels', () => ({
  useEulerProductOfVault: () => computed(() => ({ name: 'Euler Test' })),
}))

vi.mock('~/services/pricing/priceProvider', () => ({
  getAssetUsdValue: vi.fn(async () => null),
  getAssetOraclePrice: vi.fn(() => 1n),
  conservativePriceRatioNumber: vi.fn(() => 1),
}))

const addr = (suffix: string) => `0x${suffix.padStart(40, '0')}` as Address
const lensAddresses = {
  accountLens: addr('ee'),
  eulerEarnVaultLens: addr('ef'),
  irmLens: addr('f0'),
  oracleLens: addr('f1'),
  utilsLens: addr('f2'),
  vaultLens: addr('f3'),
}

const makeVault = (
  suffix: string,
  symbol: string,
  overrides: Partial<Vault> = {},
): Vault => ({
  address: addr(suffix),
  symbol: `${symbol}v`,
  decimals: 18n,
  totalAssets: 2_000n,
  totalShares: 1_000n,
  totalCash: 10_000n,
  supply: 0n,
  supplyCap: 0n,
  interestRateInfo: { supplyAPY: 0n, borrowAPY: 0n },
  collateralLTVs: [],
  asset: {
    address: addr(`${suffix}a`),
    chainId: 1,
    decimals: 0,
    logoURI: '',
    name: symbol,
    symbol,
  },
  ...overrides,
} as unknown as Vault)

const makeQuote = (overrides: Partial<SwapApiQuote> = {}): SwapApiQuote => ({
  amountIn: '1000',
  amountInMax: '1000',
  amountOut: '1000',
  amountOutMin: '995',
  accountIn: SUBACCOUNT as Address,
  accountOut: SUBACCOUNT as Address,
  vaultIn: addr('b1'),
  receiver: addr('b2'),
  tokenIn: { address: addr('a1'), chainId: 1, decimals: 18, logoURI: '', name: 'In', symbol: 'IN' },
  tokenOut: { address: addr('a2'), chainId: 1, decimals: 18, logoURI: '', name: 'Out', symbol: 'OUT' },
  route: [{ providerName: 'cow' }],
  providerData: {
    sellAmount: '1000',
    buyAmount: '500',
    feeAmount: '0',
    appData: '{"bound":true}',
    appDataDeadline: 12345,
  },
  ...overrides,
} as SwapApiQuote)

const makePosition = (
  borrowVault: Vault,
  collateralVault: Vault,
  supplied: bigint,
): AccountBorrowPosition => ({
  borrow: borrowVault as AccountBorrowPosition['borrow'],
  collateral: collateralVault as AccountBorrowPosition['collateral'],
  subAccount: SUBACCOUNT,
  borrowed: 1_000n,
  supplied,
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
})

const makeRepayCore = (quote: SwapApiQuote, direction = SwapperMode.TARGET_DEBT) => {
  const directionRef = ref(direction)
  return {
    amount: ref(direction === SwapperMode.EXACT_IN ? '1000' : '1000'),
    debtAmount: ref(direction === SwapperMode.TARGET_DEBT ? '500' : '500'),
    direction: directionRef,
    debtPercent: ref(0),
    quotes: {
      selectedProvider: ref('cow'),
      selectedQuote: ref(quote),
      effectiveQuoteFetchedAt: ref(777),
      quoteError: ref(null),
    },
    isSameAsset: computed(() => false),
    isRepayExceedsDebt: computed(() => false),
    spent: ref(null),
    debtRepaid: ref(null),
    resetCore: vi.fn(),
    onAmountInput: vi.fn(),
    onDebtInput: vi.fn(),
    onPercentInput: vi.fn(),
    onRefreshQuotes: vi.fn(),
    onSourceMax: vi.fn(),
    onProviderSelect: vi.fn(),
    onSourceVaultChange: vi.fn(),
  }
}

describe('CoW caller validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('valueToNano', (value: string) => BigInt(value || '0'))
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('usePriceInvert', () => ({ autoInvert: vi.fn() }))
    vi.stubGlobal('useEulerAddresses', () => ({
      chainId: ref(1),
      eulerLensAddresses: ref(lensAddresses),
      isReady: ref(true),
      loadEulerConfig: vi.fn(),
    }))
    vi.stubGlobal('useRpcClient', () => ({
      client: ref({
        readContract: mocks.readContract,
        getCode: mocks.getCode,
      }),
    }))
    vi.stubGlobal('useEulerOperations', () => ({
      buildSwapPlan: vi.fn(),
      buildSameAssetRepayPlan: vi.fn(),
      buildSameAssetFullRepayPlan: vi.fn(),
      buildSwapFullRepayPlan: vi.fn(),
      executeTxPlan: vi.fn(),
    }))
    vi.stubGlobal('useTxFinalization', () => ({ finalizeTxAndRedirect: vi.fn() }))
    vi.stubGlobal('useEulerAccount', () => ({ refreshAllPositions: vi.fn() }))
    vi.stubGlobal('useIntrinsicApy', () => ({
      withIntrinsicSupplyApy: vi.fn((value: number) => value),
      withIntrinsicBorrowApy: vi.fn((value: number) => value),
    }))
    vi.stubGlobal('useRewardsApy', () => ({
      getSupplyRewardApy: vi.fn(() => 0),
      getBorrowRewardApy: vi.fn(() => 0),
    }))

    mocks.getNewSubAccount.mockResolvedValue(SUBACCOUNT)
    mocks.getClosePositionCollateralShares.mockImplementation(async ({ assetsAmount }: { assetsAmount: bigint }) => assetsAmount)
    mocks.vaultAccountInfo = { assets: 0n, shares: 0n }
    mocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'getVaultAccountInfo') return mocks.vaultAccountInfo
      if (functionName === 'getInboxAddressAndDomainSeparator') return [addr('f1'), '0x']
      return 0n
    })
    mocks.getCode.mockResolvedValue('0x')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('blocks multiply CoW submit when raw buy shares do not match displayed underlying output', async () => {
    const supplyVault = makeVault('11', 'SUP', { totalAssets: 1_000n, totalShares: 1_000n })
    const longVault = makeVault('12', 'LONG', { totalAssets: 2_000n, totalShares: 1_000n })
    const shortVault = makeVault('13', 'SHORT', { address: SHORT_VAULT as Address, totalAssets: 1_000n, totalShares: 1_000n })
    const quote = makeQuote({ amountOut: '999' })

    const multiply = useMultiplyCowSwap({
      multiplySelectedProvider: computed(() => 'cow'),
      multiplyEffectiveProvider: computed(() => 'cow'),
      multiplyEffectiveQuote: computed(() => quote),
      multiplySelectedQuote: computed(() => quote),
      multiplyEffectiveQuoteFetchedAt: computed(() => 777),
      multiplySlippage: ref(0),
      multiplySupplyVault: computed(() => supplyVault),
      multiplyLongVault: computed(() => longVault),
      multiplyShortVault: computed(() => shortVault),
      multiplySupplyProduct: computed(() => ({ name: 'Supply' })),
      multiplyShortProduct: computed(() => ({ name: 'Borrow' })),
      multiplyInputAmount: ref('1'),
      multiplyShortAmount: computed(() => '1000'),
      multiplyLongAmount: computed(() => '1000'),
      multiplyDebtAmountNano: computed(() => 1000n),
      multiplyErrorText: computed(() => null),
      resolvePendingSubAccount: vi.fn(async () => SUBACCOUNT),
      refreshAllPositions: vi.fn(),
      eulerLensAddresses: ref(lensAddresses),
    })

    await multiply.submitCowSwapMultiply()

    expect(mocks.toastError).toHaveBeenCalledWith('Quote is stale. Refresh quote and try again.')
    expect(mocks.openCowSwapReviewModal).not.toHaveBeenCalled()
  })

  it('passes request-bound appData and expected sell amount into multiply CoW execution params', async () => {
    const supplyVault = makeVault('21', 'SUP', { totalAssets: 1_000n, totalShares: 1_000n })
    const longVault = makeVault('22', 'LONG', { totalAssets: 2_000n, totalShares: 1_000n })
    const shortVault = makeVault('23', 'SHORT', { address: SHORT_VAULT as Address, totalAssets: 1_000n, totalShares: 1_000n })
    const quote = makeQuote({ amountOut: '1000' })

    const multiply = useMultiplyCowSwap({
      multiplySelectedProvider: computed(() => 'cow'),
      multiplyEffectiveProvider: computed(() => 'cow'),
      multiplyEffectiveQuote: computed(() => quote),
      multiplySelectedQuote: computed(() => quote),
      multiplyEffectiveQuoteFetchedAt: computed(() => 777),
      multiplySlippage: ref(0),
      multiplySupplyVault: computed(() => supplyVault),
      multiplyLongVault: computed(() => longVault),
      multiplyShortVault: computed(() => shortVault),
      multiplySupplyProduct: computed(() => ({ name: 'Supply' })),
      multiplyShortProduct: computed(() => ({ name: 'Borrow' })),
      multiplyInputAmount: ref('1'),
      multiplyShortAmount: computed(() => '1000'),
      multiplyLongAmount: computed(() => '1000'),
      multiplyDebtAmountNano: computed(() => 1000n),
      multiplyErrorText: computed(() => null),
      resolvePendingSubAccount: vi.fn(async () => SUBACCOUNT),
      refreshAllPositions: vi.fn(),
      eulerLensAddresses: ref(lensAddresses),
    })

    await multiply.submitCowSwapMultiply()

    const executeParams = mocks.openCowSwapReviewModal.mock.calls[0]?.[1].executeParams
    expect(executeParams).toMatchObject({
      expectedSellAmount: 1000n,
      expectedAppData: '{"bound":true}',
      sellAmount: 1000n,
      buyAmount: 500n,
      validTo: 12345,
    })
    expect(executeParams.wrapper.borrowAmount).toBe(1000n)
    expect(executeParams.wrapper.account).toBe(SUBACCOUNT)
  })

  it('wires target-debt close params from the selected quote into the CoW review modal', async () => {
    const sourceVault = makeVault('31', 'COL', { totalAssets: 2_000n, totalShares: 1_000n })
    const borrowVault = makeVault('32', 'DEBT', { totalAssets: 1_000n, totalShares: 1_000n })
    const quote = makeQuote({
      amountIn: '1000',
      amountInMax: '1000',
      amountOut: '500',
      amountOutMin: '500',
      providerData: {
        sellAmount: '500',
        buyAmount: '500',
        feeAmount: '0',
        appData: '{"close":true}',
        appDataDeadline: 45678,
      },
    })
    mocks.repayCore = makeRepayCore(quote, SwapperMode.TARGET_DEBT)

    const repay = useCollateralSwapRepay({
      position: ref(makePosition(borrowVault, sourceVault, 500n)),
      borrowVault: computed(() => borrowVault as AccountBorrowPosition['borrow']),
      collateralVault: computed(() => sourceVault as AccountBorrowPosition['collateral']),
      formTab: ref('collateral'),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0),
      clearSimulationError: vi.fn(),
      runSimulation: vi.fn(),
      getCurrentDebt: () => 1_000n,
      isEligibleForLiquidation: computed(() => false),
    })
    repay.initVault(sourceVault)
    mocks.vaultAccountInfo = { assets: 500n, shares: 500n }
    await repay.updateSourceBalance()

    await repay.submit()

    const executeParams = mocks.openCowSwapReviewModal.mock.calls[0]?.[1].executeParams
    expect(executeParams).toMatchObject({
      expectedBuyAmount: 500n,
      expectedAppData: '{"close":true}',
      sellAmount: 500n,
      buyAmount: 500n,
      maxSellAmount: 500n,
      validTo: 45678,
      orderKind: 'buy',
    })
    expect(executeParams.wrapper.collateralAmount).toBe(500n)
    expect(executeParams.wrapper.account).toBe(SUBACCOUNT)
  })

  it('blocks exact-in close when signed buy amount diverges from displayed repay output', async () => {
    const sourceVault = makeVault('41', 'COL', { totalAssets: 1_000n, totalShares: 1_000n })
    const borrowVault = makeVault('42', 'DEBT', { totalAssets: 1_000n, totalShares: 1_000n })
    const quote = makeQuote({
      amountIn: '1000',
      amountInMax: '1000',
      amountOut: '501',
      amountOutMin: '500',
      providerData: {
        sellAmount: '1000',
        buyAmount: '500',
        feeAmount: '0',
        appData: '{"close":true}',
        appDataDeadline: 45678,
      },
    })
    mocks.repayCore = makeRepayCore(quote, SwapperMode.EXACT_IN)

    const repay = useCollateralSwapRepay({
      position: ref(makePosition(borrowVault, sourceVault, 1_000n)),
      borrowVault: computed(() => borrowVault as AccountBorrowPosition['borrow']),
      collateralVault: computed(() => sourceVault as AccountBorrowPosition['collateral']),
      formTab: ref('collateral'),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0),
      clearSimulationError: vi.fn(),
      runSimulation: vi.fn(),
      getCurrentDebt: () => 1_000n,
      isEligibleForLiquidation: computed(() => false),
    })
    repay.initVault(sourceVault)
    mocks.vaultAccountInfo = { assets: 1_000n, shares: 1_000n }
    await repay.updateSourceBalance()

    await repay.submit()

    expect(mocks.toastError).toHaveBeenCalledWith('Quote is stale. Refresh quote and try again.')
    expect(mocks.openCowSwapReviewModal).not.toHaveBeenCalled()
  })
})
