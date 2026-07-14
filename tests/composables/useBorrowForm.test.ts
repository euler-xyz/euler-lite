import { computed, nextTick, ref, shallowRef, watch, watchEffect, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, EVault, IHasVaultAddress, PortfolioSavingsPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useBorrowForm } from '~/composables/borrow/useBorrowForm'
import type { RewardCampaign } from '~/entities/reward-campaign'

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
      getProjectedRatesBatch: vi.fn(async (requests: unknown[]) => requests.map(() => null)),
      getAssetUsdValueForEstimate: vi.fn(async () => 0 as number | undefined),
      getSupplyRewardCampaigns: vi.fn(() => [] as RewardCampaign[]),
      getBorrowRewardCampaignsForCollaterals: vi.fn(() => [] as RewardCampaign[]),
      getEligibleLoopingRewardCampaignsForCollaterals: vi.fn(() => [] as RewardCampaign[]),
      supplyRewardApy: 0,
      borrowRewardApy: 0,
      borrowEffectiveQuote: undefined as unknown as Ref<unknown>,
    },
  }
})
const rewardsVersion = ref(0)

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
  useSwapQuotesParallel: () => {
    mocks.borrowEffectiveQuote = ref(null)
    return {
      sortedQuoteCards: ref([]),
      selectedProvider: ref(null),
      selectedQuote: ref(null),
      effectiveQuote: mocks.borrowEffectiveQuote,
      isLoading: ref(false),
      quoteError: ref(null),
      statusLabel: ref(''),
      getQuoteDiffPct: vi.fn(() => null),
      reset: vi.fn(),
      requestQuotes: vi.fn(),
      selectProvider: vi.fn(),
    }
  },
}))

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValueForEstimate: mocks.getAssetUsdValueForEstimate,
  getAssetUsdValueOrZero: vi.fn(async () => 0),
  getAssetOraclePrice: vi.fn(() => ({ amountOutMid: 1n })),
  getCollateralOraclePrice: vi.fn(() => ({ amountOutMid: 1n })),
  getCollateralUsdPrice: vi.fn(async () => ({ amountOutMid: 1_000_000_000_000_000_000n })),
  conservativePriceRatio: vi.fn(() => 1),
  getTokenUsdPrice: vi.fn(async () => 1),
}))

vi.mock('~/utils/vault/apy', () => ({
  areProjectedRatesComplete: (projectedRates: unknown[], expectedCount: number) =>
    projectedRates.length === expectedCount && projectedRates.every(projected => projected !== null),
  getProjectedRates: vi.fn(async () => null),
  getProjectedRatesBatch: mocks.getProjectedRatesBatch,
  getPositionMultiplier: vi.fn(() => 1),
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

interface TestPair {
  collateral: EVault
  borrow: EVault
  ltv: {
    borrowLTV: bigint
    liquidationLTV: bigint
  }
}

const makePair = (pairVault = vault): TestPair => ({
  collateral: pairVault,
  borrow: pairVault,
  ltv: {
    borrowLTV: 500000000000000000n,
    liquidationLTV: 750000000000000000n,
  },
})

const makeForm = (
  positions: Ref<PortfolioSavingsPosition<VaultEntity>[]>,
  pair = shallowRef<TestPair>(makePair()),
) => {
  return useBorrowForm({
    pair: pair as never,
    borrowVault: computed(() => pair.value.borrow),
    collateralVault: computed(() => pair.value.collateral),
    formTab: ref('borrow'),
    savingPositions: computed(() => positions.value),
    balance: ref(7n),
    resolvePendingSubAccount: vi.fn(async () => USER),
    collateralSupplyApy: computed(() => 0),
    borrowApy: computed(() => 0),
    collateralSupplyRewardApy: computed(() => mocks.supplyRewardApy),
    borrowRewardApy: computed(() => mocks.borrowRewardApy),
    collateralSupplyApyWithRewards: computed(() => mocks.supplyRewardApy),
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
    mocks.getProjectedRatesBatch.mockImplementation(async (requests: unknown[]) => requests.map(() => null))
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(0)
    mocks.getSupplyRewardCampaigns.mockReturnValue([])
    mocks.getBorrowRewardCampaignsForCollaterals.mockReturnValue([])
    mocks.getEligibleLoopingRewardCampaignsForCollaterals.mockReturnValue([])
    mocks.supplyRewardApy = 0
    mocks.borrowRewardApy = 0
    rewardsVersion.value = 0
    mocks.preloadSubAccountSnapshot.mockResolvedValue(undefined)
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
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
      getBalance: vi.fn(() => 0n),
      fetchSingleBalance: mocks.fetchSingleBalance,
    }))
    vi.stubGlobal('useRewardsApy', () => ({
      version: rewardsVersion,
      getSupplyRewardApy: vi.fn(() => mocks.supplyRewardApy),
      getBorrowRewardApyForCollaterals: vi.fn(() => mocks.borrowRewardApy),
      getEligibleLoopingRewardApyForCollaterals: vi.fn(() => 0),
      getSupplyRewardCampaigns: mocks.getSupplyRewardCampaigns,
      getBorrowRewardCampaignsForCollaterals: mocks.getBorrowRewardCampaignsForCollaterals,
      getEligibleLoopingRewardCampaignsForCollaterals: mocks.getEligibleLoopingRewardCampaignsForCollaterals,
    }))
    vi.stubGlobal('useUserSettings', () => ({
      settings: ref({ enableIntrinsicApy: false }),
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
    vi.stubGlobal('getIsSupplyCapReached', () => false)
    vi.stubGlobal('getIsBorrowCapReached', () => false)
    vi.stubGlobal('getVaultSupplyApy', () => 0)
    vi.stubGlobal('getVaultBorrowApy', () => 0)
    vi.stubGlobal('ltvToPercent', () => 50)
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

  it('does not project a savings share transfer as new vault cash', async () => {
    const positions = shallowRef<PortfolioSavingsPosition<VaultEntity>[]>([
      makeSavingsPosition(SUB_ACCOUNT_A, 100n, 90n),
    ])
    const form = makeForm(positions)
    form.onChangeCollateral(1)
    form.collateralAmount.value = '10'
    form.borrowAmount.value = '2'
    form.updateEstimates()

    await vi.waitFor(() => expect(mocks.getProjectedRatesBatch).toHaveBeenCalled())
    const requests = mocks.getProjectedRatesBatch.mock.calls.at(-1)?.[0] as Array<{ cashDelta: bigint }>
    expect(requests[0]?.cashDelta).toBe(0n)
  })

  it('reruns and invalidates projected rates when the collateral source changes', async () => {
    const positions = shallowRef<PortfolioSavingsPosition<VaultEntity>[]>([
      makeSavingsPosition(SUB_ACCOUNT_A, 100n, 90n),
    ])
    const form = makeForm(positions)
    form.collateralAmount.value = '10'
    form.borrowAmount.value = '2'

    await vi.waitFor(() => expect(mocks.getProjectedRatesBatch).toHaveBeenCalled())
    await vi.waitFor(() => expect(form.isEstimatesLoading.value).toBe(false))
    mocks.getProjectedRatesBatch.mockClear()

    const rateUnit = 10n ** 25n
    const projection = (supplyApy: bigint, borrowApy: bigint) => [
      { supplyAPY: supplyApy * rateUnit, borrowAPY: 0n },
      { supplyAPY: 0n, borrowAPY: borrowApy * rateUnit },
    ]
    const staleWalletProjection = projection(99n, 99n)
    const savingsProjection = projection(2n, 4n)
    const restoredWalletProjection = projection(3n, 5n)
    let resolveWalletProjection!: (value: typeof staleWalletProjection) => void
    const walletProjection = new Promise<typeof staleWalletProjection>((resolve) => {
      resolveWalletProjection = resolve
    })
    mocks.getProjectedRatesBatch
      .mockImplementationOnce(() => walletProjection as never)
      .mockResolvedValueOnce(savingsProjection as never)
      .mockResolvedValueOnce(restoredWalletProjection as never)

    form.updateEstimates()
    await vi.waitFor(() => expect(mocks.getProjectedRatesBatch).toHaveBeenCalledTimes(1))
    const walletRequests = mocks.getProjectedRatesBatch.mock.calls[0]?.[0] as Array<{ cashDelta: bigint }>
    expect(walletRequests[0]?.cashDelta).toBe(10n)

    form.onChangeCollateral(1)

    expect(form.collateralAmount.value).toBe('10')
    expect(form.borrowAmount.value).toBe('2')
    await vi.waitFor(() => expect(mocks.getProjectedRatesBatch).toHaveBeenCalledTimes(2))
    const savingsRequests = mocks.getProjectedRatesBatch.mock.calls[1]?.[0] as Array<{ cashDelta: bigint }>
    expect(savingsRequests[0]?.cashDelta).toBe(0n)
    await vi.waitFor(() => expect(
      form.projectedYieldDetails.value?.rateLines.find(line => line.id.startsWith('supply:'))?.after,
    ).toBe(2))

    resolveWalletProjection(staleWalletProjection)
    await Promise.resolve()
    await nextTick()
    expect(form.projectedYieldDetails.value?.rateLines.find(line => line.id.startsWith('supply:'))?.after).toBe(2)

    form.onChangeCollateral(false)

    await vi.waitFor(() => expect(mocks.getProjectedRatesBatch).toHaveBeenCalledTimes(3))
    const restoredWalletRequests = mocks.getProjectedRatesBatch.mock.calls[2]?.[0] as Array<{ cashDelta: bigint }>
    expect(restoredWalletRequests[0]?.cashDelta).toBe(10n)
    await vi.waitFor(() => expect(
      form.projectedYieldDetails.value?.rateLines.find(line => line.id.startsWith('supply:'))?.after,
    ).toBe(3))
  })

  it('does not run a queued projection after both inputs are cleared', async () => {
    let runQueued: (() => Promise<void>) | undefined
    vi.stubGlobal('useDebounceFn', (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      if (typeof args[0] === 'number') {
        runQueued = async () => {
          await fn(...args)
        }
        return
      }
      return fn(...args)
    })
    const form = makeForm(shallowRef([]))
    form.collateralAmount.value = '10'
    form.borrowAmount.value = '2'
    await nextTick()
    expect(runQueued).toBeDefined()

    form.collateralAmount.value = ''
    form.borrowAmount.value = ''
    await nextTick()
    mocks.getProjectedRatesBatch.mockClear()
    await runQueued?.()

    expect(mocks.getProjectedRatesBatch).not.toHaveBeenCalled()
    expect(form.projectedYieldDetails.value).toBeNull()
  })

  it('invalidates and reruns projections when the loaded vault pair refreshes', async () => {
    const pair = shallowRef<TestPair>(makePair())
    const form = makeForm(shallowRef([]), pair)
    form.collateralAmount.value = '10'
    form.borrowAmount.value = '2'
    await vi.waitFor(() => expect(form.isEstimatesLoading.value).toBe(false))
    mocks.getProjectedRatesBatch.mockClear()

    const rateUnit = 10n ** 25n
    const staleRates = [
      { supplyAPY: 99n * rateUnit, borrowAPY: 0n },
      { supplyAPY: 0n, borrowAPY: 99n * rateUnit },
    ]
    const refreshedRates = [
      { supplyAPY: 2n * rateUnit, borrowAPY: 0n },
      { supplyAPY: 0n, borrowAPY: 4n * rateUnit },
    ]
    let resolveStaleRates!: (value: typeof staleRates) => void
    mocks.getProjectedRatesBatch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStaleRates = resolve }) as never)
      .mockResolvedValueOnce(refreshedRates as never)

    form.updateEstimates()
    await vi.waitFor(() => expect(mocks.getProjectedRatesBatch).toHaveBeenCalledTimes(1))
    const refreshedVault = { ...vault, totalCash: 9_000n } as EVault
    pair.value = makePair(refreshedVault)

    await vi.waitFor(() => expect(mocks.getProjectedRatesBatch).toHaveBeenCalledTimes(2))
    expect(mocks.getProjectedRatesBatch.mock.calls[1]?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ currentCash: 9_000n }),
    ]))
    await vi.waitFor(() => expect(
      form.projectedYieldDetails.value?.rateLines.find(line => line.id.startsWith('supply:'))?.after,
    ).toBe(2))

    resolveStaleRates(staleRates)
    await Promise.resolve()
    await nextTick()
    expect(form.projectedYieldDetails.value?.rateLines.find(line => line.id.startsWith('supply:'))?.after).toBe(2)
  })

  it('clears the savings source when selecting a Pay-with token', () => {
    const positions = shallowRef<PortfolioSavingsPosition<VaultEntity>[]>([
      makeSavingsPosition(SUB_ACCOUNT_A, 100n, 90n),
    ])
    const form = makeForm(positions)
    form.onChangeCollateral(1)

    form.onSelectBorrowSwapAsset({
      address: '0x0000000000000000000000000000000000000099',
      name: 'Pay token',
      symbol: 'PAY',
      decimals: 0,
    })

    expect(form.isSavingCollateral.value).toBe(false)
    expect(form.selectedSavingSubAccount.value).toBeUndefined()
  })

  it('projects swap-funded collateral as new vault cash even with stale savings state', async () => {
    const form = makeForm(shallowRef([
      makeSavingsPosition(SUB_ACCOUNT_A, 100n, 90n),
    ]))
    form.onChangeCollateral(1)
    form.borrowSelectedAsset.value = {
      address: '0x0000000000000000000000000000000000000099',
      name: 'Pay token',
      symbol: 'PAY',
      decimals: 0,
    }
    mocks.borrowEffectiveQuote.value = { amountIn: '100', amountOut: '80' }
    form.collateralAmount.value = '100'
    form.borrowAmount.value = '20'
    form.updateEstimates()

    await vi.waitFor(() => expect(mocks.getProjectedRatesBatch).toHaveBeenCalled())
    const requests = mocks.getProjectedRatesBatch.mock.calls.at(-1)?.[0] as Array<{ cashDelta: bigint }>
    expect(requests[0]?.cashDelta).toBe(80n)
    expect(mocks.getAssetUsdValueForEstimate).toHaveBeenCalledWith(80n, vault, 'off-chain')
  })

  it('keeps projected rate transitions and reward-token identity with the headline', async () => {
    const reward = {
      campaignId: 'supply-rwd',
      source: 'merkl',
      action: 'LEND',
      apr: 0.02,
      rewardTokenSymbol: 'RWD',
      rewardTokenIcon: '/rwd.png',
    } as RewardCampaign
    mocks.supplyRewardApy = 2
    mocks.getSupplyRewardCampaigns.mockReturnValue([reward])
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(100)
    mocks.getProjectedRatesBatch.mockImplementation(async (requests: unknown[]) => requests.map(() => ({
      supplyAPY: 0n,
      borrowAPY: 0n,
    })))
    const form = makeForm(shallowRef([]))
    form.collateralAmount.value = '10'
    form.borrowAmount.value = '2'

    await vi.waitFor(() => expect(form.projectedYieldDetails.value).not.toBeNull())

    const details = form.projectedYieldDetails.value!
    expect(form.netAPY.value).toBe(details.after.total)
    expect(details.after.breakdown.rewards).toBe(2)
    expect(details.rateLines).toMatchObject([
      { label: 'Collateral lending APY', before: 0, after: 0 },
      { label: 'Liability borrow APY', before: 0, after: 0 },
    ])
    expect(details.rewards).toMatchObject([{
      rewardToken: { symbol: 'RWD', icon: '/rwd.png' },
      afterApr: 2,
    }])
  })

  it('keeps projected yield unavailable when a positive form leg has no USD price', async () => {
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(undefined)
    mocks.getProjectedRatesBatch.mockImplementation(async (requests: unknown[]) => requests.map(() => ({
      supplyAPY: 0n,
      borrowAPY: 0n,
    })))
    const form = makeForm(shallowRef([]))
    form.collateralAmount.value = '10'
    form.borrowAmount.value = '2'

    await vi.waitFor(() => expect(mocks.getAssetUsdValueForEstimate).toHaveBeenCalled())
    expect(form.netAPY.value).toBeUndefined()
    expect(form.projectedYieldDetails.value).toBeNull()
  })

  it('refreshes projected rewards when campaign enrichment arrives', async () => {
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(100)
    mocks.getProjectedRatesBatch.mockImplementation(async (requests: unknown[]) => requests.map(() => ({
      supplyAPY: 0n,
      borrowAPY: 0n,
    })))
    const form = makeForm(shallowRef([]))
    form.collateralAmount.value = '10'
    form.borrowAmount.value = '2'
    await vi.waitFor(() => expect(form.projectedYieldDetails.value).not.toBeNull())
    expect(form.projectedYieldDetails.value?.rewards).toEqual([])

    mocks.supplyRewardApy = 2
    mocks.getSupplyRewardCampaigns.mockReturnValue([{
      campaignId: 'late-supply-rwd',
      source: 'merkl',
      action: 'LEND',
      apr: 0.02,
      rewardTokenSymbol: 'RWD',
      rewardTokenIcon: '/rwd.png',
    } as RewardCampaign])
    rewardsVersion.value++

    await vi.waitFor(() => expect(form.projectedYieldDetails.value?.rewards).toMatchObject([{
      rewardToken: { symbol: 'RWD' },
      afterApr: 2,
    }]))
    expect(form.projectedYieldDetails.value?.after.breakdown.rewards).toBe(2)
  })
})
