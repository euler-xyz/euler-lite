import { computed, ref, shallowRef, watch, watchEffect } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, EVault, IHasVaultAddress, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { useMultiplyForm } from '~/composables/borrow/useMultiplyForm'
import type { RewardCampaign } from '~/entities/reward-campaign'

const { USER, makeVault, planAccount, mocks } = vi.hoisted(() => {
  const USER = '0x0000000000000000000000000000000000000001'
  const VAULT = '0x0000000000000000000000000000000000000002'
  const ASSET = '0x0000000000000000000000000000000000000003'

  const makeVault = (supplyCapUtilization = 0, borrowCapUtilization = 0) => ({
    address: VAULT,
    availableLiquidity: 10_000n,
    totalAssets: 1_000n,
    borrow: 0n,
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
    caps: {
      supplyCapUtilization,
      borrowCapUtilization,
    },
    collaterals: [
      {
        address: VAULT,
        borrowLTV: 500000000000000000n,
        liquidationLTV: 750000000000000000n,
      },
    ],
    convertToShares: vi.fn((assets: bigint) => assets),
  }) as unknown as EVault

  return {
    USER,
    VAULT,
    ASSET,
    makeVault,
    planAccount: { chainId: 1 } as Account<IHasVaultAddress>,
    mocks: {
      planMultiply: vi.fn(),
      prepareTransactionPlan: vi.fn(),
      executePlan: vi.fn(),
      executePreparedPlan: vi.fn(),
      prefetchPluginData: vi.fn(),
      preloadSubAccountSnapshot: vi.fn(),
      fetchSingleBalance: vi.fn(async () => 100n),
      runPreparedSimulation: vi.fn(),
      modalOpen: vi.fn(),
      finalizeTxAndRedirect: vi.fn(),
      getSupplyCapWarning: vi.fn(() => ({
        level: 'info',
        title: 'Supply cap reached',
        message: 'The supply cap has been reached. New deposits will fail.',
      })),
      getBorrowCapWarning: vi.fn(() => null),
      getProjectedRatesBatch: vi.fn(async (requests: unknown[]) => requests.map(() => ({ supplyAPY: 0n, borrowAPY: 0n }))),
      getAssetUsdValueForEstimate: vi.fn(async () => 0 as number | undefined),
      getSupplyRewardApy: vi.fn(() => 0),
      getBorrowRewardApyForCollaterals: vi.fn(() => 0),
      getEligibleLoopingRewardApyForCollaterals: vi.fn(() => 0),
      getSupplyRewardCampaigns: vi.fn(() => [] as RewardCampaign[]),
      getBorrowRewardCampaignsForCollaterals: vi.fn(() => [] as RewardCampaign[]),
      getEligibleLoopingRewardCampaignsForCollaterals: vi.fn(() => [] as RewardCampaign[]),
    },
  }
})
const rewardsVersion = ref(0)

vi.mock('#components', () => ({
  OperationReviewModal: {},
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

vi.mock('~/composables/useStateOverrideOptions', () => ({
  useStateOverrideOptions: () => ({
    primeSlotHintsFor: vi.fn(),
    buildStateOverrideOptions: vi.fn(() => ({})),
  }),
}))

vi.mock('~/composables/useSwapQuotesParallel', () => ({
  getCurrentPreparedQuotePlan: (card: { quote?: unknown, plan?: unknown, preparedPlan?: { plan: unknown } } | null, quote: unknown) => {
    if (!card?.preparedPlan || card.quote !== quote) return null
    return { plan: card.plan ?? card.preparedPlan.plan, prepared: card.preparedPlan }
  },
  useSwapQuotesParallel: () => ({
    sortedQuoteCards: ref([]),
    selectedProvider: ref(null),
    selectedQuote: ref(null),
    selectedQuoteCard: ref(null),
    effectiveQuote: ref(null),
    effectiveQuoteFetchedAt: ref(null),
    providersCount: ref(0),
    isLoading: ref(false),
    quoteError: ref(null),
    statusLabel: ref(''),
    getQuoteDiffPct: vi.fn(() => null),
    reset: vi.fn(),
    requestQuotes: vi.fn(),
    selectProvider: vi.fn(),
  }),
}))

vi.mock('~/composables/useMultiplyCollateralOptions', () => ({
  useMultiplyCollateralOptions: () => ({
    collateralOptions: ref([]),
    collateralVaults: ref([]),
  }),
}))

vi.mock('~/composables/useEulerLabels', () => ({
  useEulerProductOfVault: () => null,
}))

vi.mock('~/composables/borrow/useMultiplyCowSwap', () => ({
  useMultiplyCowSwap: () => ({
    cowSwapExecution: ref(null),
    cowSwapOrderStatus: ref(null),
    cowSwapStatusLabel: computed(() => ''),
    submitCowSwapMultiply: vi.fn(),
  }),
}))

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValue: vi.fn(async () => 0),
  getAssetUsdValueForEstimate: mocks.getAssetUsdValueForEstimate,
  getAssetOraclePrice: vi.fn(() => ({ amountOutMid: 1n, amountOutAsk: 1n })),
  getCollateralOraclePrice: vi.fn(() => ({ amountOutMid: 1n, amountOutBid: 1n })),
  getCollateralShareOraclePrice: vi.fn(() => ({ amountIn: 1n })),
  conservativePriceRatioNumber: vi.fn(() => 1),
}))

vi.mock('~/utils/vault/apy', () => ({
  areProjectedRatesComplete: (projectedRates: unknown[], expectedCount: number) =>
    projectedRates.length === expectedCount && projectedRates.every(projected => projected !== null),
  getProjectedRates: vi.fn(async () => null),
  getProjectedRatesBatch: mocks.getProjectedRatesBatch,
  getPositionMultiplier: vi.fn(() => 1),
}))

vi.mock('~/utils/multiply-math', () => ({
  computeLeverageDebt: vi.fn(() => 1n),
  computeMaxMultiplier: vi.fn(() => 5),
  computeMinMultiplier: vi.fn(() => 1),
  computeWeightedSupplyApy: vi.fn((supplyUsd: number, supplyApy: number, longUsd: number | null, longApy: number | null) => {
    if (!longUsd || longUsd <= 0 || longApy === null) return supplyApy
    return (supplyUsd * supplyApy + longUsd * longApy) / (supplyUsd + longUsd)
  }),
}))

vi.mock('~/utils/swapRouteItems', () => ({
  buildSwapRouteItems: vi.fn(() => []),
}))

vi.mock('~/utils/priceImpact', () => ({
  computeMultipliedPriceImpact: vi.fn(() => null),
}))

vi.mock('~/utils/repayUtils', () => ({
  computeNextHealth: vi.fn(() => null),
  computeLiquidationPrice: vi.fn(() => null),
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
  getSupplyCapWarning: mocks.getSupplyCapWarning,
  getBorrowCapWarning: mocks.getBorrowCapWarning,
}))

vi.mock('~/entities/cowswap', () => ({
  COWSWAP_ORDER_DEADLINE_SECONDS: 1800,
  COWSWAP_PROVIDER_EXTRA_DATA: { openPosition: {} },
  buildOpenPositionQuoteAppData: vi.fn(() => ({})),
  getCowSwapChainConfig: vi.fn(() => null),
  isCowProviderOrQuote: vi.fn(() => false),
}))

const makeForm = (vault: EVault) => useMultiplyForm({
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
  formTab: ref('multiply'),
  resolvePendingSubAccount: vi.fn(async () => USER),
  isPendingSubAccountLoading: ref(false),
  isGeoBlocked: computed(() => false),
  isMultiplyRestricted: computed(() => false),
})

describe('useMultiplyForm cap validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getProjectedRatesBatch.mockImplementation(async (requests: unknown[]) => requests.map(() => ({ supplyAPY: 0n, borrowAPY: 0n })))
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(0)
    mocks.getSupplyRewardApy.mockReturnValue(0)
    mocks.getBorrowRewardApyForCollaterals.mockReturnValue(0)
    mocks.getEligibleLoopingRewardApyForCollaterals.mockReturnValue(0)
    mocks.getSupplyRewardCampaigns.mockReturnValue([])
    mocks.getBorrowRewardCampaignsForCollaterals.mockReturnValue([])
    mocks.getEligibleLoopingRewardCampaignsForCollaterals.mockReturnValue([])
    rewardsVersion.value = 0
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('useEulerTx', () => ({
      planMultiply: mocks.planMultiply,
      prepareTransactionPlan: mocks.prepareTransactionPlan,
      executePlan: mocks.executePlan,
      executePreparedPlan: mocks.executePreparedPlan,
      prefetchPluginData: mocks.prefetchPluginData,
      preloadSubAccountSnapshot: mocks.preloadSubAccountSnapshot,
    }))
    vi.stubGlobal('useWagmi', () => ({
      address: ref(USER),
      isConnected: ref(true),
    }))
    vi.stubGlobal('useSpyMode', () => ({
      isSpyMode: ref(true),
      spyAddress: ref(USER),
    }))
    vi.stubGlobal('useEffectiveAddress', () => ({
      address: ref(USER),
      isConnected: ref(true),
      isSpyMode: ref(true),
      spyAddress: ref(USER),
      effectiveAddress: ref(USER),
    }))
    vi.stubGlobal('useEulerAccount', () => ({
      depositPositions: ref([]),
    }))
    vi.stubGlobal('usePlanAccount', () => ({
      account: shallowRef(planAccount),
    }))
    vi.stubGlobal('useEulerAddresses', () => ({
      chainId: ref(1),
    }))
    vi.stubGlobal('useWallets', () => ({
      getBalance: vi.fn(() => 100n),
      fetchSingleBalance: mocks.fetchSingleBalance,
    }))
    vi.stubGlobal('useTxBatch', () => ({
      entryCount: ref(0),
    }))
    vi.stubGlobal('useCowSwapEligibility', () => ({ cowSwapForcedOff: ref(false) }))
    vi.stubGlobal('useTxFinalization', () => ({
      finalizeTxAndRedirect: mocks.finalizeTxAndRedirect,
    }))
    vi.stubGlobal('useRewardsApy', () => ({
      version: rewardsVersion,
      getSupplyRewardApy: mocks.getSupplyRewardApy,
      getBorrowRewardApyForCollaterals: mocks.getBorrowRewardApyForCollaterals,
      getEligibleLoopingRewardApyForCollaterals: mocks.getEligibleLoopingRewardApyForCollaterals,
      getSupplyRewardCampaigns: mocks.getSupplyRewardCampaigns,
      getBorrowRewardCampaignsForCollaterals: mocks.getBorrowRewardCampaignsForCollaterals,
      getEligibleLoopingRewardCampaignsForCollaterals: mocks.getEligibleLoopingRewardCampaignsForCollaterals,
    }))
    vi.stubGlobal('useUserSettings', () => ({
      settings: ref({ enableIntrinsicApy: false }),
    }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({
      runPreparedSimulation: mocks.runPreparedSimulation,
      simulationError: ref(null),
      clearSimulationError: vi.fn(),
    }))
    vi.stubGlobal('usePriceInvert', () => ({
      autoInvert: vi.fn(),
      invertValue: vi.fn((value: number | null) => value),
      displaySymbol: 'USDC',
      toggle: vi.fn(),
    }))
    vi.stubGlobal('useSlippage', () => ({
      slippage: ref(0.5),
    }))
    vi.stubGlobal('ltvToPercent', () => 50)
    vi.stubGlobal('valueToNano', (value: string | number, decimals = 0) => BigInt(Math.round(Number(value || 0) * 10 ** Number(decimals))))
    vi.stubGlobal('nanoToValue', (value: bigint, decimals = 0) => Number(value) / 10 ** Number(decimals))
    vi.stubGlobal('getIsSupplyCapReached', (vault: EVault) => vault.caps.supplyCapUtilization >= 100)
    vi.stubGlobal('getIsBorrowCapReached', (vault: EVault) => vault.caps.borrowCapUtilization >= 100)
    vi.stubGlobal('getVaultSupplyApy', () => 0)
    vi.stubGlobal('getVaultBorrowApy', () => 0)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('surfaces a reached supply cap as the multiply disabled reason and form warning', () => {
    const vault = makeVault(100, 0)
    const form = makeForm(vault)

    form.initMultiplySupplyVault(vault)

    expect(form.isMultiplySubmitDisabled.value).toBe(true)
    expect(form.multiplyCapErrorText.value).toBe('The supply cap has been reached. New deposits will fail.')

    form.multiplyInputAmount.value = '1'
    form.multiplier.value = 2

    expect(form.isMultiplySubmitDisabled.value).toBe(true)
    expect(form.multiplyCapErrorText.value).toBe('The supply cap has been reached. New deposits will fail.')
    expect(form.multiplyFormWarnings.value).toContainEqual({
      level: 'info',
      title: 'Supply cap reached',
      message: 'The supply cap has been reached. New deposits will fail.',
    })
  })

  it('projects only the borrowed long deposit for savings collateral', async () => {
    const vault = makeVault(0, 0)
    const form = makeForm(vault)
    form.initMultiplySupplyVault(vault)
    form.isMultiplySavingCollateral.value = true
    form.multiplyInputAmount.value = '5'
    form.multiplier.value = 2

    await vi.waitFor(() => expect(mocks.getProjectedRatesBatch).toHaveBeenCalled())
    const requests = mocks.getProjectedRatesBatch.mock.calls.at(-1)?.[0] as Array<{ cashDelta: bigint }>
    expect(requests[0]?.cashDelta).toBe(1n)
  })

  it('derives projected Net APY, ROE, and rate transitions from one breakdown', async () => {
    const rateUnit = 10n ** 25n
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(100)
    mocks.getProjectedRatesBatch.mockResolvedValue([
      { supplyAPY: 2n * rateUnit, borrowAPY: 0n },
      { supplyAPY: 0n, borrowAPY: rateUnit },
    ])
    const vault = makeVault(0, 0)
    const form = makeForm(vault)
    form.initMultiplySupplyVault(vault)
    form.multiplyInputAmount.value = '1'
    form.multiplier.value = 2

    await vi.waitFor(() => expect(form.multiplyNetApyAfter.value).toBe(1.5))
    expect(form.multiplyRoeAfter.value).toBe(3)
    expect(form.projectedYieldDetails.value?.netApy.after.total).toBe(form.multiplyNetApyAfter.value)
    expect(form.projectedYieldDetails.value?.roe.after.total).toBe(form.multiplyRoeAfter.value)
    expect(form.projectedYieldDetails.value?.netApy.rateLines).toMatchObject([
      { label: 'Collateral lending APY', before: 0, after: 2 },
      { label: 'Liability borrow APY', before: 0, after: 1 },
    ])
  })

  it('hides projected APY when a requested rate is unavailable', async () => {
    mocks.getProjectedRatesBatch.mockResolvedValueOnce([null])
    const vault = makeVault(0, 0)
    const form = makeForm(vault)
    form.initMultiplySupplyVault(vault)
    form.multiplyInputAmount.value = '1'
    form.multiplier.value = 2

    await vi.waitFor(() => expect(mocks.getProjectedRatesBatch).toHaveBeenCalled())
    expect(form.multiplyNetApyAfter.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()
  })

  it('hides projected metrics when a positive leg has no USD price', async () => {
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(undefined)
    const vault = makeVault(0, 0)
    const form = makeForm(vault)
    form.initMultiplySupplyVault(vault)
    form.multiplyInputAmount.value = '1'
    form.multiplier.value = 2

    await vi.waitFor(() => expect(mocks.getAssetUsdValueForEstimate).toHaveBeenCalled())
    expect(form.multiplySupplyValueUsd.value).toBeNull()
    expect(form.multiplyLongValueUsd.value).toBeNull()
    expect(form.multiplyBorrowValueUsd.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()
  })

  it('keeps projected risk metrics unavailable while long-collateral pricing is pending', async () => {
    let resolveLongValue!: (value: number) => void
    const pendingLongValue = new Promise<number>((resolve) => {
      resolveLongValue = resolve
    })
    let priceCall = 0
    mocks.getAssetUsdValueForEstimate.mockImplementation(async () => {
      priceCall++
      if (priceCall === 2) return pendingLongValue
      return 100
    })
    const vault = makeVault(0, 0)
    const form = makeForm(vault)
    form.initMultiplySupplyVault(vault)
    form.multiplyInputAmount.value = '1'
    form.multiplier.value = 2

    await vi.waitFor(() => expect(mocks.getAssetUsdValueForEstimate).toHaveBeenCalledTimes(3))
    expect(form.multiplyLongValueUsd.value).toBeNull()
    expect(form.multiplyTotalSupplyUsd.value).toBeNull()
    expect(form.multiplyNextLtv.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()

    resolveLongValue(100)

    await vi.waitFor(() => expect(form.multiplyTotalSupplyUsd.value).toBe(200))
    expect(form.multiplyNextLtv.value).toBe(50)
    expect(form.projectedYieldDetails.value).not.toBeNull()
  })

  it('preserves each after-eligible reward campaign and its token identity', async () => {
    const campaigns = {
      supply: {
        campaignId: 'supply', source: 'merkl', action: 'LEND', apr: 0.02,
        rewardTokenSymbol: 'SUP', rewardTokenIcon: '/sup.png',
      } as RewardCampaign,
      borrow: {
        campaignId: 'borrow', source: 'brevis', action: 'BORROW', apr: 0.03,
        rewardTokenSymbol: 'BRW', rewardTokenIcon: '/brw.png',
      } as RewardCampaign,
      looping: {
        campaignId: 'looping', source: 'fuul', action: 'LOOPING', apr: 0.04,
        rewardTokenSymbol: 'LOOP', rewardTokenIcon: '/loop.png',
      } as RewardCampaign,
    }
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(100)
    mocks.getSupplyRewardApy.mockReturnValue(2)
    mocks.getBorrowRewardApyForCollaterals.mockReturnValue(3)
    mocks.getEligibleLoopingRewardApyForCollaterals.mockReturnValue(4)
    mocks.getSupplyRewardCampaigns.mockReturnValue([campaigns.supply])
    mocks.getBorrowRewardCampaignsForCollaterals.mockReturnValue([campaigns.borrow])
    mocks.getEligibleLoopingRewardCampaignsForCollaterals.mockReturnValue([campaigns.looping])
    const vault = makeVault(0, 0)
    const form = makeForm(vault)
    form.initMultiplySupplyVault(vault)
    form.multiplyInputAmount.value = '1'
    form.multiplier.value = 2

    await vi.waitFor(() => expect(form.projectedYieldDetails.value?.netApy.rewards).toHaveLength(3))

    expect(form.projectedYieldDetails.value?.netApy.after.breakdown.rewards).toBe(5.5)
    expect(form.projectedYieldDetails.value?.netApy.rewards.map(reward => ({
      symbol: reward.rewardToken.symbol,
      icon: reward.rewardToken.icon,
      afterApr: reward.afterApr,
    }))).toEqual([
      { symbol: 'BRW', icon: '/brw.png', afterApr: 3 },
      { symbol: 'LOOP', icon: '/loop.png', afterApr: 4 },
      { symbol: 'SUP', icon: '/sup.png', afterApr: 2 },
    ])
  })

  it('re-prepares and executes only a multiply envelope matching the review', async () => {
    const plan = [{ type: 'evcBatch', items: [] }] as TransactionPlan
    const reviewed = {
      __prepared: true,
      chainId: 1,
      account: USER,
      usePermit2: false,
      unlimitedApproval: false,
      plan,
    } as TransactionPlanPrepared
    const refreshed = { ...reviewed, plan: [...plan] } as TransactionPlanPrepared
    mocks.planMultiply.mockResolvedValue(plan)
    mocks.prepareTransactionPlan
      .mockResolvedValueOnce(reviewed)
      .mockResolvedValueOnce(refreshed)
    mocks.runPreparedSimulation.mockResolvedValue(true)
    const vault = makeVault(0, 0)
    const form = makeForm(vault)
    form.initMultiplySupplyVault(vault)
    form.multiplyInputAmount.value = '1'
    form.multiplier.value = 2

    await form.submitMultiply()
    const modalOptions = mocks.modalOpen.mock.calls[0]?.[1] as {
      props: { onConfirm: (scope: { markSucceeded: () => void }) => Promise<void> }
    }
    const scope = { markSucceeded: vi.fn() }
    await modalOptions.props.onConfirm(scope)

    expect(mocks.prepareTransactionPlan).toHaveBeenLastCalledWith(plan, { account: planAccount })
    expect(mocks.executePreparedPlan).toHaveBeenCalledWith(refreshed)
    expect(mocks.executePlan).not.toHaveBeenCalled()
    expect(mocks.finalizeTxAndRedirect).toHaveBeenCalledWith({ scope })
  })

  it('rejects a materially changed multiply envelope after review', async () => {
    const plan = [{ type: 'evcBatch', items: [] }] as TransactionPlan
    const reviewed = {
      __prepared: true,
      chainId: 1,
      account: USER,
      usePermit2: false,
      unlimitedApproval: false,
      plan,
    } as TransactionPlanPrepared
    const changed = { ...reviewed, unlimitedApproval: true } as TransactionPlanPrepared
    mocks.planMultiply.mockResolvedValue(plan)
    mocks.prepareTransactionPlan
      .mockResolvedValueOnce(reviewed)
      .mockResolvedValueOnce(changed)
    mocks.runPreparedSimulation.mockResolvedValue(true)
    const vault = makeVault(0, 0)
    const form = makeForm(vault)
    form.initMultiplySupplyVault(vault)
    form.multiplyInputAmount.value = '1'
    form.multiplier.value = 2

    await form.submitMultiply()
    const modalOptions = mocks.modalOpen.mock.calls[0]?.[1] as {
      props: { onConfirm: (scope: { markSucceeded: () => void }) => Promise<void> }
    }
    await modalOptions.props.onConfirm({ markSucceeded: vi.fn() })

    expect(mocks.executePreparedPlan).not.toHaveBeenCalled()
    expect(mocks.executePlan).not.toHaveBeenCalled()
    expect(mocks.finalizeTxAndRedirect).not.toHaveBeenCalled()
  })
})
