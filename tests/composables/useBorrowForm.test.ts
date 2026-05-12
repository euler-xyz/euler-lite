import { computed, nextTick, ref, watch, watchEffect } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TxPlan } from '~/entities/txPlan'
import type { AnyBorrowVaultPair, Vault, VaultAsset } from '~/entities/vault'
import type { SwapApiQuote } from '~/entities/swap'
import { valueToNano } from '~/utils/crypto-utils'
import { useBorrowForm } from '~/composables/borrow/useBorrowForm'

const { USER, COLLATERAL_VAULT, BORROW_VAULT, mocks } = vi.hoisted(() => {
  const USER = '0x0000000000000000000000000000000000000001'
  const COLLATERAL_VAULT = '0x0000000000000000000000000000000000000002'
  const BORROW_VAULT = '0x0000000000000000000000000000000000000003'
  const COLLATERAL_ASSET = '0x0000000000000000000000000000000000000004'
  const BORROW_ASSET = '0x0000000000000000000000000000000000000005'
  const WALLET_ASSET = '0x0000000000000000000000000000000000000006'

  const collateralAsset = {
    address: COLLATERAL_ASSET,
    name: 'USDC',
    symbol: 'USDC',
    decimals: 6,
  }
  const borrowAsset = {
    address: BORROW_ASSET,
    name: 'USDT',
    symbol: 'USDT',
    decimals: 6,
  }
  const walletAsset = {
    address: WALLET_ASSET,
    name: 'DAI',
    symbol: 'DAI',
    decimals: 6,
  }

  const collateralVault = {
    address: COLLATERAL_VAULT,
    asset: collateralAsset,
    decimals: 6,
    supply: 1_000_000_000n,
    interestRateInfo: { cash: 0n, borrows: 0n, supplyAPY: 0n, borrowAPY: 0n },
    collateralLTVs: [],
  } as unknown as Vault

  const borrowVault = {
    address: BORROW_VAULT,
    asset: borrowAsset,
    decimals: 6,
    supply: 1_000_000_000n,
    interestRateInfo: { cash: 0n, borrows: 0n, supplyAPY: 0n, borrowAPY: 0n },
    collateralLTVs: [],
  } as unknown as Vault

  return {
    USER,
    COLLATERAL_VAULT,
    BORROW_VAULT,
    WALLET_ASSET,
    mocks: {
      collateralVault,
      borrowVault,
      walletAsset,
      modalOpen: vi.fn(),
      modalClose: vi.fn(),
      toastError: vi.fn(),
      buildBorrowPlan: vi.fn(),
      buildBorrowBySavingPlan: vi.fn(),
      buildSwapAndBorrowPlan: vi.fn(),
      executeTxPlan: vi.fn(),
      finalizeTxAndRedirect: vi.fn(),
      runSimulation: vi.fn(),
      resolvePendingSubAccount: vi.fn(),
      swapEffectiveQuote: null as SwapApiQuote | null,
    },
  }
})

vi.mock('@wagmi/vue', () => ({
  useAccount: () => ({
    address: ref(USER),
    isConnected: ref(true),
  }),
}))

vi.mock('#components', () => ({
  OperationReviewModal: {},
  SwapTokenSelector: {},
}))

vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({
    open: mocks.modalOpen,
    close: mocks.modalClose,
  }),
}))

vi.mock('~/components/ui/composables/useToast', () => ({
  useToast: () => ({
    error: mocks.toastError,
  }),
}))

vi.mock('~/utils/native-currency', () => ({
  isNativeCurrencyAddress: () => false,
  isNativeOfWrapped: () => false,
  resolveWrappedNativeAddress: () => undefined,
  resolveWrappedNativeAsset: () => undefined,
}))

vi.mock('~/services/pricing/priceProvider', () => ({
  getAssetUsdValueOrZero: vi.fn(async () => 0),
  getAssetOraclePrice: vi.fn(() => 1n),
  getCollateralOraclePrice: vi.fn(() => 1n),
  getCollateralUsdPrice: vi.fn(async () => null),
  conservativePriceRatio: vi.fn(() => 1),
}))

vi.mock('~/services/pricing/backendClient', () => ({
  fetchBackendPrice: vi.fn(async () => null),
}))

vi.mock('~/composables/useSwapPriceImpact', () => ({
  useSwapPriceImpact: () => ({ priceImpact: ref(null) }),
}))

vi.mock('~/utils/swapRouteItems', () => ({
  buildSwapRouteItems: vi.fn(() => []),
}))

vi.mock('~/composables/useVaultWarnings', () => ({
  getPlanHookDisabledWarning: vi.fn(() => null),
  getUtilisationWarning: vi.fn(() => null),
  getBorrowCapWarning: vi.fn(() => null),
  getSupplyCapWarning: vi.fn(() => null),
}))

vi.mock('~/composables/useGeoBlock', () => ({
  getVaultTags: vi.fn(() => ({ tags: [], disabled: false })),
  isVaultRestrictedByCountry: vi.fn(() => false),
  isAssetBlockedByCountry: vi.fn(() => false),
}))

vi.mock('~/composables/useSwapQuotesParallel', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    useSwapQuotesParallel: () => ({
      sortedQuoteCards: vue.ref([]),
      selectedProvider: vue.ref(null),
      selectedQuote: vue.ref(null),
      effectiveQuote: vue.ref(mocks.swapEffectiveQuote),
      isLoading: vue.ref(false),
      quoteError: vue.ref(null),
      statusLabel: vue.ref(''),
      getQuoteDiffPct: vi.fn(() => 0),
      reset: vi.fn(),
      requestQuotes: vi.fn(),
      selectProvider: vi.fn(),
    }),
  }
})

vi.mock('~/utils/operationGuardRegistry', () => ({
  isOperationBlocked: ref(false),
}))

vi.mock('~/utils/vault-hooks', () => ({
  findBlockingDisabledOp: vi.fn(() => null),
  OP_BORROW: 'borrow',
  OP_DEPOSIT: 'deposit',
  OP_SKIM: 'skim',
  OP_TRANSFER: 'transfer',
}))

vi.mock('~/entities/vault', async () => {
  const actual = await vi.importActual<object>('~/entities/vault')
  return {
    ...actual,
    convertAssetsToShares: vi.fn(async (amount: bigint) => amount),
    getNetAPY: vi.fn(() => 0),
    getProjectedRates: vi.fn(async () => null),
  }
})

const reviewPlan = (label: string): TxPlan => ({
  kind: 'borrow',
  steps: [{
    type: 'evc-batch',
    label,
    to: BORROW_VAULT as `0x${string}`,
    abi: [],
    functionName: 'batch',
    args: [],
    value: 0n,
  }],
})

const quote = {
  amountIn: '1000000',
  amountOut: '1000000',
  route: [],
  swap: {
    swapperAddress: '0x0000000000000000000000000000000000000007',
    multicallItems: [],
  },
  verify: {
    verifierAddress: '0x0000000000000000000000000000000000000008',
    verifierData: '0x',
    account: USER,
  },
} as unknown as SwapApiQuote

const pair = {
  borrowLTV: 5000n,
  liquidationLTV: 8000n,
} as AnyBorrowVaultPair

const createBorrowForm = () => {
  const borrow = useBorrowForm({
    pair: ref(pair),
    borrowVault: computed(() => mocks.borrowVault),
    collateralVault: computed(() => mocks.collateralVault),
    formTab: ref('borrow'),
    savingCollateral: computed(() => undefined),
    balance: ref(1_000_000_000n),
    savingBalance: ref(0n),
    savingAssets: ref(0n),
    resolvePendingSubAccount: mocks.resolvePendingSubAccount,
    collateralSupplyApy: computed(() => 0),
    borrowApy: computed(() => 0),
    collateralSupplyRewardApy: computed(() => 0),
    borrowRewardApy: computed(() => 0),
    collateralSupplyApyWithRewards: computed(() => 0),
    isSecuritizeCollateral: computed(() => false),
    isGeoBlocked: computed(() => false),
    isBorrowRestricted: computed(() => false),
    collateralAddress: COLLATERAL_VAULT,
    borrowAddress: BORROW_VAULT,
  })

  borrow.collateralAmount.value = '1'
  borrow.borrowAmount.value = '1'
  return borrow
}

describe('useBorrowForm review flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.swapEffectiveQuote = null
    mocks.resolvePendingSubAccount.mockResolvedValue(USER)
    mocks.runSimulation.mockResolvedValue(true)
    mocks.executeTxPlan.mockResolvedValue('0xhash')
    mocks.finalizeTxAndRedirect.mockResolvedValue(undefined)

    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('nextTick', nextTick)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('valueToNano', valueToNano)
    vi.stubGlobal('getIsSupplyCapReached', () => false)
    vi.stubGlobal('getIsBorrowCapReached', () => false)
    vi.stubGlobal('useEulerOperations', () => ({
      buildBorrowPlan: mocks.buildBorrowPlan,
      buildBorrowBySavingPlan: mocks.buildBorrowBySavingPlan,
      buildSwapAndBorrowPlan: mocks.buildSwapAndBorrowPlan,
      executeTxPlan: mocks.executeTxPlan,
    }))
    vi.stubGlobal('useEulerAddresses', () => ({
      chainId: ref(1),
    }))
    vi.stubGlobal('useWallets', () => ({
      fetchSingleBalance: vi.fn(async () => 0n),
    }))
    vi.stubGlobal('useTxFinalization', () => ({
      finalizeTxAndRedirect: mocks.finalizeTxAndRedirect,
    }))
    vi.stubGlobal('useTxPlanSimulation', () => ({
      runSimulation: mocks.runSimulation,
      simulationError: ref(''),
      clearSimulationError: vi.fn(),
    }))
    vi.stubGlobal('usePriceInvert', () => ({
      autoInvert: vi.fn(),
    }))
    vi.stubGlobal('useSlippage', () => ({
      slippage: ref(0.5),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not open review when standard borrow plan preparation fails', async () => {
    mocks.buildBorrowPlan.mockRejectedValueOnce(new Error('prepare failed'))
    const borrow = createBorrowForm()

    await borrow.submit()

    expect(mocks.modalOpen).not.toHaveBeenCalled()
    expect(mocks.runSimulation).not.toHaveBeenCalled()
    expect(mocks.executeTxPlan).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to build transaction')
  })

  it('requires a reviewed plan and simulates the final standard borrow plan before execution', async () => {
    const preparedPlan = reviewPlan('reviewed borrow')
    const executionPlan = reviewPlan('execution borrow')
    mocks.buildBorrowPlan
      .mockResolvedValueOnce(preparedPlan)
      .mockResolvedValueOnce(executionPlan)
    const borrow = createBorrowForm()

    await borrow.submit()
    const props = mocks.modalOpen.mock.calls[0][1].props
    borrow.collateralAmount.value = '5'
    borrow.borrowAmount.value = '5'
    await props.onConfirm()

    expect(props.plan).toStrictEqual(preparedPlan)
    expect(props.requirePlanForConfirm).toBe(true)
    expect(mocks.buildBorrowPlan).toHaveBeenNthCalledWith(
      2,
      COLLATERAL_VAULT,
      mocks.collateralVault.asset.address,
      1_000_000n,
      BORROW_VAULT,
      1_000_000n,
      undefined,
      { includePermit2Call: true, wrappedNativeInfo: undefined },
    )
    expect(mocks.runSimulation).toHaveBeenNthCalledWith(1, preparedPlan)
    expect(mocks.runSimulation).toHaveBeenNthCalledWith(2, executionPlan)
    expect(mocks.executeTxPlan).toHaveBeenCalledWith(executionPlan)
  })

  it('does not execute when confirmation is missing the reviewed plan', async () => {
    const borrow = createBorrowForm()

    await borrow.send()

    expect(mocks.executeTxPlan).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Transaction review expired')
  })

  it('does not execute when confirmation uses a stale reviewed plan', async () => {
    const stalePlan = reviewPlan('stale borrow')
    const currentPlan = reviewPlan('current borrow')
    const borrow = createBorrowForm()
    borrow.plan.value = currentPlan

    await borrow.send(stalePlan, async () => reviewPlan('execution borrow'))

    expect(mocks.executeTxPlan).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Transaction review expired')
  })

  it('does not open review when swap-borrow plan preparation fails', async () => {
    mocks.swapEffectiveQuote = quote
    mocks.buildSwapAndBorrowPlan.mockRejectedValueOnce(new Error('prepare failed'))
    const borrow = createBorrowForm()
    borrow.onSelectBorrowSwapAsset(mocks.walletAsset as unknown as VaultAsset)

    await borrow.submit()

    expect(mocks.modalOpen).not.toHaveBeenCalled()
    expect(mocks.runSimulation).not.toHaveBeenCalled()
    expect(mocks.executeTxPlan).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to build transaction')
  })
})
