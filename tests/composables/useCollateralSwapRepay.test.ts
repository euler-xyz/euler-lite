import { computed, effectScope, nextTick, ref, shallowRef, watch, watchEffect, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SwapperMode, type Account, type EVault, type IHasVaultAddress, type PortfolioBorrowPosition, type SwapQuote, type TransactionPlan, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import { useCollateralSwapRepay } from '~/composables/repay/useCollateralSwapRepay'

const { USER, SOURCE_ACCOUNT, SECOND_SOURCE_ACCOUNT, SOURCE_VAULT, sourceVault, borrowVault, position, sourcePosition, planAccount, mocks } = vi.hoisted(() => {
  const USER = '0x0000000000000000000000000000000000000001' as Address
  const SOURCE_ACCOUNT = '0x0000000000000000000000000000000000000006' as Address
  const SECOND_SOURCE_ACCOUNT = '0x0000000000000000000000000000000000000007' as Address
  const SOURCE_VAULT = '0x0000000000000000000000000000000000000002' as Address
  const SOURCE_ASSET = '0x0000000000000000000000000000000000000003' as Address
  const BORROW_VAULT = '0x0000000000000000000000000000000000000004' as Address
  const BORROW_ASSET = '0x0000000000000000000000000000000000000005' as Address

  const sourceVault = {
    address: SOURCE_VAULT,
    availableLiquidity: 5_000n,
    asset: {
      address: SOURCE_ASSET,
      symbol: 'WETH',
      decimals: 0,
    },
    shares: {
      address: SOURCE_VAULT,
      symbol: 'eWETH',
      decimals: 0,
    },
    collaterals: [],
  } as unknown as EVault

  const borrowVault = {
    address: BORROW_VAULT,
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

  const position = {
    subAccount: USER,
    borrowed: 2_000n,
    supplied: 1_000n,
    collateralVault: sourceVault,
    collateralVaults: [SOURCE_VAULT],
    collaterals: [{
      vaultAddress: SOURCE_VAULT,
      assets: 1_000n,
      shares: 1_000n,
    }],
  } as unknown as PortfolioBorrowPosition<VaultEntity>

  const sourcePosition = {
    subAccount: SOURCE_ACCOUNT,
    borrowed: 1_000n,
    supplied: 2_500n,
    collateralVault: borrowVault,
    collateralVaults: [BORROW_VAULT],
    collaterals: [{
      vaultAddress: BORROW_VAULT,
      assets: 2_500n,
      shares: 2_500n,
    }],
  } as unknown as PortfolioBorrowPosition<VaultEntity>

  return {
    USER,
    SOURCE_ACCOUNT,
    SECOND_SOURCE_ACCOUNT,
    SOURCE_VAULT,
    sourceVault,
    borrowVault,
    position,
    sourcePosition,
    planAccount: { chainId: 1 } as Account<IHasVaultAddress>,
    mocks: {
      getCollateralApySnapshot: vi.fn(),
      createIntent: vi.fn(),
      openReview: vi.fn(),
      planRepayFromSource: vi.fn(),
      crossPositionItems: [] as Array<Record<string, unknown>>,
      quoteInstances: [] as Array<{
        amountField: 'amountIn' | 'amountOut'
        selectedQuote: { value: SwapQuote | null }
        effectiveQuote: { value: SwapQuote | null }
      }>,
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

vi.mock('~/composables/useStateOverrideOptions', () => ({
  useStateOverrideOptions: () => ({
    primeSlotHintsFor: vi.fn(),
    buildStateOverrideOptions: vi.fn(() => ({})),
  }),
}))

vi.mock('~/composables/useSwapCollateralOptions', () => ({
  useSwapCollateralOptions: () => ({
    collateralOptions: ref([]),
    collateralVaults: ref([sourceVault]),
  }),
}))

vi.mock('~/composables/useCrossPositionRepayCollateralOptions', () => ({
  useCrossPositionRepayCollateralOptions: () => ({
    items: ref(mocks.crossPositionItems),
  }),
}))

vi.mock('~/composables/useEulerLabels', () => ({
  useEulerProductOfVault: () => computed(() => 'Euler Earn'),
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
    projectedYieldDetails: ref(null),
    currentHealth: ref(null),
    currentLtv: ref(null),
    currentLiquidationLtv: ref(null),
    nextLtv: ref(null),
    nextHealth: ref(null),
    currentLiquidationPrice: ref(null),
    nextLiquidationPrice: ref(null),
  }),
}))

vi.mock('~/composables/cowswap', () => ({
  useCowSwapClosePositionExecution: () => ({
    orderUid: ref(null),
    reset: vi.fn(),
  }),
  useCowSwapOrderStatus: () => ({
    orderStatus: ref(null),
  }),
  openCowSwapReviewModal: vi.fn(),
}))

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValue: vi.fn(async () => null),
  getAssetUsdValueForEstimate: vi.fn(async () => null),
  getAssetOraclePrice: vi.fn(() => 0n),
  conservativePriceRatioNumber: vi.fn(() => 1),
}))

vi.mock('~/composables/useSwapQuotesParallel', () => ({
  useSwapQuotesParallel: (options: { amountField: 'amountIn' | 'amountOut' }) => {
    const selectedQuote = ref<SwapQuote | null>(null)
    const effectiveQuote = ref<SwapQuote | null>(null)
    mocks.quoteInstances.push({
      amountField: options.amountField,
      selectedQuote,
      effectiveQuote,
    })
    return {
      sortedQuoteCards: ref([]),
      selectedQuoteCard: ref(null),
      selectedProvider: ref(null),
      selectedQuote,
      effectiveQuote,
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

describe('useCollateralSwapRepay', () => {
  let scope: EffectScope

  beforeEach(() => {
    vi.stubGlobal('useOperationIntentFactory', () => ({ create: mocks.createIntent }))
    vi.stubGlobal('useExecutionReview', () => ({ open: mocks.openReview }))
    vi.clearAllMocks()
    mocks.quoteInstances.length = 0
    mocks.crossPositionItems.length = 0
    mocks.createIntent.mockImplementation(input => input)
    mocks.openReview.mockResolvedValue({})
    mocks.planRepayFromSource.mockResolvedValue([])
    mocks.getCollateralApySnapshot.mockResolvedValue({
      supplyUsd: 1_000,
      weightedSupplyApy: 1,
      collateralAddresses: [SOURCE_VAULT],
      isComplete: true,
    })
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('useEffectiveAddress', () => ({
      address: ref(USER),
      isConnected: ref(true),
      isSpyMode: ref(false),
      effectiveAddress: ref(USER),
    }))
    vi.stubGlobal('useEulerTx', () => ({
      planRepayFromSource: mocks.planRepayFromSource,
      executePlan: vi.fn(),
      prefetchPluginData: vi.fn(),
    }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('useTxFinalization', () => ({ finalizeTxAndRedirect: vi.fn() }))
    vi.stubGlobal('useEulerAccount', () => ({
      borrowPositions: ref([position, sourcePosition]),
      depositPositions: ref([]),
      refreshAllPositions: vi.fn(),
    }))
    vi.stubGlobal('usePlanAccount', () => ({ account: shallowRef(planAccount) }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref(null) }))
    vi.stubGlobal('useTxBatch', () => ({
      entryCount: ref(0),
      getMergedPlan: vi.fn(() => null),
    }))
    vi.stubGlobal('useCowSwapEligibility', () => ({ cowSwapForcedOff: ref(false) }))
    vi.stubGlobal('useUserSettings', () => ({
      settings: ref({ enableIntrinsicApy: false, enableRewardsApy: false, enableAdvancedMode: true }),
    }))
    vi.stubGlobal('useRewardsApy', () => ({
      getSupplyRewardApy: vi.fn(() => 0),
      getBorrowRewardApyForCollaterals: vi.fn(() => 0),
    }))
    vi.stubGlobal('usePositionCollateralApy', () => ({
      getCollateralApySnapshot: mocks.getCollateralApySnapshot,
    }))
    vi.stubGlobal('usePriceInvert', () => ({ autoInvert: vi.fn() }))
    vi.stubGlobal('getVaultSupplyApy', vi.fn(() => 0))
    vi.stubGlobal('getVaultBorrowApy', vi.fn(() => 0))
    vi.stubGlobal('ltvToPercent', vi.fn(() => 0))
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('projects the TARGET_DEBT maximum input as source collateral depletion', async () => {
    const repay = scope.run(() => useCollateralSwapRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => sourceVault),
      formTab: ref('collateral'),
      plan: ref<TransactionPlan | null>(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      runSimulation: vi.fn(async () => true),
      getCurrentDebt: () => position.borrowed,
      isEligibleForLiquidation: computed(() => false),
    }))!

    repay.initVault(sourceVault)
    await vi.waitFor(() => expect(mocks.getCollateralApySnapshot).toHaveBeenCalled())
    repay.direction.value = SwapperMode.TARGET_DEBT
    await nextTick()
    mocks.getCollateralApySnapshot.mockClear()

    const targetDebt = mocks.quoteInstances.find(instance => instance.amountField === 'amountIn')!
    const quote = {
      amountIn: '100',
      amountInMax: '110',
      amountOut: '200',
    } as SwapQuote
    targetDebt.selectedQuote.value = quote
    targetDebt.effectiveQuote.value = quote

    await vi.waitFor(() => expect(mocks.getCollateralApySnapshot).toHaveBeenCalledWith(
      position,
      borrowVault,
      {
        deltas: [{
          vaultAddress: SOURCE_VAULT,
          assetsDelta: -110n,
          cashDelta: -110n,
          projectRates: true,
        }],
        liabilityRateDelta: {
          cashDelta: 200n,
          borrowsDelta: -200n,
        },
      },
    ))
  })

  it('builds and simulates an exact-vault cross-position share repayment without liquidity or early cleanup', async () => {
    const selectionId = `${SOURCE_ACCOUNT.toLowerCase()}:${borrowVault.address.toLowerCase()}`
    mocks.crossPositionItems.push({
      id: selectionId,
      vault: borrowVault,
      sourceAccount: SOURCE_ACCOUNT,
      assets: 2_500n,
      shares: 2_500n,
      option: {
        selectionId,
        type: 'vault',
        amount: 2_500,
        price: 2_500,
        vaultAddress: borrowVault.address,
        subAccount: SOURCE_ACCOUNT,
      },
    })

    const runSimulation = vi.fn(async () => false)
    const repay = scope.run(() => useCollateralSwapRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => sourceVault),
      formTab: ref('collateral'),
      plan: ref<TransactionPlan | null>(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      runSimulation,
      getCurrentDebt: () => position.borrowed,
      isEligibleForLiquidation: computed(() => false),
    }))!

    repay.initVault(sourceVault)
    repay.onSourceVaultChange(0)
    await nextTick()

    expect(repay.selectedSourceAccount.value).toBe(SOURCE_ACCOUNT)
    expect(repay.repayCollateralOptions.value[0]?.subAccount).toBe(SOURCE_ACCOUNT)
    expect(repay.sourceVault.value?.address).toBe(borrowVault.address)
    expect(repay.sourceAssets.value).toBe(2_500n)
    expect(repay.sourceBalance.value).toBe(2_500n)
    expect(repay.isSameVaultRepay.value).toBe(true)
    expect(repay.isCrossPositionSource.value).toBe(true)

    repay.debtAmount.value = '2000'
    expect(repay.isSubmitDisabled.value).toBe(false)
    expect(repay.disabledReason.value).toBeUndefined()

    await repay.submit()
    expect(runSimulation).toHaveBeenCalledWith([], {})

    const built = await repay.buildRepayPlan()

    expect(built).toEqual([])
    expect(mocks.planRepayFromSource).toHaveBeenCalledWith(expect.objectContaining({
      liabilityVault: borrowVault.address,
      liabilityAmount: (2n ** 256n) - 1n,
      receiver: USER,
      fromVault: borrowVault.address,
      fromAccount: SOURCE_ACCOUNT,
      cleanupOnMax: false,
    }))

    repay.createRepayIntent()
    expect(mocks.createIntent).toHaveBeenCalledWith(expect.objectContaining({
      planner: 'repay-from-deposit',
      args: expect.objectContaining({
        receiver: USER,
        fromVault: borrowVault.address,
        fromAccount: SOURCE_ACCOUNT,
        cleanupOnMax: false,
      }),
      subAccounts: [USER, SOURCE_ACCOUNT],
    }))
  })

  it('keeps intent, preflight, and review on one source snapshot when selection changes mid-preparation', async () => {
    const selectionId = `${SOURCE_ACCOUNT.toLowerCase()}:${borrowVault.address.toLowerCase()}`
    const secondSelectionId = `${SECOND_SOURCE_ACCOUNT.toLowerCase()}:${borrowVault.address.toLowerCase()}`
    for (const [id, sourceAccount] of [
      [selectionId, SOURCE_ACCOUNT],
      [secondSelectionId, SECOND_SOURCE_ACCOUNT],
    ] as const) {
      mocks.crossPositionItems.push({
        id,
        vault: borrowVault,
        sourceAccount,
        assets: 2_500n,
        shares: 2_500n,
        option: {
          selectionId: id,
          type: 'vault',
          amount: 2_500,
          price: 2_500,
          vaultAddress: borrowVault.address,
          subAccount: sourceAccount,
        },
      })
    }

    let resolveSimulation: ((result: boolean) => void) | undefined
    const runSimulation = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveSimulation = resolve
    }))
    const repay = scope.run(() => useCollateralSwapRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => sourceVault),
      formTab: ref('collateral'),
      plan: ref<TransactionPlan | null>(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      runSimulation,
      getCurrentDebt: () => position.borrowed,
      isEligibleForLiquidation: computed(() => false),
    }))!

    repay.initVault(sourceVault)
    repay.onSourceVaultChange(0)
    repay.amount.value = '2000'
    await nextTick()
    expect(repay.amount.value).toBe('2000')
    const submitting = repay.submit()
    await vi.waitFor(() => expect(runSimulation).toHaveBeenCalled())
    repay.onSourceVaultChange(1)
    repay.amount.value = '1000'
    await nextTick()
    resolveSimulation?.(true)
    await submitting

    expect(mocks.planRepayFromSource).toHaveBeenCalledWith(expect.objectContaining({
      receiver: USER,
      fromVault: borrowVault.address,
      fromAccount: SOURCE_ACCOUNT,
    }))
    expect(mocks.openReview).toHaveBeenCalledWith([
      expect.objectContaining({
        args: expect.objectContaining({
          receiver: USER,
          fromVault: borrowVault.address,
          fromAccount: SOURCE_ACCOUNT,
        }),
      }),
    ], expect.objectContaining({
      review: expect.objectContaining({
        amount: '2000',
        subAccount: USER,
        sourceSubAccount: SOURCE_ACCOUNT,
      }),
    }))
    expect(repay.selectedSourceAccount.value).toBe(SECOND_SOURCE_ACCOUNT)
  })
})
