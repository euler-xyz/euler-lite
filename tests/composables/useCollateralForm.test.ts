import { computed, effectScope, nextTick, ref, shallowRef, getCurrentScope, type EffectScope, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault, IAccountLiquidity, SwapQuote } from '@eulerxyz/euler-v2-sdk'
import type { VaultAsset } from '~/types/asset'
import type { RewardCampaign } from '~/entities/reward-campaign'
import { FixedPoint } from '~/utils/fixed-point'
import { getBorrowLtvWithdrawLimit, getBorrowLtvWithdrawNotice, validateCollateralWithdraw } from '~/utils/vault/withdraw'
import { useCollateralForm, type UseCollateralFormOptions } from '~/composables/position/useCollateralForm'

const { COLLATERAL_VAULT, NEW_COLLATERAL_VAULT, wethAsset, usdcAsset, collateralVault, borrowVault, mocks } = vi.hoisted(() => {
  const COLLATERAL_VAULT = '0x0000000000000000000000000000000000000002'
  const NEW_COLLATERAL_VAULT = '0x0000000000000000000000000000000000000006'
  const BORROW_VAULT = '0x0000000000000000000000000000000000000004'
  const wethAsset = {
    address: '0x0000000000000000000000000000000000000003',
    symbol: 'WETH',
    decimals: 18,
  }
  const usdcAsset = {
    address: '0x0000000000000000000000000000000000000005',
    symbol: 'USDC',
    decimals: 6,
  }
  const collateralVault = {
    address: COLLATERAL_VAULT,
    asset: wethAsset,
    shares: { address: COLLATERAL_VAULT, symbol: 'eWETH', decimals: 18 },
    totalCash: 100n * 10n ** 18n,
    totalBorrowed: 0n,
    collaterals: [],
    convertToShares: (assets: bigint) => assets,
    previewWithdraw: (assets: bigint) => assets,
  } as unknown as EVault
  const borrowVault = {
    address: BORROW_VAULT,
    asset: usdcAsset,
    shares: { address: BORROW_VAULT, symbol: 'eUSDC', decimals: 6 },
    totalCash: 1_000_000n * 10n ** 6n,
    totalBorrowed: 0n,
    collaterals: [{ address: COLLATERAL_VAULT, borrowLTV: 8000, liquidationLTV: 8600 }],
  } as unknown as EVault
  return {
    COLLATERAL_VAULT,
    NEW_COLLATERAL_VAULT,
    wethAsset,
    usdcAsset,
    collateralVault,
    borrowVault,
    mocks: {
      getProjectedRates: vi.fn(async () => null),
      getNetAPY: vi.fn(() => 0),
      getNetAPYFromWeightedSupplySnapshot: vi.fn((
        snapshot: { supplyUsd?: number, weightedSupplyApy?: number | null, isComplete?: boolean } = {},
        fallbackSupplyApy = 0,
        borrowUsd = 0,
        borrowApy = 0,
        fallbackSupplyRewardApy = 0,
        borrowRewardApy = 0,
        loopingRewardApy = 0,
      ) => {
        if (snapshot.isComplete === false) return null
        const supplyUsd = snapshot.supplyUsd ?? 0
        if (supplyUsd === 0) return 0
        const supplyApy = snapshot.weightedSupplyApy ?? fallbackSupplyApy
        const supplyRewardApy = snapshot.weightedSupplyApy === null ? fallbackSupplyRewardApy : 0
        return (
          supplyUsd * (supplyApy + supplyRewardApy)
          - borrowUsd * (borrowApy - borrowRewardApy)
          + (supplyUsd - borrowUsd) * loopingRewardApy
        ) / supplyUsd
      }),
      getCollateralApySnapshot: vi.fn(async (
        _position?: unknown,
        _borrowVault?: unknown,
        _options?: unknown,
      ) => ({ supplyUsd: 0, weightedSupplyApy: null })),
      getBorrowRewardApyForCollaterals: vi.fn((
        _borrowVaultAddress = '',
        _collateralAddresses: readonly string[] = [],
      ) => 0),
      getBorrowRewardCampaignsForCollaterals: vi.fn((): RewardCampaign[] => []),
      getEligibleLoopingRewardApyForCollaterals: vi.fn(() => 0),
      getEligibleLoopingRewardCampaignsForCollaterals: vi.fn((): RewardCampaign[] => []),
      getAssetUsdValueForEstimate: vi.fn(async () => 0 as number | undefined),
    },
  }
})
const rewardsVersion = ref(0)

vi.mock('#components', () => ({
  OperationReviewModal: {},
  SwapTokenSelector: {},
  SlippageSettingsModal: {},
}))

vi.mock('@eulerxyz/euler-v2-sdk', () => ({
  isEVault: () => true,
  SwapperMode: { EXACT_IN: 0, TARGET_DEBT: 2 },
}))

vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({ open: vi.fn(), close: vi.fn() }),
}))

vi.mock('~/components/ui/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))

vi.mock('~/utils/vault/apy', () => ({
  getProjectedRates: mocks.getProjectedRates,
  getNetAPY: mocks.getNetAPY,
  getNetAPYFromWeightedSupplySnapshot: mocks.getNetAPYFromWeightedSupplySnapshot,
  getPositionMultiplier: vi.fn(() => 1),
}))

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValueForEstimate: mocks.getAssetUsdValueForEstimate,
  getCollateralUsdValueOrZero: vi.fn(async () => 0),
}))

vi.mock('~/composables/useGeoBlock', () => ({
  isAnyVaultBlockedByCountry: vi.fn(() => false),
  isVaultRestrictedByCountry: vi.fn(() => false),
  isAssetBlockedByCountry: vi.fn(() => false),
  isAssetRestrictedByCountry: vi.fn(() => false),
}))

vi.mock('~/utils/operationGuardRegistry', async () => {
  const { ref } = await import('vue')
  return { isOperationBlocked: ref(false) }
})

vi.mock('~/composables/useVaultRegistry', () => ({
  useVaultRegistry: () => ({ getOrFetch: vi.fn(async () => collateralVault) }),
}))

vi.mock('~/utils/vault-intrinsic-apy', () => ({
  withVaultIntrinsicApy: (apy: number) => apy,
}))

// Mutable quote state shared with the composable — tests drive
// `effectiveQuote` to simulate quotes arriving/being cleared.
vi.mock('~/composables/useSwapQuotesParallel', async () => {
  const { ref } = await import('vue')
  const effectiveQuote = ref<SwapQuote | null>(null)
  const selectedQuote = ref<SwapQuote | null>(null)
  const api = {
    sortedQuoteCards: ref([]),
    selectedProvider: ref(null),
    selectedQuote,
    selectedQuoteCard: ref(null),
    effectiveQuote,
    effectiveQuoteFetchedAt: ref(null),
    providersCount: ref(0),
    isLoading: ref(false),
    quoteError: ref(null),
    statusLabel: ref(''),
    getQuoteDiffPct: vi.fn(() => null),
    reset: vi.fn(() => {
      effectiveQuote.value = null
      selectedQuote.value = null
    }),
    requestQuotes: vi.fn(async () => {}),
    selectProvider: vi.fn(),
  }
  return { useSwapQuotesParallel: () => api, __swapApi: api }
})

vi.mock('~/composables/useStateOverrideOptions', () => ({
  useStateOverrideOptions: () => ({
    primeSlotHintsFor: vi.fn(),
    buildStateOverrideOptions: vi.fn(() => ({})),
  }),
}))

vi.mock('~/utils/swapRouteItems', () => ({
  buildSwapRouteItems: vi.fn(() => []),
}))

vi.mock('~/composables/useSwapPriceImpact', async () => {
  const { ref } = await import('vue')
  return { useSwapPriceImpact: () => ({ priceImpact: ref(null) }) }
})

vi.mock('~/composables/usePriceImpactGate', () => ({
  usePriceImpactGate: () => ({
    guardWithPriceImpact: (cb: () => Promise<void>) => cb(),
  }),
}))

vi.mock('~/utils/string-utils', () => ({
  formatSmartAmount: (v: string) => v,
}))

vi.mock('~/utils/crypto-utils', () => ({
  nanoToValue: (v: bigint, decimals: number) => Number(v) / 10 ** decimals,
}))

vi.mock('~/utils/accountPositionHelpers', () => ({
  normalizeAddressOrEmpty: (a?: string) => (a || '').toLowerCase(),
}))

vi.mock('~/utils/vault-hooks', () => ({
  OP_DEPOSIT: 'deposit',
  OP_WITHDRAW: 'withdraw',
  isOpDisabled: vi.fn(() => false),
}))

vi.mock('~/composables/useVaultWarnings', () => ({
  getHookDisabledWarning: vi.fn(() => null),
}))

vi.mock('~/utils/ltv', () => ({
  decimalLtvToBps: (v: number) => BigInt(Math.round(v * 10000)),
  getBorrowPositionEffectiveLiquidationLTV: vi.fn(() => 0.86),
}))

vi.mock('~/utils/errorHandling', () => ({
  logWarn: vi.fn(),
}))

vi.mock('~/utils/race-guard', () => ({
  createRaceGuard: () => {
    let latest = 0
    return {
      next: () => ++latest,
      isStale: (generation: number) => generation !== latest,
    }
  },
}))

vi.mock('~/utils/tx-errors', () => ({
  getTxErrorMessage: vi.fn(async () => ''),
}))

const getSwapApi = async () => {
  const mod = await import('~/composables/useSwapQuotesParallel') as unknown as {
    __swapApi: {
      effectiveQuote: Ref<SwapQuote | null>
      selectedQuote: Ref<SwapQuote | null>
      reset: () => void
    }
  }
  return mod.__swapApi
}

const makePosition = () => ({
  subAccount: '0x0000000000000000000000000000000000000011',
  collateralVault,
  borrowVault,
  supplied: 10n * 10n ** 18n,
  borrowed: 5000n * 10n ** 6n,
  collaterals: [{ vaultAddress: COLLATERAL_VAULT, assets: 10n * 10n ** 18n }],
  healthFactor: 2n * 10n ** 18n,
  userLTV: 4000n,
  currentLTV: 4000n,
})

const WAD = 10n ** 18n
const riskValue = (oracleMid: bigint, liquidation = oracleMid, borrowing = liquidation) => ({ oracleMid, liquidation, borrowing })
const installRiskContext = ({ assets = 100n * WAD, enabled = true } = {}) => {
  const selectedValue = enabled ? riskValue(assets, assets / 10n, 0n) : riskValue(0n)
  const liquidity: IAccountLiquidity = {
    vaultAddress: borrowVault.address, unitOfAccount: usdcAsset.address as `0x${string}`, daysToLiquidation: 'Infinity',
    liabilityValue: riskValue(70n * WAD),
    totalCollateralValue: riskValue(100n * WAD + selectedValue.oracleMid, 80n * WAD + selectedValue.liquidation, 75n * WAD),
    collaterals: [
      ...(selectedValue.oracleMid ? [{ address: COLLATERAL_VAULT as `0x${string}`, value: selectedValue }] : []),
      { address: NEW_COLLATERAL_VAULT as `0x${string}`, value: riskValue(100n * WAD, 80n * WAD, 75n * WAD) },
    ],
  }
  const pairBorrowVault = {
    ...borrowVault,
    collaterals: [{
      address: COLLATERAL_VAULT, borrowLTV: 0, liquidationLTV: 0, currentLiquidationLTV: 0.1,
      isLiquidationLTVRamping: true, rampTimeRemaining: 100n,
      ramping: { initialLiquidationLTV: 1, targetTimestamp: 1000, rampDuration: 1000n },
      oraclePriceRaw: { amountIn: WAD, amountOutMid: WAD, queryFailure: false },
    }],
  }
  const controllerPosition: { liquidity: IAccountLiquidity | undefined } = { liquidity }
  const collateralPosition = { assets, shares: assets }
  const accountRef = shallowRef({
    getSubAccount: () => ({ enabledCollaterals: enabled ? [COLLATERAL_VAULT] : [] }),
    getPosition: (_subAccount: string, vault: string): { liquidity?: IAccountLiquidity, assets?: bigint, shares?: bigint } =>
      vault === borrowVault.address ? controllerPosition : collateralPosition,
    isCollateralEnabled: () => enabled,
  })
  vi.stubGlobal('usePlanAccount', () => ({ account: accountRef }))
  vi.stubGlobal('useEulerAccount', () => ({
    isPositionsLoaded: ref(true),
    getPositionBySubAccountIndex: () => ({
      ...makePosition(), borrowVault: pairBorrowVault, supplied: assets,
      collaterals: [{ vaultAddress: COLLATERAL_VAULT, assets, shares: assets }],
      borrow: { liquidity },
    }),
  }))
  return { accountRef, liquidity, controllerPosition, pairBorrowVault, assets }
}
const makeRiskForm = (_context: ReturnType<typeof installRiskContext>, mode: 'supply' | 'withdraw', swap = false) => {
  const borrowLimit = () => getBorrowLtvWithdrawLimit({
    liquidity: form.controllerLiquidity.value,
    collateralAddress: form.collateralVault.value!.address,
    collateralAssets: form.collateralAssets.value,
  })
  const form = makeForm({
    mode, needsSwap: computed(() => swap),
    effectiveBalance: computed(() => mode === 'withdraw' ? borrowLimit() ?? form.collateralAssets.value : 1_000n * WAD),
    effectiveAsset: computed(() => (swap && mode === 'supply' ? usdcAsset : wethAsset) as VaultAsset),
    validateEstimate: mode === 'supply'
      ? () => {}
      : ({ amountFixed, suppliedFixed, hasLiquidationLiquidity }) => validateCollateralWithdraw({
          amount: amountFixed.value, collateralAssets: suppliedFixed.value,
          borrowLimit: borrowLimit(), cashLimit: 1_000n * WAD, hasLiquidationLiquidity,
        }),
  })
  return form
}

const makeCampaign = (
  campaignId: string,
  action: RewardCampaign['action'],
  rewardTokenSymbol: string,
): RewardCampaign => ({
  campaignId,
  source: 'merkl',
  action,
  apr: 0.01,
  rewardTokenSymbol,
  rewardTokenIcon: `/${rewardTokenSymbol.toLowerCase()}.png`,
} as RewardCampaign)

const flush = async () => {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
}

const formScopes: EffectScope[] = []
const makeForm = (overrides: Partial<UseCollateralFormOptions> = {}) => {
  const scope = effectScope()
  formScopes.push(scope)
  return scope.run(() => useCollateralForm({
    mode: 'supply',
    needsSwap: computed(() => true),
    effectiveBalance: computed(() => 1_000_000n * 10n ** 6n),
    effectiveAsset: computed(() => usdcAsset as VaultAsset),
    computePriceFixed: () => FixedPoint.fromValue(10n ** 18n, 18),
    computeLiquidationPrice: () => undefined,
    validateEstimate: () => {},
    buildDirectPlan: async () => ({}) as never,
    buildSwapPlan: async () => ({}) as never,
    createReviewIntent: () => ({}) as never,
    requestSwapQuoteParams: () => null,
    getSwapOutputAsset: () => wethAsset as VaultAsset,
    reviewLabel: 'Review Supply',
    reviewType: 'supply',
    swapReviewType: 'swap-supply',
    getReviewAsset: () => wethAsset as VaultAsset,
    getSwapToAsset: () => wethAsset as VaultAsset,
    ...overrides,
  }))!
}

describe('useCollateralForm', () => {
  beforeEach(async () => {
    vi.stubGlobal('useOperationIntentFactory', () => ({ create: vi.fn() }))
    vi.stubGlobal('useExecutionReview', () => ({
      capture: (currentIntents: unknown[], _options: unknown, preparedIntents?: unknown[]) => ({
        intents: preparedIntents ?? currentIntents,
        usesPreparedIntents: !!preparedIntents,
        open: vi.fn(),
      }),
    }))
    vi.clearAllMocks()
    mocks.getCollateralApySnapshot.mockResolvedValue({ supplyUsd: 0, weightedSupplyApy: null })
    mocks.getBorrowRewardApyForCollaterals.mockReturnValue(0)
    mocks.getBorrowRewardCampaignsForCollaterals.mockReturnValue([])
    mocks.getEligibleLoopingRewardApyForCollaterals.mockReturnValue(0)
    mocks.getEligibleLoopingRewardCampaignsForCollaterals.mockReturnValue([])
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(0)
    rewardsVersion.value = 0
    const swapApi = await getSwapApi()
    swapApi.effectiveQuote.value = null
    swapApi.selectedQuote.value = null
    vi.stubGlobal('getCurrentScope', getCurrentScope)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('until', () => ({ toBe: async () => {} }))
    vi.stubGlobal('useRoute', () => ({ query: {} }))
    vi.stubGlobal('showError', vi.fn())
    vi.stubGlobal('usePositionIndex', () => '0')
    vi.stubGlobal('useEulerTx', () => ({
      executePlan: vi.fn(),
      executePreparedPlan: vi.fn(),
      prepareTransactionPlan: vi.fn(),
      prefetchPluginData: vi.fn(),
    }))
    vi.stubGlobal('useEffectiveAddress', () => ({
      isConnected: ref(true),
      isSpyMode: ref(false),
      effectiveAddress: ref('0x0000000000000000000000000000000000000001'),
    }))
    vi.stubGlobal('usePlanAccount', () => ({ account: shallowRef(null) }))
    vi.stubGlobal('useTxFinalization', () => ({ finalizeTxAndRedirect: vi.fn() }))
    vi.stubGlobal('useEulerAccount', () => ({
      isPositionsLoaded: ref(true),
      getPositionBySubAccountIndex: () => makePosition(),
    }))
    vi.stubGlobal('useRewardsApy', () => ({
      version: rewardsVersion,
      getSupplyRewardApy: () => 0,
      getBorrowRewardApyForCollaterals: mocks.getBorrowRewardApyForCollaterals,
      getBorrowRewardCampaignsForCollaterals: mocks.getBorrowRewardCampaignsForCollaterals,
      getEligibleLoopingRewardApyForCollaterals: mocks.getEligibleLoopingRewardApyForCollaterals,
      getEligibleLoopingRewardCampaignsForCollaterals: mocks.getEligibleLoopingRewardCampaignsForCollaterals,
    }))
    vi.stubGlobal('usePositionCollateralApy', () => ({
      getCollateralApySnapshot: mocks.getCollateralApySnapshot,
    }))
    vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false }) }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({
      runSimulation: vi.fn(),
      runPreparedSimulation: vi.fn(),
      simulationError: ref(null),
      clearSimulationError: vi.fn(),
    }))
    vi.stubGlobal('useVaults', () => ({ isReady: ref(true) }))
    vi.stubGlobal('useEulerAddresses', () => ({
      isReady: ref(true),
      loadEulerConfig: vi.fn(),
      chainId: ref(1),
    }))
    vi.stubGlobal('useSlippage', () => ({ slippage: ref(0.5) }))
    vi.stubGlobal('usePriceInvert', () => ({
      invertValue: (v: number | null) => v,
      displaySymbol: 'WETH',
      toggle: vi.fn(),
    }))
    vi.stubGlobal('valueToNano', (value: string | number, decimals = 0) =>
      BigInt(Math.round(Number(value || 0) * 10 ** Number(decimals))))
    vi.stubGlobal('getVaultSupplyApy', () => 0)
    vi.stubGlobal('getVaultBorrowApy', () => 0)
  })

  afterEach(() => {
    for (const scope of formScopes.splice(0)) scope.stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('swap-supply: collateral delta comes from the quoted output, not the raw amount', async () => {
    const swapApi = await getSwapApi()
    const form = makeForm()
    await flush()

    // User enters 100 (USDC, the pay-with token). No quote yet: the
    // collateral delta must be 0, not "100 WETH".
    form.amount.value = '100'
    await flush()
    expect(form.amountFixed.value.value).toBe(0n)

    // Quote arrives: 100 USDC -> 0.03 WETH.
    const amountOut = 3n * 10n ** 16n
    swapApi.effectiveQuote.value = {
      amountIn: (100n * 10n ** 6n).toString(),
      amountOut: amountOut.toString(),
      tokenIn: usdcAsset,
    } as unknown as SwapQuote
    await flush()

    expect(form.amountFixed.value.value).toBe(amountOut)

    // Async estimates (projected rates / net APY) must also use the quoted
    // output as the collateral cash delta.
    const lastCall = mocks.getCollateralApySnapshot.mock.calls.at(-1) as unknown[]
    const options = lastCall?.[2] as { deltas?: Array<{ assetsDelta: bigint, projectRates?: boolean }> }
    expect(options?.deltas?.[0]?.assetsDelta).toBe(amountOut)
    expect(options?.deltas?.[0]?.projectRates).toBe(true)
  })

  it('swap-supply: keeps projected yield unavailable until a valid quote resolves', async () => {
    const snapshot = {
      supplyUsd: 100,
      weightedSupplyApy: 5,
      weightedBaseSupplyApy: 5,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [COLLATERAL_VAULT],
      entries: [],
      isComplete: true,
    }
    mocks.getCollateralApySnapshot.mockResolvedValue(snapshot)
    const swapApi = await getSwapApi()
    const form = makeForm()
    await flush()
    mocks.getCollateralApySnapshot.mockClear()

    form.amount.value = '100'
    await flush()

    expect(mocks.getCollateralApySnapshot).not.toHaveBeenCalled()
    expect(form.estimateNetAPY.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()

    const amountOut = 3n * 10n ** 16n
    swapApi.effectiveQuote.value = {
      amountIn: (100n * 10n ** 6n).toString(),
      amountOut: amountOut.toString(),
      tokenIn: usdcAsset,
    } as unknown as SwapQuote
    await flush()

    const projectionCalls = mocks.getCollateralApySnapshot.mock.calls.filter(call => call[2])
    expect(projectionCalls.length).toBeGreaterThan(0)
    expect(projectionCalls.every((call) => {
      const options = call[2] as {
        deltas?: Array<{ assetsDelta: bigint, projectRates?: boolean }>
      }
      const delta = options.deltas?.[0]
      return delta?.assetsDelta === amountOut && delta.projectRates === true
    })).toBe(true)
    expect(form.estimateNetAPY.value).not.toBeNull()
    expect(form.projectedYieldDetails.value).not.toBeNull()
  })

  it('swap-supply: clearing the amount invalidates an in-flight projection and late quote', async () => {
    const snapshot = {
      supplyUsd: 100,
      weightedSupplyApy: 5,
      weightedBaseSupplyApy: 5,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [COLLATERAL_VAULT],
      entries: [],
      isComplete: true,
    }
    let resolveProjection!: (value: typeof snapshot) => void
    const pendingProjection = new Promise<typeof snapshot>((resolve) => {
      resolveProjection = resolve
    })
    let amountCleared = false
    let projectionsAfterClear = 0
    mocks.getCollateralApySnapshot.mockImplementation(async (_position?, _borrowVault?, options?) => {
      if (!options) return snapshot
      if (amountCleared) projectionsAfterClear++
      return pendingProjection
    })
    const swapApi = await getSwapApi()
    const form = makeForm()
    await flush()

    form.amount.value = '100'
    await flush()
    const staleQuote = {
      amountIn: (100n * 10n ** 6n).toString(),
      amountOut: (3n * 10n ** 16n).toString(),
      tokenIn: usdcAsset,
    } as unknown as SwapQuote
    swapApi.effectiveQuote.value = staleQuote
    await flush()
    const projectedCallsBeforeClear = mocks.getCollateralApySnapshot.mock.calls
      .filter(call => call[2]).length
    expect(projectedCallsBeforeClear).toBeGreaterThan(0)

    amountCleared = true
    form.amount.value = ''
    await flush()
    expect(swapApi.effectiveQuote.value).toBeNull()
    expect(form.isEstimatesLoading.value).toBe(false)

    // Model a provider response that escaped cancellation. The form-level
    // amount guard must still keep it from starting another projection.
    swapApi.effectiveQuote.value = staleQuote
    await flush()
    expect(projectionsAfterClear).toBe(0)

    resolveProjection(snapshot)
    await flush()
    expect(form.estimateNetAPY.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()
    expect(form.isEstimatesLoading.value).toBe(false)
  })

  it('swap-supply: clearing quotes resets the collateral delta to zero', async () => {
    const snapshot = {
      supplyUsd: 100,
      weightedSupplyApy: 5,
      weightedBaseSupplyApy: 5,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [COLLATERAL_VAULT],
      entries: [],
      isComplete: true,
    }
    mocks.getCollateralApySnapshot.mockResolvedValue(snapshot)
    const swapApi = await getSwapApi()
    const form = makeForm()
    await flush()

    form.amount.value = '100'
    await flush()
    swapApi.effectiveQuote.value = {
      amountIn: (100n * 10n ** 6n).toString(),
      amountOut: (3n * 10n ** 16n).toString(),
      tokenIn: usdcAsset,
    } as unknown as SwapQuote
    await flush()
    expect(form.amountFixed.value.value).toBe(3n * 10n ** 16n)
    expect(form.estimateNetAPY.value).not.toBeNull()
    expect(form.projectedYieldDetails.value).not.toBeNull()

    swapApi.reset()
    await flush()
    expect(form.amountFixed.value.value).toBe(0n)
    expect(form.estimateNetAPY.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()
  })

  it('direct supply: amount is parsed with collateral decimals', async () => {
    const form = makeForm({
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()

    form.amount.value = '2'
    await flush()
    expect(form.amountFixed.value.value).toBe(2n * 10n ** 18n)
  })

  it('withdraw with swap-out: amount stays collateral-denominated, quote is ignored', async () => {
    const swapApi = await getSwapApi()
    const form = makeForm({
      mode: 'withdraw',
      needsSwap: computed(() => true),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
      getSwapOutputAsset: () => usdcAsset as VaultAsset,
    })
    await flush()

    form.amount.value = '2'
    await flush()
    expect(form.amountFixed.value.value).toBe(2n * 10n ** 18n)

    swapApi.effectiveQuote.value = {
      amountIn: (2n * 10n ** 18n).toString(),
      amountOut: (6600n * 10n ** 6n).toString(),
      tokenIn: wethAsset,
    } as unknown as SwapQuote
    await flush()
    expect(form.amountFixed.value.value).toBe(2n * 10n ** 18n)
  })

  it.each(['60', '100'])('withdraw: accepts %s of zero-borrow-LTV collateral when other collateral covers debt', async (amount) => {
    const context = installRiskContext()
    const form = makeRiskForm(context, 'withdraw')
    await flush()
    form.amount.value = amount
    await flush()
    expect(form.estimatesError.value).toBe('')
    expect(form.estimateHealth.value).toBe((90n * WAD - BigInt(amount) * WAD / 10n) * WAD / (70n * WAD))
    expect(form.estimateUserLTV.value).toBe(70n * WAD / (200n - BigInt(amount)) * 100n)
  })

  it.each([false, true])('withdraw: uses the refreshed balance for partial and full withdrawal (swap=%s)', async (swap) => {
    const context = installRiskContext()
    const latestLiquidity = {
      ...context.liquidity,
      totalCollateralValue: riskValue(201n * WAD, 901n * WAD / 10n, 75n * WAD),
      collaterals: [
        { address: COLLATERAL_VAULT as `0x${string}`, value: riskValue(101n * WAD, 101n * WAD / 10n, 0n) },
        context.liquidity.collaterals[1],
      ],
    }
    context.accountRef.value = {
      ...context.accountRef.value,
      getPosition: (_subAccount: string, vault: string) => vault === borrowVault.address
        ? { liquidity: latestLiquidity }
        : { assets: 101n * WAD, shares: 101n * WAD },
    }
    const form = makeRiskForm(context, 'withdraw', swap)
    await flush()
    form.amount.value = '100'
    await flush()
    expect(form.estimatesError.value).toBe('')
    expect(form.collateralAssets.value).toBe(101n * WAD)
    expect(form.estimateHealth.value).toBe(801n * WAD / 700n)
    form.amount.value = '101'
    await flush()
    expect(form.estimatesError.value).toBe('')
    expect(form.estimateHealth.value).toBe(80n * WAD / 70n)
  })

  it.each([
    { oldDebt: 70n, currentDebt: 50n, amount: '7', blocked: false },
    { oldDebt: 50n, currentDebt: 70n, amount: '10', blocked: true },
  ])('withdraw: updates validation after debt changes from $oldDebt to $currentDebt', async ({ oldDebt, currentDebt, amount, blocked }) => {
    const context = installRiskContext()
    const selectedValue = riskValue(100n * WAD, 80n * WAD, 75n * WAD)
    context.liquidity.liabilityValue = riskValue(oldDebt * WAD)
    context.liquidity.totalCollateralValue = selectedValue
    context.liquidity.collaterals = [{ address: COLLATERAL_VAULT as `0x${string}`, value: selectedValue }]
    Object.assign(context.pairBorrowVault.collaterals[0], {
      borrowLTV: 0.75, liquidationLTV: 0.8, currentLiquidationLTV: 0.8, isLiquidationLTVRamping: false,
    })
    const form = makeRiskForm(context, 'withdraw')
    await flush()
    form.amount.value = amount
    await flush()
    expect(form.isSubmitDisabled.value).toBe(!blocked)

    const currentLiquidity = { ...context.liquidity, liabilityValue: riskValue(currentDebt * WAD) }
    context.accountRef.value = {
      ...context.accountRef.value,
      getPosition: (_subAccount: string, vault: string) => vault === borrowVault.address
        ? { liquidity: currentLiquidity }
        : { assets: 100n * WAD, shares: 100n * WAD },
    }
    await flush()

    expect(form.position.value!.borrow.liquidity.liabilityValue.borrowing).toBe(oldDebt * WAD)
    expect(form.controllerLiquidity.value).toBe(currentLiquidity)
    expect(getBorrowLtvWithdrawLimit({
      liquidity: form.controllerLiquidity.value,
      collateralAddress: form.collateralVault.value!.address,
      collateralAssets: form.collateralAssets.value,
    })).toBe((75n * WAD - currentDebt * WAD * 101n / 100n) * 100n / 75n)
    expect(form.isSubmitDisabled.value).toBe(blocked)
    expect(form.estimatesError.value).toBe(blocked ? 'Amount exceeds the borrow LTV limit' : '')
    if (!blocked) expect(form.estimateHealth.value).toBe(744n * WAD / 500n)
  })

  it('withdraw: scales the cap with refreshed holdings without treating the old balance as redeem-all', async () => {
    const context = installRiskContext()
    const selectedValue = riskValue(100n * WAD, 80n * WAD, 75n * WAD)
    context.liquidity.liabilityValue = riskValue(50n * WAD)
    context.liquidity.totalCollateralValue = selectedValue
    context.liquidity.collaterals = [{ address: COLLATERAL_VAULT as `0x${string}`, value: selectedValue }]
    Object.assign(context.pairBorrowVault.collaterals[0], {
      borrowLTV: 0.75, liquidationLTV: 0.8, currentLiquidationLTV: 0.8, isLiquidationLTVRamping: false,
    })
    const form = makeRiskForm(context, 'withdraw')
    await flush()
    form.amount.value = '100'
    await flush()
    expect(form.isSubmitDisabled.value).toBe(true)

    const currentValue = riskValue(200n * WAD, 160n * WAD, 150n * WAD)
    const currentLiquidity = {
      ...context.liquidity, totalCollateralValue: currentValue,
      collaterals: [{ address: COLLATERAL_VAULT as `0x${string}`, value: currentValue }],
    }
    context.accountRef.value = {
      ...context.accountRef.value,
      getPosition: (_subAccount: string, vault: string) => vault === borrowVault.address
        ? { liquidity: currentLiquidity }
        : { assets: 200n * WAD, shares: 200n * WAD },
    }
    await flush()

    expect(form.collateralAssets.value).toBe(200n * WAD)
    expect(form.suppliedFixed.value.value).toBe(200n * WAD)
    expect(getBorrowLtvWithdrawLimit({
      liquidity: form.controllerLiquidity.value,
      collateralAddress: form.collateralVault.value!.address,
      collateralAssets: form.collateralAssets.value,
    })).toBe(995n * WAD / 10n * 200n / 150n)
    expect(form.estimatesError.value).toBe('')
    expect(form.isSubmitDisabled.value).toBe(false)
    expect(form.estimateHealth.value).toBe(8n * WAD / 5n)
  })

  it('withdraw: updates the zero-borrow-LTV notice when other collateral covers repaid debt', async () => {
    const context = installRiskContext()
    context.liquidity.liabilityValue = riskValue(80n * WAD)
    const form = makeRiskForm(context, 'withdraw')
    await flush()
    const notice = () => getBorrowLtvWithdrawNotice({
      liquidity: form.controllerLiquidity.value,
      collateralAddress: form.collateralVault.value!.address,
      collateralBorrowLTV: 0,
      symbol: wethAsset.symbol,
    })
    expect(notice()).not.toBeNull()
    const currentLiquidity = { ...context.liquidity, liabilityValue: riskValue(50n * WAD) }
    context.accountRef.value = {
      ...context.accountRef.value,
      getPosition: (_subAccount: string, vault: string) => vault === borrowVault.address
        ? { liquidity: currentLiquidity }
        : { assets: 100n * WAD, shares: 100n * WAD },
    }
    await flush()
    expect(notice()).toBeNull()
  })

  it('withdraw: treats an absent holding in a known account as zero instead of reusing the portfolio balance', async () => {
    const context = installRiskContext()
    const form = makeRiskForm(context, 'withdraw')
    await flush()
    const currentLiquidity = {
      ...context.liquidity,
      totalCollateralValue: riskValue(100n * WAD, 80n * WAD, 75n * WAD),
      collaterals: [context.liquidity.collaterals[1]],
    }
    context.accountRef.value = {
      ...context.accountRef.value,
      getPosition: (_subAccount: string, vault: string) => vault === borrowVault.address ? { liquidity: currentLiquidity } : undefined,
    }
    await flush()
    form.amount.value = '1'
    await flush()
    expect(form.collateralAssets.value).toBe(0n)
    expect(form.isSubmitDisabled.value).toBe(true)
    expect(form.estimatesError.value).toBe('Not enough liquidity in your position')
  })

  it('withdraw: retains the borrow-LTV rejection when zero-LTV collateral is the only collateral', async () => {
    const context = installRiskContext()
    context.liquidity.totalCollateralValue = riskValue(100n * WAD, 10n * WAD, 0n)
    context.liquidity.collaterals.pop()
    const form = makeRiskForm(context, 'withdraw')
    await flush()
    form.amount.value = '1'
    await flush()
    expect(form.estimatesError.value).toBe('Amount exceeds the borrow LTV limit')
  })

  it('withdraw: rejects insufficient liquidation coverage with a different liquidation liability', async () => {
    const context = installRiskContext()
    context.liquidity.liabilityValue.liquidation = 85n * WAD
    const form = makeRiskForm(context, 'withdraw')
    await flush()
    form.amount.value = '60'
    await flush()
    expect(form.estimatesError.value).toBe('Not enough liquidity for the vault, LTV is too large')
    expect(form.estimateHealth.value).toBeNull()
  })

  it('direct supply: projects the ramping collateral top-up with its current liquidation LTV', async () => {
    const context = installRiskContext()
    const form = makeRiskForm(context, 'supply')
    await flush()
    form.amount.value = '60'
    await flush()
    expect(form.estimateUserLTV.value).toBe(70n * WAD / 260n * 100n)
    expect(form.estimateHealth.value).toBe(96n * WAD / 70n)
  })

  it.each([true, false])('direct supply: handles an empty collateral according to its actual enablement (%s)', async (enabled) => {
    const context = installRiskContext({ assets: 0n, enabled })
    const form = makeRiskForm(context, 'supply')
    await flush()
    form.amount.value = '60'
    await flush()
    expect(form.estimatesError.value).toBe('')
    expect(form.estimateHealth.value).toBe((enabled ? 86n : 80n) * WAD / 70n)
    expect(form.estimateUserLTV.value).toBe(70n * WAD / (enabled ? 160n : 100n) * 100n)
  })

  it('swap supply: credits quoted output and held shares when the plan enables collateral', async () => {
    const context = installRiskContext({ enabled: false })
    const swapApi = await getSwapApi()
    const form = makeRiskForm(context, 'supply', true)
    await flush()
    form.amount.value = '600'
    await flush()
    expect(form.estimateHealth.value).toBeNull()
    swapApi.effectiveQuote.value = { amountIn: '600000000', amountOut: (60n * WAD).toString(), tokenIn: usdcAsset } as SwapQuote
    await flush()
    expect(form.estimateHealth.value).toBe(96n * WAD / 70n)
    expect(form.estimateUserLTV.value).toBe(70n * WAD / 260n * 100n)
  })

  it.each(['liquidity', 'quote'] as const)('supply remains available when the %s estimate is missing', async (missing) => {
    const context = installRiskContext({ assets: 0n })
    if (missing === 'liquidity') context.controllerPosition.liquidity = undefined
    else context.pairBorrowVault.collaterals[0].oraclePriceRaw.queryFailure = true
    const form = makeRiskForm(context, 'supply')
    await flush()
    form.amount.value = '60'
    await flush()
    expect(form.estimatesError.value).toBe('')
    expect(form.estimateHealth.value).toBeNull()
    expect(form.estimateUserLTV.value).toBeNull()
    expect(form.estimateLiquidationPrice.value).toBeUndefined()
    expect(form.isSubmitDisabled.value).toBe(false)
  })

  it('withdraw: fails closed when the controller liquidity is unavailable', async () => {
    const context = installRiskContext()
    context.controllerPosition.liquidity = undefined
    const form = makeRiskForm(context, 'withdraw')
    await flush()
    form.amount.value = '60'
    await flush()
    expect(form.estimatesError.value).toBe('Position liquidity unavailable')
  })

  it('uses shares and controller liquidity from the same replacement account snapshot', async () => {
    const context = installRiskContext()
    const form = makeRiskForm(context, 'supply')
    await flush()
    form.amount.value = '60'
    await flush()
    const latestLiquidity = {
      ...context.liquidity,
      liabilityValue: riskValue(140n * WAD),
      totalCollateralValue: riskValue(400n * WAD, 180n * WAD, 150n * WAD),
      collaterals: context.liquidity.collaterals.map(c => ({ ...c, value: riskValue(c.value.oracleMid * 2n, c.value.liquidation * 2n, c.value.borrowing * 2n) })),
    }
    const latestHoldings = { assets: 200n * WAD, shares: 200n * WAD }
    context.accountRef.value = {
      ...context.accountRef.value,
      getPosition: (_subAccount: string, vault: string) => vault === borrowVault.address ? { liquidity: latestLiquidity } : latestHoldings,
    }
    await flush()
    expect(form.estimateUserLTV.value).toBe(140n * WAD / 460n * 100n)
    expect(form.estimateHealth.value).toBe(186n * WAD / 140n)
  })

  it('recomputes an entered amount when the account snapshot hydrates', async () => {
    const context = installRiskContext()
    const snapshot = context.accountRef.value
    context.accountRef.value = null
    const form = makeRiskForm(context, 'supply')
    await flush()
    form.amount.value = '60'
    await flush()
    expect(form.estimateHealth.value).toBeNull()
    context.accountRef.value = snapshot
    await flush()
    expect(form.estimateHealth.value).toBe(96n * WAD / 70n)
  })

  it('uses the projected collateral set when a new collateral adds borrow rewards', async () => {
    const currentCollateralAddresses = [COLLATERAL_VAULT]
    const projectedCollateralAddresses = [COLLATERAL_VAULT, NEW_COLLATERAL_VAULT]
    mocks.getCollateralApySnapshot.mockImplementation(async (_position?, _borrowVault?, options?) => ({
      supplyUsd: 100,
      weightedSupplyApy: 1,
      collateralAddresses: options ? projectedCollateralAddresses : currentCollateralAddresses,
      entries: [],
      isComplete: true,
    }))
    mocks.getBorrowRewardApyForCollaterals.mockImplementation((_borrowVaultAddress = '', collateralAddresses = []) =>
      collateralAddresses.includes(NEW_COLLATERAL_VAULT) ? 7 : 0)

    const form = makeForm({
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()

    form.amount.value = '1'
    await flush()

    expect(mocks.getBorrowRewardApyForCollaterals).toHaveBeenLastCalledWith(
      borrowVault.address,
      projectedCollateralAddresses,
    )
    expect(form.projectedYieldDetails.value).not.toBeNull()
  })

  it('removes borrow rewards that are ineligible for the projected collateral set', async () => {
    const currentCollateralAddresses = [COLLATERAL_VAULT]
    const projectedCollateralAddresses: string[] = []
    mocks.getCollateralApySnapshot.mockImplementation(async (_position?, _borrowVault?, options?) => ({
      supplyUsd: options ? 0 : 100,
      weightedSupplyApy: options ? null : 1,
      collateralAddresses: options ? projectedCollateralAddresses : currentCollateralAddresses,
      entries: [],
      isComplete: true,
    }))
    mocks.getBorrowRewardApyForCollaterals.mockImplementation((_borrowVaultAddress = '', collateralAddresses = []) =>
      collateralAddresses.includes(COLLATERAL_VAULT) ? 7 : 0)

    const form = makeForm({
      mode: 'withdraw',
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()

    form.amount.value = '10'
    await flush()

    expect(mocks.getBorrowRewardApyForCollaterals).toHaveBeenLastCalledWith(
      borrowVault.address,
      projectedCollateralAddresses,
    )
    expect(form.projectedYieldDetails.value?.after.breakdown.rewards).toBe(0)
  })

  it('builds projected Net APY details with per-vault rates and distinct reward assets', async () => {
    const supplyCampaign = makeCampaign('supply', 'LEND', 'SUPPLY')
    const borrowCampaign = makeCampaign('borrow', 'BORROW_COLLATERAL', 'BORROW')
    const loopingCampaign = makeCampaign('loop', 'LOOPING', 'LOOP')
    const snapshot = (projected: boolean) => ({
      supplyUsd: 100,
      weightedSupplyApy: projected ? 3 : 6,
      weightedBaseSupplyApy: projected ? 2 : 5,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 1,
      collateralAddresses: [COLLATERAL_VAULT],
      entries: [{
        address: COLLATERAL_VAULT,
        vault: collateralVault,
        assets: 10n * 10n ** 18n,
        supplyUsd: 100,
        baseSupplyApy: projected ? 2 : 5,
        intrinsicSupplyApy: 0,
        supplyRewardApy: 1,
        totalSupplyApy: projected ? 3 : 6,
        supplyCampaigns: [supplyCampaign],
      }],
      isComplete: true,
    })
    mocks.getCollateralApySnapshot.mockImplementation(async (_position?, _borrowVault?, options?) =>
      snapshot(Boolean(options)))
    mocks.getBorrowRewardApyForCollaterals.mockReturnValue(2)
    mocks.getBorrowRewardCampaignsForCollaterals.mockReturnValue([borrowCampaign])
    mocks.getEligibleLoopingRewardApyForCollaterals.mockReturnValue(3)
    mocks.getEligibleLoopingRewardCampaignsForCollaterals.mockReturnValue([loopingCampaign])

    const form = makeForm({
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()

    form.amount.value = '1'
    await flush()

    expect(form.projectedYieldDetails.value).toMatchObject({
      metric: 'net-apy',
      before: { total: form.netAPY.value },
      after: { total: form.estimateNetAPY.value },
      rateLines: [{
        label: 'Collateral lending APY',
        symbol: 'WETH',
        before: 5,
        after: 2,
      }],
    })
    expect(form.projectedYieldDetails.value?.rewards.map(reward => reward.rewardToken.symbol))
      .toEqual(['BORROW', 'LOOP', 'SUPPLY'])
  })

  it('clears the projected headline and details when the next snapshot is incomplete', async () => {
    let projectionComplete = true
    const currentSnapshot = {
      supplyUsd: 100,
      weightedSupplyApy: 5,
      weightedBaseSupplyApy: 5,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [COLLATERAL_VAULT],
      entries: [],
      isComplete: true,
    }
    mocks.getCollateralApySnapshot.mockImplementation(async (_position?, _borrowVault?, options?) => {
      if (!options || projectionComplete) return currentSnapshot
      return {
        supplyUsd: 0,
        weightedSupplyApy: null,
        weightedBaseSupplyApy: null,
        weightedIntrinsicSupplyApy: null,
        weightedSupplyRewardApy: null,
        collateralAddresses: [],
        entries: [],
        isComplete: false,
      }
    })

    const form = makeForm({
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()
    form.amount.value = '1'
    await flush()
    expect(form.projectedYieldDetails.value).not.toBeNull()

    projectionComplete = false
    form.amount.value = '2'
    await flush()

    expect(form.estimateNetAPY.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()
  })

  it('clears the projected headline and details when projection rejects', async () => {
    const currentSnapshot = {
      supplyUsd: 100,
      weightedSupplyApy: 5,
      weightedBaseSupplyApy: 5,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [COLLATERAL_VAULT],
      entries: [],
      isComplete: true,
    }
    mocks.getCollateralApySnapshot.mockImplementation(async (_position?, _borrowVault?, options?) => {
      if (options) throw new Error('projection failed')
      return currentSnapshot
    })

    const form = makeForm({
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()

    form.amount.value = '1'
    await flush()

    expect(form.estimateNetAPY.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()
  })

  it('does not restore stale projected details after a newer amount completes', async () => {
    const snapshot = (baseSupplyApy: number) => ({
      supplyUsd: 100,
      weightedSupplyApy: baseSupplyApy,
      weightedBaseSupplyApy: baseSupplyApy,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [COLLATERAL_VAULT],
      entries: [{
        address: COLLATERAL_VAULT,
        vault: collateralVault,
        assets: 10n * 10n ** 18n,
        supplyUsd: 100,
        baseSupplyApy,
        intrinsicSupplyApy: 0,
        supplyRewardApy: 0,
        totalSupplyApy: baseSupplyApy,
        supplyCampaigns: [],
      }],
      isComplete: true,
    })
    let resolveSlowProjection!: (value: ReturnType<typeof snapshot>) => void
    const slowProjection = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      resolveSlowProjection = resolve
    })
    mocks.getCollateralApySnapshot.mockImplementation(async (_position?, _borrowVault?, options?) => {
      if (!options) return snapshot(5)
      const assetsDelta = (options as { deltas?: Array<{ assetsDelta: bigint }> }).deltas?.[0]?.assetsDelta
      if (assetsDelta === 2n * 10n ** 18n) return slowProjection
      return snapshot(assetsDelta === 3n * 10n ** 18n ? 1 : 4)
    })

    const form = makeForm({
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()
    form.amount.value = '1'
    await flush()
    expect(form.projectedYieldDetails.value?.rateLines[0]?.after).toBe(4)

    form.amount.value = '2'
    await nextTick()
    expect(form.estimateNetAPY.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()

    form.amount.value = '3'
    await flush()
    expect(form.projectedYieldDetails.value?.rateLines[0]?.after).toBe(1)

    resolveSlowProjection(snapshot(9))
    await flush()
    expect(form.projectedYieldDetails.value?.rateLines[0]?.after).toBe(1)
  })

  it('clears the current yield baseline while its replacement is in flight', async () => {
    const snapshot = (baseSupplyApy: number) => ({
      supplyUsd: 100,
      weightedSupplyApy: baseSupplyApy,
      weightedBaseSupplyApy: baseSupplyApy,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [COLLATERAL_VAULT],
      entries: [{
        address: COLLATERAL_VAULT,
        vault: collateralVault,
        assets: 10n * 10n ** 18n,
        supplyUsd: 100,
        baseSupplyApy,
        intrinsicSupplyApy: 0,
        supplyRewardApy: 0,
        totalSupplyApy: baseSupplyApy,
        supplyCampaigns: [],
      }],
      isComplete: true,
    })
    let replacementPending = false
    let resolveReplacement!: (value: ReturnType<typeof snapshot>) => void
    const replacement = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      resolveReplacement = resolve
    })
    mocks.getCollateralApySnapshot.mockImplementation(async (_position?, _borrowVault?, options?) => {
      if (options) return snapshot(2)
      return replacementPending ? replacement : snapshot(5)
    })

    const form = makeForm({
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()
    expect(form.netAPY.value).toBe(5)

    form.amount.value = '1'
    await flush()
    expect(form.projectedYieldDetails.value?.before?.total).toBe(5)

    replacementPending = true
    rewardsVersion.value++
    await nextTick()
    expect(form.netAPY.value).toBeNull()
    expect(form.estimateNetAPY.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()

    form.amount.value = '2'
    await flush()
    expect(form.projectedYieldDetails.value?.before).toBeNull()

    resolveReplacement(snapshot(7))
    await flush()
    expect(form.netAPY.value).toBe(7)
    expect(form.projectedYieldDetails.value?.before?.total).toBe(7)
  })

  it('keeps current and projected yield unavailable when positive debt has no USD price', async () => {
    mocks.getCollateralApySnapshot.mockResolvedValue({
      supplyUsd: 100,
      weightedSupplyApy: 5,
    })
    mocks.getAssetUsdValueForEstimate.mockResolvedValue(undefined)

    const form = makeForm({
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()
    expect(form.netAPY.value).toBeNull()

    form.amount.value = '1'
    await flush()
    expect(form.estimateNetAPY.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()
  })

  it('invalidates a pending projection when the replacement baseline rejects', async () => {
    const currentSnapshot = {
      supplyUsd: 100,
      weightedSupplyApy: 5,
      weightedBaseSupplyApy: 5,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [COLLATERAL_VAULT],
      entries: [],
      isComplete: true,
    }
    let replacementPending = false
    let rejectReplacement!: (reason?: unknown) => void
    let resolveProjection!: (value: typeof currentSnapshot) => void
    const replacement = new Promise<typeof currentSnapshot>((_resolve, reject) => {
      rejectReplacement = reject
    })
    const projection = new Promise<typeof currentSnapshot>((resolve) => {
      resolveProjection = resolve
    })
    mocks.getCollateralApySnapshot.mockImplementation(async (_position?, _borrowVault?, options?) => {
      if (options) return projection
      return replacementPending ? replacement : currentSnapshot
    })

    const form = makeForm({
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()
    expect(form.netAPY.value).toBe(5)

    replacementPending = true
    rewardsVersion.value++
    await nextTick()
    expect(form.netAPY.value).toBeNull()

    form.amount.value = '1'
    await nextTick()
    expect(form.isEstimatesLoading.value).toBe(true)

    rejectReplacement(new Error('baseline failed'))
    await flush()

    expect(form.netAPY.value).toBeNull()
    expect(form.estimateNetAPY.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()
    expect(form.isEstimatesLoading.value).toBe(false)

    resolveProjection(currentSnapshot)
    await flush()

    expect(form.estimateNetAPY.value).toBeNull()
    expect(form.projectedYieldDetails.value).toBeNull()
    expect(form.isEstimatesLoading.value).toBe(false)
  })

  it('clears estimate loading when the position disappears during a projection', async () => {
    const snapshot = {
      supplyUsd: 100,
      weightedSupplyApy: 5,
      weightedBaseSupplyApy: 5,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [COLLATERAL_VAULT],
      entries: [],
      isComplete: true,
    }
    let resolveProjection!: (value: typeof snapshot) => void
    const pendingProjection = new Promise<typeof snapshot>((resolve) => {
      resolveProjection = resolve
    })
    mocks.getCollateralApySnapshot.mockImplementation(async (_position?, _borrowVault?, options?) =>
      options ? pendingProjection : snapshot)
    const positionRef = shallowRef<ReturnType<typeof makePosition> | undefined>(makePosition())
    vi.stubGlobal('useEulerAccount', () => ({
      isPositionsLoaded: ref(true),
      getPositionBySubAccountIndex: () => positionRef.value,
    }))
    const form = makeForm({
      needsSwap: computed(() => false),
      effectiveAsset: computed(() => wethAsset as VaultAsset),
    })
    await flush()

    form.amount.value = '1'
    await nextTick()
    expect(form.isEstimatesLoading.value).toBe(true)

    positionRef.value = undefined
    await flush()
    expect(form.isEstimatesLoading.value).toBe(false)
    expect(form.projectedYieldDetails.value).toBeNull()

    resolveProjection(snapshot)
    await flush()
    expect(form.isEstimatesLoading.value).toBe(false)
    expect(form.projectedYieldDetails.value).toBeNull()
  })
})
