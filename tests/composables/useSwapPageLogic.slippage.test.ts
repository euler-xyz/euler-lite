import { computed, effectScope, nextTick, ref, shallowRef } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { getAddress, type Address } from 'viem'
import { SwapperMode, type EVault, type SwapQuote, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSwapPageLogic } from '~/composables/useSwapPageLogic'
import { useExecutionReview } from '~/composables/useExecutionReview'
import type { SwapQuoteInput } from '~/composables/useSwapApi'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { valueToNano } from '~/utils/crypto-utils'
import { makeSwapQuote } from '../reviewed-execution/swap-quote.test-fixture'

vi.mock('#components', () => ({ SlippageSettingsModal: {}, OperationReviewModal: {}, ReviewedOperationModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: vi.fn() }) }))
vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('~/composables/usePriceImpactGate', () => ({ usePriceImpactGate: () => ({ guardWithPriceImpact: async (run: () => Promise<void>) => run() }) }))
vi.mock('~/composables/useEulerLabels', () => ({ useEulerProductOfVault: () => ({ name: 'Vault' }) }))
vi.mock('~/composables/useGeoBlock', () => ({
  getVaultTags: () => ({ disabled: false }), isAnyVaultBlockedByCountry: () => false, useGeoBlock: () => ({ country: ref('PL') }),
}))
vi.mock('~/composables/useStateOverrideOptions', () => ({ useStateOverrideOptions: () => ({ primeSlotHintsFor: vi.fn(), buildStateOverrideOptions: () => ({}) }) }))
vi.mock('~/utils/sdk-prices', () => ({ getAssetUsdValue: async () => 1, getTokenUsdValue: async () => 1 }))
vi.mock('~/composables/useEulerSdk', () => ({ getEulerSdkFresh: async () => ({ executionService: { estimateGasForPreparedTransactionPlan: async () => 100_000n } }) }))
vi.mock('~/utils/operationGuardRegistry', () => ({ isOperationBlocked: ref(false) }))

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const USDC = { address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), symbol: 'USDC', name: 'USD Coin', decimals: 6 }
const WBTC = { address: getAddress('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'), symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8 }
const makeVault = (address: Address, asset: typeof USDC) => ({ address, asset, shares: { decimals: asset.decimals } }) as EVault
const source = makeVault('0x3000000000000000000000000000000000000000', USDC)
const target = makeVault('0x4000000000000000000000000000000000000000', WBTC)

const quoteFor = (request: SwapQuoteInput): SwapQuote => {
  const amountOut = 100_000_000n
  const amountOutMin = amountOut * BigInt(10_000 - Math.round(request.slippage * 100)) / 10_000n
  return {
    ...makeSwapQuote(), amountIn: request.amount.toString(), amountInMax: request.amount.toString(),
    amountOut: amountOut.toString(), amountOutMin: amountOutMin.toString(), slippage: request.slippage,
    accountIn: ACCOUNT, accountOut: ACCOUNT, vaultIn: request.vaultIn, receiver: request.receiver,
    tokenIn: { ...USDC, chainId: 1, logoURI: '' }, tokenOut: { ...WBTC, chainId: 1, logoURI: '' },
    verify: { ...makeSwapQuote().verify, account: ACCOUNT, vault: request.receiver, amount: amountOutMin.toString() },
  }
}

describe('swap page slippage refresh', () => {
  let scope: ReturnType<typeof effectScope>
  let getSwapQuotes: ReturnType<typeof vi.fn>
  let reviewPrepare: ReturnType<typeof vi.fn>
  let buildPlan: ReturnType<typeof vi.fn<() => Promise<TransactionPlan>>>

  beforeEach(() => {
    vi.useFakeTimers()
    scope = effectScope()
    getSwapQuotes = vi.fn(async (request: SwapQuoteInput) => [quoteFor(request)])
    buildPlan = vi.fn(async (): Promise<TransactionPlan> => [])
    reviewPrepare = vi.fn(async () => ({
      prepared: { plan: [] },
      execution: {
        reviewId: '0x01', reviewDigest: '0x02',
        requestSet: { wallet: { account: ACCOUNT, walletKind: 'eoa' }, requests: [], signatureSlots: [] },
      },
    }))
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('useRoute', () => ({ query: {} }))
    vi.stubGlobal('useWagmi', () => ({ address: ref(ACCOUNT), isConnected: ref(true), chain: ref({ nativeCurrency: { decimals: 18 } }) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false), spyAddress: ref(null) }))
    vi.stubGlobal('useEffectiveAddress', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('usePlanAccount', () => ({ account: ref({ chainId: 1, owner: ACCOUNT }) }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref({
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      getBlock: async () => ({ baseFeePerGas: 1n }),
    }) }))
    vi.stubGlobal('useSwapApi', () => ({ getSwapProviders: async () => ['router'], getSwapQuotes }))
    vi.stubGlobal('useEulerTx', () => ({
      prefetchPluginData: async () => undefined,
      prepareTransactionPlan: async (plan: TransactionPlan) => ({ __prepared: true, plan, chainId: 1, account: ACCOUNT }),
    }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({
      runPreparedSimulation: async () => true, simulationError: ref(null), clearSimulationError: vi.fn(),
    }))
    vi.stubGlobal('useExecutionReview', useExecutionReview)
    vi.stubGlobal('useReviewedExecution', () => ({ prepare: reviewPrepare }))
    vi.stubGlobal('useSlippage', () => ({ slippage: ref(5) }))
    vi.stubGlobal('usePriceInvert', () => ({}))
    vi.stubGlobal('useDebounceFn', useDebounceFn)
    vi.stubGlobal('valueToNano', valueToNano)
    vi.stubGlobal('formatSmartAmount', (value: string) => value)
  })

  afterEach(() => {
    scope.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const openSwap = async (sameAsset = false) => {
    const toVault = shallowRef(sameAsset ? makeVault(target.address, USDC) : target)
    const swap = scope.run(() => useSwapPageLogic({
      amountField: 'amountOut', compare: 'max', fromVault: shallowRef(source), toVault,
      balance: computed(() => 1_000_000_000n), vaultOptions: computed(() => [toVault.value]),
      displayAmountField: 'amountOut', quoteDiffPrefix: '-', redirectPath: '/portfolio/saving',
      swapperMode: SwapperMode.EXACT_IN, buildPlan,
      buildQuoteRequest: amount => ({ params: {
        tokenIn: USDC.address, tokenOut: toVault.value.asset.address, amount,
        accountIn: ACCOUNT, accountOut: ACCOUNT, vaultIn: source.address, receiver: toVault.value.address,
        slippage: swap.slippage.value, swapperMode: SwapperMode.EXACT_IN, isRepay: false, targetDebt: 0n, currentDebt: 0n,
      } }),
      createReviewIntent: quote => createOperationIntent({
        kind: quote ? 'collateral' : 'refinance', planner: quote ? 'swap-collateral' : 'migrate-same-asset-collateral',
        args: quote
          ? { swapQuote: quote, swapperMode: SwapperMode.EXACT_IN }
          : { fromVault: source.address, toVault: toVault.value.address, amount: 100_000_000n, positionAccount: ACCOUNT, toAsset: USDC.address },
        account: ACCOUNT, chainId: 1, subAccounts: [ACCOUNT], source: 'lend/swap:review',
      }),
      getBalanceError: () => null, getGeoBlockedAddresses: () => [],
    }))!
    swap.fromAmount.value = '100'
    swap.onFromInput()
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)
    return swap
  }

  it.each([219, 499])('blocks stale prepared quotes %d ms after tightening slippage, then reviews a fresh quote', async (delay) => {
    const swap = await openSwap()
    swap.selectProvider('router')
    await nextTick()
    expect(swap.reviewSwapDisabled.value).toBe(false)
    expect(swap.selectedQuote.value?.slippage).toBe(5)
    expect(swap.quoteCardsSorted.value[0]?.preparedPlan).toBeDefined()
    const buildsBeforeChange = buildPlan.mock.calls.length

    swap.slippage.value = 0.1

    expect(swap.selectedQuote.value).toBeNull()
    expect(swap.quoteCardsSorted.value).toEqual([])
    expect(swap.toAmount.value).toBe('')
    expect(swap.reviewSwapDisabled.value).toBe(true)
    await swap.submit()
    await vi.advanceTimersByTimeAsync(delay)
    await swap.submit()
    expect(getSwapQuotes).toHaveBeenCalledTimes(1)
    expect(buildPlan).toHaveBeenCalledTimes(buildsBeforeChange)
    expect(reviewPrepare).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500 - delay)
    expect(getSwapQuotes).toHaveBeenLastCalledWith(expect.objectContaining({ slippage: 0.1 }), expect.anything())
    swap.selectProvider('router')
    await nextTick()
    expect(swap.reviewSwapDisabled.value).toBe(false)
    await swap.submit()
    expect(reviewPrepare).toHaveBeenCalledOnce()
    expect(reviewPrepare.mock.calls[0][0][0].planner.args.swapQuote).toMatchObject({
      slippageBps: 10, amountOutMin: 99_900_000n, verify: { amount: 99_900_000n },
    })
  })

  it('discards an in-flight response before the replacement request starts', async () => {
    let release!: (quotes: SwapQuote[]) => void
    let request!: SwapQuoteInput
    getSwapQuotes.mockImplementationOnce((params: SwapQuoteInput) => {
      request = params
      return new Promise<SwapQuote[]>((resolve) => {
        release = resolve
      })
    })
    const swap = await openSwap()
    const signal = getSwapQuotes.mock.calls[0][1].signal as AbortSignal
    swap.slippage.value = 0.1
    expect(signal.aborted).toBe(true)
    release([quoteFor(request)])
    await vi.advanceTimersByTimeAsync(219)
    expect(swap.quoteCardsSorted.value).toEqual([])
    expect(swap.selectedQuote.value).toBeNull()
    expect(swap.reviewSwapDisabled.value).toBe(true)
    await swap.submit()
    expect(reviewPrepare).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(281)
    expect(swap.quoteCardsSorted.value[0]?.quote.slippage).toBe(0.1)
  })

  it('honours disabled form validation when submit is called directly', async () => {
    const swap = await openSwap()
    swap.selectProvider('router')
    await nextTick()
    swap.isQuoteLoading.value = true
    expect(swap.reviewSwapDisabled.value).toBe(true)
    await swap.submit()
    expect(reviewPrepare).not.toHaveBeenCalled()
  })

  it('preserves same-asset transfer amounts and review after a slippage change', async () => {
    const swap = await openSwap(true)
    expect(swap.toAmount.value).toBe('100')
    swap.slippage.value = 0.1
    expect(swap.toAmount.value).toBe('100')
    await vi.advanceTimersByTimeAsync(500)
    expect(getSwapQuotes).not.toHaveBeenCalled()
    expect(swap.reviewSwapDisabled.value).toBe(false)
    await swap.submit()
    expect(reviewPrepare).toHaveBeenCalledOnce()
  })
})
