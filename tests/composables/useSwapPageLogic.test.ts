import { computed, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SwapperMode, type EVault, type SecuritizeCollateralVault, type SwapQuote, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { useSwapPageLogic } from '~/composables/useSwapPageLogic'

const { captured, useSwapQuotesParallelMock } = vi.hoisted(() => ({
  captured: {
    swapOptions: null as null | {
      buildTxPlanForQuote: (quote: SwapQuote, provider: string) => Promise<TransactionPlan>
    },
  },
  useSwapQuotesParallelMock: vi.fn(),
}))

vi.mock('#components', () => ({
  OperationReviewModal: {},
  SlippageSettingsModal: {},
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

vi.mock('~/composables/usePriceImpactGate', () => ({
  usePriceImpactGate: () => ({
    guardWithPriceImpact: async (fn: () => Promise<void>) => fn(),
  }),
}))

vi.mock('~/composables/useEulerLabels', () => ({
  useEulerProductOfVault: () => computed(() => 'Euler Vault'),
}))

vi.mock('~/composables/useGeoBlock', () => ({
  getVaultTags: vi.fn(() => ({ disabled: false })),
  isAnyVaultBlockedByCountry: vi.fn(() => false),
}))

vi.mock('~/composables/useStateOverrideOptions', () => ({
  useStateOverrideOptions: () => ({
    primeSlotHintsFor: vi.fn(),
    buildStateOverrideOptions: vi.fn(() => ({})),
  }),
}))

vi.mock('~/composables/useSwapQuotesParallel', () => ({
  useSwapQuotesParallel: useSwapQuotesParallelMock,
}))

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValue: vi.fn(async () => null),
}))

vi.mock('~/utils/swapRouteItems', () => ({
  buildSwapRouteItems: vi.fn(() => []),
}))

vi.mock('~/utils/vault-utils', () => ({
  isSameUnderlyingAsset: vi.fn(() => false),
  isSameVault: vi.fn(() => false),
}))

vi.mock('~/utils/operationGuardRegistry', () => ({
  isOperationBlocked: ref(false),
}))

const makeVault = (address: string, assetAddress: string, symbol: string) => ({
  address,
  asset: {
    address: assetAddress,
    symbol,
    decimals: 18,
  },
  shares: {
    decimals: 18,
  },
}) as EVault

describe('useSwapPageLogic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captured.swapOptions = null
    useSwapQuotesParallelMock.mockImplementation((options) => {
      captured.swapOptions = options
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
    })

    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('useRoute', () => ({ query: {} }))
    vi.stubGlobal('useWagmi', () => ({
      isConnected: ref(true),
    }))
    vi.stubGlobal('useEulerTx', () => ({
      executePlan: vi.fn(),
      prefetchPluginData: vi.fn(),
    }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({
      runSimulation: vi.fn(async () => true),
      simulationError: ref(null),
      clearSimulationError: vi.fn(),
    }))
    vi.stubGlobal('useSlippage', () => ({
      slippage: ref(0.5),
    }))
    vi.stubGlobal('usePriceInvert', () => ({
      invertValue: vi.fn((value: number) => value),
      toggle: vi.fn(),
    }))
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('forwards the candidate quote when building a quote-time gas estimation plan', async () => {
    const toVault = makeVault(
      '0x0000000000000000000000000000000000000002',
      '0x0000000000000000000000000000000000000003',
      'WETH',
    )
    const fromVault = shallowRef<EVault | SecuritizeCollateralVault | undefined>(makeVault(
      '0x0000000000000000000000000000000000000004',
      '0x0000000000000000000000000000000000000005',
      'USDC',
    ))
    const toVaultRef = shallowRef<EVault | undefined>(toVault)
    const buildPlan = vi.fn(async (quote?: SwapQuote) => ({ quote }) as unknown as TransactionPlan)

    useSwapPageLogic({
      amountField: 'amountOut',
      compare: 'max',
      fromVault,
      toVault: toVaultRef,
      balance: computed(() => 1000n),
      vaultOptions: computed(() => [toVault]),
      displayAmountField: 'amountOut',
      quoteDiffPrefix: '-',
      buildQuoteRequest: () => null,
      buildPlan,
      getBalanceError: () => null,
      getGeoBlockedAddresses: () => [],
      redirectPath: '/portfolio/saving',
      swapperMode: SwapperMode.EXACT_IN,
    })

    const quote = { amountIn: '100', amountOut: '200' } as SwapQuote
    const plan = await captured.swapOptions?.buildTxPlanForQuote(quote, 'provider')

    expect(buildPlan).toHaveBeenCalledWith(quote)
    expect(plan).toEqual({ quote })
  })
})
