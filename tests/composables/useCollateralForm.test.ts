import { computed, nextTick, ref, shallowRef, getCurrentScope, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault, SwapQuote } from '@eulerxyz/euler-v2-sdk'
import type { VaultAsset } from '~/types/asset'
import { FixedPoint } from '~/utils/fixed-point'
import { useCollateralForm, type UseCollateralFormOptions } from '~/composables/position/useCollateralForm'

const { COLLATERAL_VAULT, wethAsset, usdcAsset, collateralVault, borrowVault, mocks } = vi.hoisted(() => {
  const COLLATERAL_VAULT = '0x0000000000000000000000000000000000000002'
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
    wethAsset,
    usdcAsset,
    collateralVault,
    borrowVault,
    mocks: {
      getProjectedRates: vi.fn(async () => null),
      getNetAPY: vi.fn(() => 0),
    },
  }
})

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
}))

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValueOrZero: vi.fn(async () => 0),
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
  createRaceGuard: () => ({ next: () => 0, isStale: () => false }),
}))

vi.mock('~/utils/position-estimates', () => ({
  getTotalCollateralValue: vi.fn(() => null),
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

const flush = async () => {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
}

const makeForm = (overrides: Partial<UseCollateralFormOptions> = {}) => useCollateralForm({
  mode: 'supply',
  needsSwap: computed(() => true),
  effectiveBalance: computed(() => 1_000_000n * 10n ** 6n),
  effectiveAsset: computed(() => usdcAsset as VaultAsset),
  computePriceFixed: () => FixedPoint.fromValue(10n ** 18n, 18),
  computeLiquidationPrice: () => undefined,
  validateEstimate: () => {},
  buildDirectPlan: async () => ({}) as never,
  buildSwapPlan: async () => ({}) as never,
  requestSwapQuoteParams: () => null,
  getSwapOutputAsset: () => wethAsset as VaultAsset,
  reviewLabel: 'Review Supply',
  reviewType: 'supply',
  swapReviewType: 'swap-supply',
  getReviewAsset: () => wethAsset as VaultAsset,
  getSwapToAsset: () => wethAsset as VaultAsset,
  ...overrides,
})

describe('useCollateralForm amount denomination', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
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
      getSupplyRewardApy: () => 0,
      getBorrowRewardApy: () => 0,
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
    const lastCall = mocks.getProjectedRates.mock.calls.at(-1) as unknown[]
    expect(lastCall?.[3]).toBe(amountOut)
  })

  it('swap-supply: clearing quotes resets the collateral delta to zero', async () => {
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

    swapApi.reset()
    await flush()
    expect(form.amountFixed.value.value).toBe(0n)
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
})
