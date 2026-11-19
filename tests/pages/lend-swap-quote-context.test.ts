import { computed, createSSRApp, effectScope, nextTick, ref, ssrContextKey, type Ref } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { getAddress, type Address } from 'viem'
import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LendPage from '~/pages/lend/[vault]/index.vue'
import { useEffectiveAddress } from '~/composables/useEffectiveAddress'
import { useOperationIntentFactory } from '~/composables/useOperationIntentFactory'
import type { SwapQuoteInput } from '~/composables/useSwapApi'
import { validateIntentSet } from '~/features/reviewed-execution/domain/validators'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { valueToNano } from '~/utils/crypto-utils'
import { makeSwapQuote } from '../reviewed-execution/swap-quote.test-fixture'

const A = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
const B = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
const VAULT = getAddress('0x3000000000000000000000000000000000000000')
const USDC = { address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), symbol: 'USDC', name: 'USD Coin', decimals: 6 }
const WETH = { address: getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }
const vault = { address: VAULT, asset: WETH, shares: { name: 'Vault' }, collaterals: [] }
const mocks = vi.hoisted(() => ({ openReview: vi.fn(), addBatchEntry: vi.fn(), planDepositWithSwap: vi.fn() }))

vi.mock('#components', () => ({ VaultApyModal: {}, SwapTokenSelector: {}, SlippageSettingsModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: vi.fn() }) }))
vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('~/utils/vault/categories', () => ({ isSecuritizeVault: async () => false }))
vi.mock('~/utils/sdk-prices', () => ({ getAssetOraclePrice: () => ({ amountOutMid: 1n }), getTokenUsdPrice: async () => 1, getTokenUsdValue: async () => 1 }))
vi.mock('~/utils/vault/apy', () => ({ getProjectedRates: async () => null }))
vi.mock('~/composables/useEulerLabels', () => ({ useEulerProductOfVault: () => ({ name: 'Vault' }) }))
vi.mock('~/composables/useLayeredVaults', () => ({ getLayeredVault: (_address: string, fallback: unknown) => fallback }))
vi.mock('~/composables/useGeoBlock', () => ({
  getVaultGeoUnavailableReason: () => null,
  isVaultBlockedByCountry: () => false,
  isVaultRestrictedByCountry: () => false,
  isAssetBlockedByCountry: () => false,
}))
vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => ({ get: () => ({ type: 'evk', vault }), has: () => true }) }))
vi.mock('~/composables/useStateOverrideOptions', () => ({ useStateOverrideOptions: () => ({ primeSlotHintsFor: vi.fn(), buildStateOverrideOptions: () => ({}) }) }))
vi.mock('~/composables/useSwapPriceImpact', () => ({ useSwapPriceImpact: () => ({ priceImpact: ref(0) }) }))
vi.mock('~/composables/usePriceImpactGate', () => ({ usePriceImpactGate: () => ({ guardWithPriceImpact: async (run: () => Promise<void>) => run() }) }))
vi.mock('~/utils/client-observability', () => ({ reportClientEvent: vi.fn() }))

interface PageState {
  amount: Ref<string>
  swapSlippage: Ref<number>
  selectedAsset: Ref<typeof USDC | typeof WETH | undefined>
  swapEffectiveQuote: Ref<SwapQuote | null>
  swapQuoteCardsSorted: Ref<{ quote: SwapQuote }[]>
  reviewSupplyDisabled: Ref<boolean>
  canAddToBatch: Ref<boolean>
  requestSwapQuote: () => Promise<void>
  selectSwapQuote: (provider: string) => void
  submit: () => Promise<void>
  addToBatch: () => Promise<void>
}

const quoteFor = (request: SwapQuoteInput): SwapQuote => ({
  ...makeSwapQuote(),
  amountIn: request.amount.toString(),
  amountInMax: request.amount.toString(),
  accountIn: request.accountIn,
  accountOut: request.accountOut,
  vaultIn: request.vaultIn,
  receiver: request.receiver,
  tokenIn: { ...USDC, chainId: request.chainId ?? 1, logoURI: '' },
  tokenOut: { ...WETH, chainId: request.chainId ?? 1, logoURI: '' },
  verify: { ...makeSwapQuote().verify, account: request.accountOut, vault: request.receiver },
})

describe('Lend swap quote account context', () => {
  let scope: ReturnType<typeof effectScope>
  let address: Ref<Address | undefined>
  let isSpyMode: Ref<boolean>
  let spyAddress: Ref<Address>
  let chainId: Ref<number>
  let getSwapQuotes: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    scope = effectScope()
    address = ref(B)
    isSpyMode = ref(true)
    spyAddress = ref(A)
    chainId = ref(1)
    getSwapQuotes = vi.fn(async (request: SwapQuoteInput) => [quoteFor(request)])
    mocks.openReview.mockReset()
    mocks.addBatchEntry.mockReset()
    mocks.planDepositWithSwap.mockReset().mockResolvedValue([])
    vi.stubGlobal('useWagmi', () => ({ address, isConnected: computed(() => !!address.value), chainId, chain: ref({ nativeCurrency: { decimals: 18 } }) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode, spyAddress }))
    vi.stubGlobal('useEffectiveAddress', useEffectiveAddress)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref(null) }))
    vi.stubGlobal('usePlanAccount', () => ({ account: computed(() => ({ owner: isSpyMode.value ? spyAddress.value : address.value })) }))
    vi.stubGlobal('useSwapApi', () => ({ getSwapProviders: async () => ['router'], getSwapQuotes }))
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('useRoute', () => ({ params: { vault: VAULT }, query: {}, name: 'lend-vault' }))
    vi.stubGlobal('useFullBalances', vi.fn())
    vi.stubGlobal('useOperationGuard', vi.fn())
    vi.stubGlobal('useVaultOpeningNotice', vi.fn())
    vi.stubGlobal('useVaultAssessmentWarning', () => ({ warning: ref(null) }))
    vi.stubGlobal('useEulerLabels', () => ({ isReady: ref(true) }))
    vi.stubGlobal('useVaults', () => ({ isMarketDataResolved: ref(true) }))
    vi.stubGlobal('useWallets', () => ({ getBalance: () => 10_000_000_000n }))
    vi.stubGlobal('useEulerTx', () => ({ planDepositWithSwap: mocks.planDepositWithSwap, prepareTransactionPlan: async () => ({ plan: [] }) }))
    vi.stubGlobal('useOperationIntentFactory', useOperationIntentFactory)
    vi.stubGlobal('useExecutionReview', () => ({
      capture: (intents: readonly OperationIntent[]) => ({
        intents,
        open: async () => {
          validateIntentSet(intents)
          mocks.openReview(intents)
        },
      }),
    }))
    vi.stubGlobal('useTxBatch', () => ({ addEntry: mocks.addBatchEntry }))
    vi.stubGlobal('useBatchRedirect', () => ({ redirectAfterAdd: vi.fn() }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({ runPreparedSimulation: async () => true, simulationError: ref(null), clearSimulationError: vi.fn() }))
    vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false }) }))
    vi.stubGlobal('useRewardsApy', () => ({ version: ref(0), getSupplyRewardApy: () => 0, hasSupplyRewards: () => false, getSupplyRewardCampaigns: () => [] }))
    vi.stubGlobal('useSlippage', () => ({ slippage: ref(0.5) }))
    vi.stubGlobal('useDebounceFn', useDebounceFn)
    vi.stubGlobal('valueToNano', valueToNano)
    vi.stubGlobal('getVaultSupplyApy', () => 0)
    vi.stubGlobal('getIsSupplyCapReached', () => false)
    vi.stubGlobal('logWarn', vi.fn())
    vi.stubGlobal('showError', vi.fn())
  })

  afterEach(() => {
    scope.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const openPage = async () => {
    const app = createSSRApp({})
    app.provide(ssrContextKey, {})
    const component = LendPage as unknown as { setup: (props: object, context: object) => PageState }
    const page = scope.run(() => app.runWithContext(() => component.setup({}, { expose: vi.fn() })))!
    await vi.advanceTimersByTimeAsync(0)
    page.selectedAsset.value = USDC
    page.amount.value = '100'
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)
    return page
  }

  it('clears a selected A quote synchronously on spy exit with B already connected', async () => {
    const page = await openPage()
    page.selectSwapQuote('router')
    expect(page.swapEffectiveQuote.value?.accountOut).toBe(A)
    expect(page.reviewSupplyDisabled.value).toBe(false)

    isSpyMode.value = false

    expect(page.swapEffectiveQuote.value).toBeNull()
    expect(page.reviewSupplyDisabled.value).toBe(true)
    expect(page.canAddToBatch.value).toBe(false)
    await page.submit()
    await page.addToBatch()
    expect(mocks.openReview).not.toHaveBeenCalled()
    expect(mocks.addBatchEntry).not.toHaveBeenCalled()
    expect(mocks.planDepositWithSwap).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)
    expect(getSwapQuotes).toHaveBeenLastCalledWith(expect.objectContaining({ accountOut: B, unusedInputReceiver: B }), expect.anything())
    expect(page.swapEffectiveQuote.value?.accountOut).toBe(B)
    page.selectSwapQuote('router')
    await page.submit()
    expect(mocks.openReview).toHaveBeenCalledOnce()
    expect(mocks.planDepositWithSwap).toHaveBeenCalledWith(expect.objectContaining({ swapQuote: expect.objectContaining({ accountOut: B }), account: expect.objectContaining({ owner: B }) }))
  })

  it('drops an A response that arrives after spy exit even before the B request starts', async () => {
    let release!: (quotes: SwapQuote[]) => void
    let request!: SwapQuoteInput
    getSwapQuotes.mockImplementationOnce((params: SwapQuoteInput) => {
      request = params
      return new Promise<SwapQuote[]>((resolve) => {
        release = resolve
      })
    })
    const page = await openPage()
    isSpyMode.value = false
    release([quoteFor(request)])
    await vi.advanceTimersByTimeAsync(0)
    expect(page.swapEffectiveQuote.value).toBeNull()
    expect(page.swapQuoteCardsSorted.value).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(page.swapEffectiveQuote.value?.accountOut).toBe(B)
  })

  it('keeps an ordinary B-only quote usable', async () => {
    isSpyMode.value = false
    const page = await openPage()
    page.selectSwapQuote('router')
    await page.submit()
    expect(mocks.openReview).toHaveBeenCalledWith([expect.objectContaining({ account: B })])
  })

  it.each(['wallet', 'chain', 'spy address', 'amount', 'slippage', 'token', 'same-address spy exit'] as const)('invalidates immediately on %s change', async (change) => {
    if (change === 'same-address spy exit') spyAddress.value = B
    const page = await openPage()
    page.selectSwapQuote('router')
    expect(page.swapEffectiveQuote.value).not.toBeNull()
    if (change === 'wallet') address.value = undefined
    if (change === 'chain') chainId.value = 8453
    if (change === 'spy address') spyAddress.value = B
    if (change === 'amount') page.amount.value = '101'
    if (change === 'slippage') page.swapSlippage.value = 1
    if (change === 'token') page.selectedAsset.value = WETH
    if (change === 'same-address spy exit') isSpyMode.value = false
    expect(page.swapEffectiveQuote.value).toBeNull()
  })
})
