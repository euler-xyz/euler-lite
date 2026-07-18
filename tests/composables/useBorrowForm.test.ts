import { computed, nextTick, ref, shallowRef, watch, watchEffect, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, EVault, IHasVaultAddress, PortfolioSavingsPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useBorrowForm } from '~/composables/borrow/useBorrowForm'

const { USER, SUB_ACCOUNT_A, SUB_ACCOUNT_B, VAULT, vault, planAccount, mocks } = vi.hoisted(() => {
  const USER = '0x0000000000000000000000000000000000000001'
  const SUB_ACCOUNT_A = '0x0000000000000000000000000000000000000011'
  const SUB_ACCOUNT_B = '0x0000000000000000000000000000000000000022'
  const VAULT = '0x0000000000000000000000000000000000000002'
  const ASSET = '0x0000000000000000000000000000000000000003'
  const vault = {
    address: VAULT,
    availableLiquidity: 10_000n,
    totalCash: 10_000n,
    totalBorrowed: 0n,
    asset: {
      address: ASSET,
      symbol: 'USDC',
      decimals: 0,
    },
    shares: {
      address: VAULT,
      symbol: 'eUSDC',
      decimals: 0,
    },
    collaterals: [],
    convertToShares: vi.fn((assets: bigint) => assets * 2n),
  } as unknown as EVault

  return {
    USER,
    SUB_ACCOUNT_A,
    SUB_ACCOUNT_B,
    VAULT,
    vault,
    planAccount: { chainId: 1 } as Account<IHasVaultAddress>,
    mocks: {
      planBorrow: vi.fn(),
      executePlan: vi.fn(),
      prefetchPluginData: vi.fn(),
      preloadSubAccountSnapshot: vi.fn(),
      fetchSingleBalance: vi.fn(async () => 0n),
      runSimulation: vi.fn(),
      modalOpen: vi.fn(),
    },
  }
})

vi.mock('#components', () => ({
  OperationReviewModal: {},
  SwapTokenSelector: {},
}))

vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({
    open: mocks.modalOpen,
    close: vi.fn(),
  }),
}))

vi.mock('~/components/ui/composables/useToast', () => ({
  useToast: () => ({
    error: vi.fn(),
  }),
}))

vi.mock('~/composables/useFreshAccount', () => ({
  useFreshAccount: () => ({
    account: ref(null),
  }),
}))

vi.mock('~/composables/useStateOverrideOptions', () => ({
  useStateOverrideOptions: () => ({
    primeSlotHintsFor: vi.fn(),
    buildStateOverrideOptions: vi.fn(() => ({})),
  }),
}))

vi.mock('~/composables/useSwapPriceImpact', () => ({
  useSwapPriceImpact: () => ({
    priceImpact: ref(null),
  }),
}))

vi.mock('~/composables/useSwapQuotesParallel', () => ({
  useSwapQuotesParallel: () => ({
    sortedQuoteCards: ref([]),
    selectedProvider: ref(null),
    selectedQuote: ref(null),
    effectiveQuote: ref(null),
    isLoading: ref(false),
    quoteError: ref(null),
    statusLabel: ref(''),
    getQuoteDiffPct: vi.fn(() => null),
    reset: vi.fn(),
    requestQuotes: vi.fn(),
    selectProvider: vi.fn(),
  }),
}))

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValueOrZero: vi.fn(async () => 0),
  getAssetOraclePrice: vi.fn(() => ({ amountOutMid: 1n })),
  getCollateralOraclePrice: vi.fn(() => ({ amountOutMid: 1n })),
  getCollateralUsdPrice: vi.fn(async () => ({ amountOutMid: 1_000_000_000_000_000_000n })),
  conservativePriceRatio: vi.fn(() => 1),
  getTokenUsdPrice: vi.fn(async () => 1),
}))

vi.mock('~/utils/vault/apy', () => ({
  getProjectedRates: vi.fn(async () => null),
  getNetAPY: vi.fn(() => 0),
}))

vi.mock('~/utils/swapRouteItems', () => ({
  buildSwapRouteItems: vi.fn(() => []),
}))

vi.mock('~/utils/operationGuardRegistry', () => ({
  isOperationBlocked: ref(false),
}))

vi.mock('~/utils/vault-hooks', () => ({
  OP_BORROW: 'borrow',
  OP_DEPOSIT: 'deposit',
  OP_SKIM: 'skim',
  OP_TRANSFER: 'transfer',
  findBlockingDisabledOp: vi.fn(() => false),
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

const makeSavingsPosition = (
  subAccount: string,
  assets: bigint,
  shares = assets,
) => ({
  position: {},
  vault,
  subAccount,
  assets,
  shares,
}) as PortfolioSavingsPosition<VaultEntity>

const makeForm = (positions: Ref<PortfolioSavingsPosition<VaultEntity>[]>) => {
  return useBorrowForm({
    pair: ref({
      collateral: vault,
      borrow: vault,
      ltv: {
        borrowLTV: 500000000000000000n,
        liquidationLTV: 750000000000000000n,
      },
    } as never),
    borrowVault: computed(() => vault),
    collateralVault: computed(() => vault),
    formTab: ref('borrow'),
    savingPositions: computed(() => positions.value),
    balance: ref(7n),
    resolvePendingSubAccount: vi.fn(async () => USER),
    collateralSupplyApy: computed(() => 0),
    borrowApy: computed(() => 0),
    collateralSupplyRewardApy: computed(() => 0),
    borrowRewardApy: computed(() => 0),
    collateralSupplyApyWithRewards: computed(() => 0),
    isSecuritizeCollateral: computed(() => false),
    isGeoBlocked: computed(() => false),
    isBorrowRestricted: computed(() => false),
    collateralAddress: VAULT,
    borrowAddress: VAULT,
  })
}

describe('useBorrowForm savings collateral', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.preloadSubAccountSnapshot.mockResolvedValue(undefined)
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('nextTick', nextTick)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('useEulerTx', () => ({
      planBorrow: mocks.planBorrow,
      planSwapAndBorrow: vi.fn(),
      executePlan: mocks.executePlan,
      prefetchPluginData: mocks.prefetchPluginData,
      preloadSubAccountSnapshot: mocks.preloadSubAccountSnapshot,
    }))
    vi.stubGlobal('usePlanAccount', () => ({
      account: shallowRef(planAccount),
    }))
    vi.stubGlobal('useWagmi', () => ({
      address: ref(USER),
      isConnected: ref(true),
    }))
    vi.stubGlobal('useSpyMode', () => ({
      isSpyMode: ref(false),
    }))
    vi.stubGlobal('useEffectiveAddress', () => ({
      address: ref(USER),
      isConnected: ref(true),
      isSpyMode: ref(false),
      spyAddress: ref(undefined),
      effectiveAddress: ref(USER),
    }))
    vi.stubGlobal('useEulerAddresses', () => ({
      chainId: ref(1),
    }))
    vi.stubGlobal('useWallets', () => ({
      fetchSingleBalance: mocks.fetchSingleBalance,
    }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({
      runSimulation: mocks.runSimulation,
      simulationError: ref(null),
      clearSimulationError: vi.fn(),
    }))
    vi.stubGlobal('useSlippage', () => ({
      slippage: ref(0.5),
    }))
    vi.stubGlobal('usePriceInvert', () => ({
      autoInvert: vi.fn(),
      invertValue: vi.fn((value: number | null) => value),
      displaySymbol: 'USDC',
      toggle: vi.fn(),
    }))
    vi.stubGlobal('useTxFinalization', () => ({
      finalizeTxAndRedirect: vi.fn(),
    }))
    vi.stubGlobal('valueToNano', (value: string | number, decimals = 0) => {
      return BigInt(Math.round(Number(value || 0) * 10 ** Number(decimals)))
    })
    vi.stubGlobal('ltvToPercent', (value: bigint | number) => typeof value === 'number' ? value * 100 : Number(value) / 1e16)
    vi.stubGlobal('getIsSupplyCapReached', () => false)
    vi.stubGlobal('getIsBorrowCapReached', () => false)
    vi.stubGlobal('getVaultSupplyApy', () => 0)
    vi.stubGlobal('getVaultBorrowApy', () => 0)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('emits one savings collateral option per sub-account and selects by sub-account', () => {
    const positions = shallowRef<PortfolioSavingsPosition<VaultEntity>[]>([
      makeSavingsPosition(SUB_ACCOUNT_A, 100n, 90n),
      makeSavingsPosition(SUB_ACCOUNT_B, 250n, 240n),
    ])
    const form = makeForm(positions)

    const savingsOptions = form.collateralOptions.value.filter(option => option.type === 'saving')

    expect(savingsOptions).toHaveLength(2)
    expect(savingsOptions.map(option => option.subAccount)).toEqual([SUB_ACCOUNT_A, SUB_ACCOUNT_B])

    form.onChangeCollateral(2)

    expect(form.isSavingCollateral.value).toBe(true)
    expect(form.selectedSavingSubAccount.value).toBe(SUB_ACCOUNT_B)
    expect(form.savingCollateral.value?.subAccount).toBe(SUB_ACCOUNT_B)
    expect(form.savingAssets.value).toBe(250n)

    positions.value = [
      makeSavingsPosition(SUB_ACCOUNT_A, 100n, 90n),
      makeSavingsPosition(SUB_ACCOUNT_B, 50n, 45n),
    ]

    expect(form.savingAssets.value).toBe(50n)
  })

  it('fails closed when the selected savings sub-account disappears', () => {
    const positions = shallowRef<PortfolioSavingsPosition<VaultEntity>[]>([
      makeSavingsPosition(SUB_ACCOUNT_A, 100n, 90n),
      makeSavingsPosition(SUB_ACCOUNT_B, 250n, 240n),
    ])
    const form = makeForm(positions)

    form.onChangeCollateral(1)
    positions.value = [makeSavingsPosition(SUB_ACCOUNT_B, 250n, 240n)]

    expect(form.savingCollateral.value).toBeUndefined()
    expect(form.savingAssets.value).toBe(0n)
    expect(form.borrowActiveBalance.value).toBe(0n)
    expect(form.errorText.value).toBe('Savings position not found')
    expect(form.isSubmitDisabled.value).toBe(true)
  })

  it('updates risk estimates when the borrow input-derived LTV changes', async () => {
    const form = makeForm(shallowRef<PortfolioSavingsPosition<VaultEntity>[]>([]))

    form.collateralAmount.value = '100'
    form.borrowAmount.value = '10'
    await nextTick()
    form.ltv.value = 10
    await nextTick()

    expect(form.ltv.value).toBe(10)
    expect(form.health.value).toBeCloseTo(7.5)
    expect(form.liquidationPrice.value).toBeGreaterThan(0)
    const initialLiquidationPrice = form.liquidationPrice.value!

    form.borrowAmount.value = '40'
    await nextTick()
    form.ltv.value = 40
    await nextTick()

    expect(form.ltv.value).toBe(40)
    expect(form.health.value).toBeCloseTo(1.875)
    expect(form.liquidationPrice.value).toBeCloseTo(initialLiquidationPrice * 4, 24)
  })

  it('opens the review modal after a non-blocking borrow simulation', async () => {
    const positions = shallowRef<PortfolioSavingsPosition<VaultEntity>[]>([])
    const form = makeForm(positions)
    mocks.planBorrow.mockResolvedValue([{ type: 'requiredApproval' }, { type: 'evcBatch' }])
    mocks.runSimulation.mockResolvedValue(true)

    form.collateralAmount.value = '1'
    form.borrowAmount.value = '1'
    await form.submit()

    expect(mocks.runSimulation).toHaveBeenCalled()
    expect(mocks.modalOpen).toHaveBeenCalled()
  })
})
