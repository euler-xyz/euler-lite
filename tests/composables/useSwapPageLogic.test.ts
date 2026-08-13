import { computed, ref, shallowRef, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SwapperMode, type EVault, type SecuritizeCollateralVault, type SwapQuote, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { useSwapPageLogic } from '~/composables/useSwapPageLogic'

const { captured, tosContext, useSwapQuotesParallelMock } = vi.hoisted(() => ({
  captured: {
    planAccount: { chainId: 1 },
    swapOptions: null as null | {
      buildTxPlanForQuote: (quote: SwapQuote, provider: string, context: { account?: unknown }) => Promise<TransactionPlan>
      prepareTransactionPlan?: (plan: TransactionPlan, account: unknown, prefetch: unknown) => Promise<unknown>
    },
    selectedQuote: null as unknown as Ref<SwapQuote | null>,
    selectedQuoteCard: null as unknown as Ref<unknown>,
    modalOpen: vi.fn(),
    modalClose: vi.fn(),
    showError: vi.fn(),
    executePlan: vi.fn(),
    executePreparedPlan: vi.fn(),
    prepareTransactionPlan: vi.fn(),
    runSimulation: vi.fn(),
    runPreparedSimulation: vi.fn(),
  },
  tosContext: { version: 0 },
  useSwapQuotesParallelMock: vi.fn(),
}))

vi.mock('#components', () => ({
  OperationReviewModal: {},
  SlippageSettingsModal: {},
}))

vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({
    open: captured.modalOpen,
    close: captured.modalClose,
  }),
}))

vi.mock('~/components/ui/composables/useToast', () => ({
  useToast: () => ({
    error: captured.showError,
  }),
}))

vi.mock('~/utils/sdk-tos', () => ({
  getLiteTosContextVersion: () => tosContext.version,
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
  getCurrentPreparedQuotePlan: (card: { quote?: unknown, plan?: unknown, preparedPlan?: { plan: unknown }, tosContextVersion?: number } | null, quote: unknown) => {
    if (!card?.preparedPlan || card.quote !== quote || card.tosContextVersion !== tosContext.version) return null
    return {
      plan: card.plan ?? card.preparedPlan.plan,
      prepared: card.preparedPlan,
      tosContextVersion: card.tosContextVersion,
    }
  },
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
    tosContext.version = 0
    captured.swapOptions = null
    captured.selectedQuote = ref<SwapQuote | null>(null)
    captured.selectedQuoteCard = ref<unknown>(null)
    captured.prepareTransactionPlan.mockReset()
    captured.prepareTransactionPlan.mockImplementation(async plan => ({ __prepared: true, plan }))
    captured.runSimulation.mockReset()
    captured.runSimulation.mockResolvedValue(true)
    captured.runPreparedSimulation.mockReset()
    captured.runPreparedSimulation.mockResolvedValue(true)
    useSwapQuotesParallelMock.mockImplementation((options) => {
      captured.swapOptions = options
      return {
        sortedQuoteCards: ref([]),
        selectedProvider: ref(null),
        selectedQuote: captured.selectedQuote,
        selectedQuoteCard: captured.selectedQuoteCard,
        effectiveQuote: captured.selectedQuote,
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
    vi.stubGlobal('useSpyMode', () => ({
      isSpyMode: ref(false),
    }))
    vi.stubGlobal('useEulerTx', () => ({
      executePlan: captured.executePlan,
      executePreparedPlan: captured.executePreparedPlan,
      prepareTransactionPlan: captured.prepareTransactionPlan,
      prefetchPluginData: vi.fn(),
    }))
    vi.stubGlobal('usePlanAccount', () => ({
      account: ref(captured.planAccount),
    }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({
      runSimulation: captured.runSimulation,
      runPreparedSimulation: captured.runPreparedSimulation,
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
    vi.stubGlobal('formatSmartAmount', (value: string) => value)
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
    const buildPlan = vi.fn(async (quote?: SwapQuote, context?: { account?: unknown }) => ({ quote, context }) as unknown as TransactionPlan)

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
    const context = { account: captured.planAccount }
    const plan = await captured.swapOptions?.buildTxPlanForQuote(quote, 'provider', context)
    const prefetch = { pyth: { entries: [] } }
    await captured.swapOptions?.prepareTransactionPlan?.(plan!, '0x0000000000000000000000000000000000000007', prefetch)

    expect(buildPlan).toHaveBeenCalledWith(quote, context)
    expect(captured.prepareTransactionPlan).toHaveBeenCalledWith(plan, {
      account: '0x0000000000000000000000000000000000000007',
      prefetch,
    })
    expect(plan).toEqual({ quote, context })
  })

  it('uses the selected quote card prepared plan for review and confirm', async () => {
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
    const buildPlan = vi.fn(async () => ({ type: 'rebuilt' }) as unknown as TransactionPlan)
    const quote = { amountIn: '100', amountOut: '200' } as SwapQuote
    const prepared = {
      __prepared: true,
      plan: [{ type: 'evcBatch', items: [] }],
      chainId: 1,
      account: '0x0000000000000000000000000000000000000007',
    }

    captured.selectedQuote.value = quote
    captured.selectedQuoteCard.value = {
      provider: 'provider',
      quote,
      plan: { type: 'quote-plan' },
      preparedPlan: prepared,
      tosContextVersion: 0,
    }

    const swap = useSwapPageLogic({
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

    await swap.submit()

    expect(buildPlan).not.toHaveBeenCalled()
    expect(captured.prepareTransactionPlan).not.toHaveBeenCalled()
    expect(captured.runPreparedSimulation).toHaveBeenCalledWith(prepared, {})
    expect(captured.modalOpen).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      props: expect.objectContaining({
        prepared,
        plan: undefined,
      }),
    }))

    const modalArgs = captured.modalOpen.mock.calls.at(-1)?.[1]
    await modalArgs.props.onConfirm()

    expect(captured.executePreparedPlan).toHaveBeenCalledWith(prepared)
    expect(captured.executePlan).not.toHaveBeenCalled()
  })

  it('re-prepares a cached quote after TOS acceptance changes', async () => {
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
    const rawPlan = [{ type: 'evcBatch', items: [] }] as TransactionPlan
    const oldPrepared = { __prepared: true, plan: rawPlan, chainId: 1, account: '0x0000000000000000000000000000000000000007' }
    const freshPrepared = { ...oldPrepared, fresh: true }
    const buildPlan = vi.fn(async () => rawPlan)
    const quote = { amountIn: '100', amountOut: '200' } as SwapQuote
    captured.prepareTransactionPlan.mockResolvedValueOnce(freshPrepared)
    captured.selectedQuote.value = quote
    captured.selectedQuoteCard.value = {
      provider: 'provider',
      quote,
      plan: rawPlan,
      preparedPlan: oldPrepared,
      tosContextVersion: 0,
    }
    tosContext.version = 1

    const swap = useSwapPageLogic({
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

    await swap.submit()

    expect(buildPlan).toHaveBeenCalledTimes(1)
    expect(captured.prepareTransactionPlan).toHaveBeenCalledWith(rawPlan, { account: captured.planAccount })
    expect(captured.runPreparedSimulation).toHaveBeenCalledWith(freshPrepared, {})
  })

  it('prepares a rebuilt plan once and reuses it for confirm when no quote prepared plan is available', async () => {
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
    const rawPlan = { type: 'raw-plan' } as unknown as TransactionPlan
    const prepared = { __prepared: true, plan: rawPlan, chainId: 1, account: '0x0000000000000000000000000000000000000007' }
    const buildPlan = vi.fn(async () => rawPlan)
    captured.prepareTransactionPlan.mockResolvedValueOnce(prepared)
    captured.selectedQuote.value = { amountIn: '100', amountOut: '200' } as SwapQuote
    captured.selectedQuoteCard.value = null

    const swap = useSwapPageLogic({
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

    await swap.submit()
    const modalArgs = captured.modalOpen.mock.calls.at(-1)?.[1]
    await modalArgs.props.onConfirm()

    expect(buildPlan).toHaveBeenCalledTimes(1)
    expect(captured.prepareTransactionPlan).toHaveBeenCalledTimes(1)
    expect(buildPlan).toHaveBeenCalledWith(undefined, { account: captured.planAccount })
    expect(captured.prepareTransactionPlan).toHaveBeenCalledWith(rawPlan, { account: captured.planAccount })
    expect(captured.runPreparedSimulation).toHaveBeenCalledWith(prepared, {})
    expect(captured.executePreparedPlan).toHaveBeenCalledWith(prepared)
    expect(captured.executePlan).not.toHaveBeenCalled()
  })
})
