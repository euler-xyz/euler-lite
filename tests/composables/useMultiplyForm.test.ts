import { computed, ref, shallowRef, watch, watchEffect } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, EVault, IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import { useMultiplyForm } from '~/composables/borrow/useMultiplyForm'

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
      prefetchPluginData: vi.fn(),
      preloadSubAccountSnapshot: vi.fn(),
      fetchSingleBalance: vi.fn(async () => 100n),
      runPreparedSimulation: vi.fn(),
      modalOpen: vi.fn(),
      getSupplyCapWarning: vi.fn(() => ({
        level: 'info',
        title: 'Supply cap reached',
        message: 'The supply cap has been reached. New deposits will fail.',
      })),
      getBorrowCapWarning: vi.fn(() => null),
    },
  }
})

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
  getAssetUsdValueOrZero: vi.fn(async () => 0),
  getAssetOraclePrice: vi.fn(() => ({ amountOutMid: 1n, amountOutAsk: 1n })),
  getCollateralOraclePrice: vi.fn(() => ({ amountOutMid: 1n, amountOutBid: 1n })),
  getCollateralShareOraclePrice: vi.fn(() => ({ amountIn: 1n })),
  conservativePriceRatioNumber: vi.fn(() => 1),
}))

vi.mock('~/utils/vault/apy', () => ({
  getProjectedRates: vi.fn(async () => null),
}))

vi.mock('~/utils/multiply-math', () => ({
  computeLeverageDebt: vi.fn(() => 1n),
  computeMaxMultiplier: vi.fn(() => 5),
  computeMinMultiplier: vi.fn(() => 1),
  computeWeightedSupplyApy: vi.fn(() => 0),
}))

vi.mock('~/utils/swapRouteItems', () => ({
  buildSwapRouteItems: vi.fn(() => []),
}))

vi.mock('~/utils/priceImpact', () => ({
  computeMultipliedPriceImpact: vi.fn(() => null),
}))

vi.mock('~/utils/repayUtils', () => ({
  calculateRoe: vi.fn(() => 0),
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
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('useEulerTx', () => ({
      planMultiply: mocks.planMultiply,
      prepareTransactionPlan: mocks.prepareTransactionPlan,
      executePlan: mocks.executePlan,
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
    vi.stubGlobal('useTxFinalization', () => ({
      finalizeTxAndRedirect: vi.fn(),
    }))
    vi.stubGlobal('useRewardsApy', () => ({
      getSupplyRewardApy: vi.fn(async () => 0),
      getBorrowRewardApy: vi.fn(async () => 0),
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
})
