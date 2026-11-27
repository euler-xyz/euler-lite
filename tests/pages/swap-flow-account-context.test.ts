import { computed, createSSRApp, effectScope, getCurrentScope, nextTick, ref, ssrContextKey, type Ref } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { getAddress, zeroAddress, type Address } from 'viem'
import { getSubAccountAddress, SwapperMode, VaultType, type EVault, type SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WithdrawPage from '~/pages/lend/[vault]/[subAccount]/withdraw.vue'
import SwapPage from '~/pages/lend/[vault]/[subAccount]/swap.vue'
import MultiplyPage from '~/pages/position/[number]/multiply.vue'
import BorrowPage from '~/pages/borrow/[collateral]/[borrow]/index.vue'
import { useBorrowForm } from '~/composables/borrow/useBorrowForm'
import { useMultiplyForm } from '~/composables/borrow/useMultiplyForm'
import { useCollateralForm } from '~/composables/position/useCollateralForm'
import { useEffectiveAddress } from '~/composables/useEffectiveAddress'
import type { SwapQuoteInput } from '~/composables/useSwapApi'
import { FixedPoint } from '~/utils/fixed-point'
import { valueToNano } from '~/utils/crypto-utils'
import { makeSwapQuote } from '../reviewed-execution/swap-quote.test-fixture'

const A = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
const B = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
const USDC = { address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), symbol: 'USDC', name: 'USD Coin', decimals: 6 }
const WETH = { address: getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }
const makeVault = (address: Address, asset: typeof USDC) => ({
  address, asset, type: VaultType.EVault, chainId: 1, shares: { address, symbol: `e${asset.symbol}`, decimals: asset.decimals },
  totalCash: 10n ** 30n, totalBorrowed: 0n, totalAssets: 10n ** 30n, availableLiquidity: 10n ** 30n,
  caps: {}, collaterals: [], convertToShares: (amount: bigint) => amount,
}) as unknown as EVault
const vault = makeVault('0x3000000000000000000000000000000000000000', WETH)
const debtVault = makeVault('0x4000000000000000000000000000000000000000', USDC)
const mocks = vi.hoisted(() => ({
  getNewSubAccount: vi.fn(),
  planMultiply: vi.fn(async () => []),
  prepareTransactionPlan: vi.fn(async () => ({ plan: [] })),
  prefetchPluginData: vi.fn(async () => undefined),
  runPreparedSimulation: vi.fn(async () => true),
  prepareReview: vi.fn(async () => undefined),
  openReview: vi.fn(async (..._args: unknown[]) => undefined),
  createIntent: vi.fn((..._args: unknown[]) => ({})),
}))

vi.mock('#components', () => ({ SwapTokenSelector: {}, SlippageSettingsModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: vi.fn() }) }))
vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('~/utils/vault/categories', () => ({ isSecuritizeVault: async () => false }))
vi.mock('~/utils/eulerLabelsUtils', () => ({ isVaultDeprecated: () => false }))
vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValue: async () => 1, getAssetUsdValueOrZero: async () => 1, getAssetUsdValueForEstimate: async () => 1,
  getTokenUsdPrice: async () => 1, getTokenUsdValue: async () => 1, getCollateralUsdValueOrZero: async () => 1,
  getAssetOraclePrice: () => ({ amountOutMid: 1n, amountOutAsk: 1n }), getCollateralOraclePrice: () => ({ amountOutMid: 1n }),
  getCollateralShareOraclePrice: () => ({ amountIn: 1n }),
  getCollateralUsdPrice: async () => ({ amountOutMid: 10n ** 18n }), conservativePriceRatio: () => 10n ** 18n,
  conservativePriceRatioNumber: () => 1,
}))
vi.mock('~/utils/vault/apy', () => ({
  getProjectedRates: async () => null, getProjectedRatesBatch: async () => [], areProjectedRatesComplete: () => false,
  getPositionMultiplier: () => 2, getNetAPYFromWeightedSupplySnapshot: () => 0,
}))
vi.mock('~/utils/multiply-math', () => ({ computeLeverageDebt: () => 1_000_000n, computeMaxMultiplier: () => 5, computeMinMultiplier: () => 1 }))
vi.mock('~/composables/useEulerLabels', () => ({ useEulerProductOfVault: () => ({ name: 'Vault' }), getCurrentEulerLabelsData: () => ({}) }))
vi.mock('~/composables/useLayeredVaults', () => ({ getLayeredVault: (_address: string, fallback: unknown) => fallback }))
vi.mock('~/composables/useGeoBlock', () => ({
  getVaultGeoUnavailableReason: () => null, getVaultTags: () => ({ tags: [], disabled: false }), useGeoBlock: () => ({ country: ref('PL') }),
  isAnyVaultBlockedByCountry: () => false, isVaultRestrictedByCountry: () => false,
  isAssetBlockedByCountry: () => false, isAssetRestrictedByCountry: () => false,
}))
vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => ({ getOrFetch: async () => vault }) }))
vi.mock('~/composables/useStateOverrideOptions', () => ({ useStateOverrideOptions: () => ({ primeSlotHintsFor: vi.fn(), buildStateOverrideOptions: () => ({}) }) }))
vi.mock('~/composables/useSwapPriceImpact', () => ({ useSwapPriceImpact: () => ({ priceImpact: ref(0) }) }))
vi.mock('~/composables/usePriceImpactGate', () => ({ usePriceImpactGate: () => ({ guardWithPriceImpact: async (run: () => Promise<void>) => run() }) }))
vi.mock('~/composables/useSwapCollateralOptions', () => ({ useSwapCollateralOptions: () => ({ collateralOptions: ref([]), collateralVaults: ref([debtVault]) }) }))
vi.mock('~/composables/useMultiplyCollateralOptions', () => ({ useMultiplyCollateralOptions: () => ({ collateralOptions: ref([]), collateralVaults: ref([vault]) }) }))
vi.mock('~/composables/borrow/useMultiplyCowSwap', () => ({ useMultiplyCowSwap: () => ({}) }))
vi.mock('~/composables/useSubAccounts', () => ({ getNewSubAccount: mocks.getNewSubAccount }))
vi.mock('~/utils/client-observability', () => ({ reportClientEvent: vi.fn() }))

type Flow = 'lend withdraw' | 'lend swap' | 'position supply' | 'position withdraw' | 'borrow' | 'multiply' | 'position multiply'
const flows: Flow[] = ['lend withdraw', 'lend swap', 'position supply', 'position withdraw', 'borrow', 'multiply', 'position multiply']
interface FlowState {
  quote: Ref<SwapQuote | null>
  select: (provider: string) => void
  request: () => unknown
  submitDisabled?: Ref<boolean>
  submit?: () => Promise<void>
}
const quoteFor = (request: SwapQuoteInput): SwapQuote => ({
  ...makeSwapQuote(), amountIn: request.amount.toString(), amountInMax: request.amount.toString(),
  accountIn: request.accountIn, accountOut: request.accountOut, vaultIn: request.vaultIn, receiver: request.receiver,
  tokenIn: { ...USDC, address: request.tokenIn, chainId: request.chainId ?? 1, logoURI: '' },
  tokenOut: { ...WETH, address: request.tokenOut, chainId: request.chainId ?? 1, logoURI: '' },
  verify: { ...makeSwapQuote().verify, account: request.accountOut, vault: request.receiver },
})

describe('swap flow account context', () => {
  let scope: ReturnType<typeof effectScope>
  let address: Ref<Address | undefined>
  let isSpyMode: Ref<boolean>
  let spyAddress: Ref<Address>
  let chainId: Ref<number>
  let slippage: Ref<number>
  let positionAvailable: Ref<boolean>
  let getSwapQuotes: ReturnType<typeof vi.fn>
  let resolveSubAccount: ReturnType<typeof vi.fn<() => Promise<Address>>>
  let preloadSubAccount: ReturnType<typeof vi.fn>
  const owner = () => isSpyMode.value ? spyAddress.value : address.value!
  const subAccount = () => getSubAccountAddress(owner(), 1)

  beforeEach(() => {
    vi.useFakeTimers()
    scope = effectScope()
    address = ref(B)
    isSpyMode = ref(true)
    spyAddress = ref(A)
    chainId = ref(1)
    slippage = ref(0.5)
    positionAvailable = ref(true)
    getSwapQuotes = vi.fn(async (request: SwapQuoteInput) => [quoteFor(request)])
    resolveSubAccount = vi.fn(async () => subAccount())
    preloadSubAccount = vi.fn(async () => undefined)
    mocks.getNewSubAccount.mockReset().mockImplementation(async (owner: Address) => getSubAccountAddress(owner, 1))
    mocks.planMultiply.mockReset().mockResolvedValue([])
    mocks.prepareTransactionPlan.mockReset().mockResolvedValue({ plan: [] })
    mocks.prefetchPluginData.mockReset().mockResolvedValue(undefined)
    mocks.runPreparedSimulation.mockReset().mockResolvedValue(true)
    mocks.prepareReview.mockReset().mockResolvedValue(undefined)
    mocks.openReview.mockReset().mockResolvedValue(undefined)
    mocks.createIntent.mockReset().mockReturnValue({})
    const account = computed(() => ({
      owner: owner(), chainId: chainId.value,
      getSubAccount: () => ({ enabledCollaterals: [], positions: [{ vaultAddress: vault.address, assets: 10n ** 25n, shares: 10n ** 25n }] }),
      getPosition: () => ({ assets: 10n ** 25n, shares: 10n ** 25n }), isCollateralEnabled: () => true,
    }))
    vi.stubGlobal('useWagmi', () => ({ address, isConnected: computed(() => !!address.value), chainId, chain: ref({ nativeCurrency: { decimals: 18 } }) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode, spyAddress }))
    vi.stubGlobal('useEffectiveAddress', useEffectiveAddress)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId, isReady: ref(true), loadEulerConfig: vi.fn() }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref(null) }))
    vi.stubGlobal('usePlanAccount', () => ({ account }))
    vi.stubGlobal('useFreshAccount', () => ({ account }))
    vi.stubGlobal('useSwapApi', () => ({ getSwapProviders: async () => ['router'], getSwapQuotes }))
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('useRoute', () => ({ params: { vault: vault.address, subAccount: '1' }, query: { to: debtVault.address } }))
    vi.stubGlobal('usePositionIndex', () => '1')
    vi.stubGlobal('usePositionPairLabel', () => ref('WETH/USDC'))
    vi.stubGlobal('useSwapPriceImpact', () => ({ priceImpact: ref(0) }))
    vi.stubGlobal('useTokenList', () => ({ getTokenCategoryTags: () => [] }))
    vi.stubGlobal('useEulerAccount', () => ({
      isPositionsLoaded: ref(true), depositPositions: ref([]),
      getPositionBySubAccountIndex: () => positionAvailable.value
        ? ({
            subAccount: subAccount(), collateralVault: vault, borrowVault: debtVault,
            collateralVaults: [vault.address], supplied: 10n ** 25n, borrowed: 1n, collaterals: [], userLTV: 500000000000000000n,
          })
        : undefined,
      getNewSubAccount: resolveSubAccount,
    }))
    vi.stubGlobal('useFullBalances', vi.fn())
    vi.stubGlobal('useOperationGuard', vi.fn())
    vi.stubGlobal('useVaultOpeningNotice', vi.fn())
    vi.stubGlobal('useVaultAssessmentWarning', () => ({ warning: ref(null) }))
    vi.stubGlobal('onUnmounted', vi.fn())
    vi.stubGlobal('useVaults', () => ({ isReady: ref(true), isMarketDataResolved: ref(true), getVault: async (a: string) => a === vault.address ? vault : debtVault }))
    vi.stubGlobal('useWallets', () => ({ getBalance: () => 10n ** 25n, fetchSingleBalance: async () => 10n ** 25n }))
    vi.stubGlobal('useEulerTx', () => ({
      planMultiply: mocks.planMultiply,
      prepareTransactionPlan: mocks.prepareTransactionPlan,
      prefetchPluginData: mocks.prefetchPluginData,
      preloadSubAccountSnapshot: preloadSubAccount,
    }))
    vi.stubGlobal('useOperationIntentFactory', () => ({ create: mocks.createIntent, capture: () => mocks.createIntent }))
    vi.stubGlobal('useExecutionReview', () => ({
      capture: (currentIntents: readonly unknown[], options: unknown, preparedIntents?: readonly unknown[]) => ({
        intents: preparedIntents ?? currentIntents,
        usesPreparedIntents: preparedIntents !== undefined,
        open: async (isCurrent?: () => boolean) => {
          await mocks.prepareReview()
          if (isCurrent?.() === false) return
          return mocks.openReview(preparedIntents ?? currentIntents, options)
        },
      }),
    }))
    vi.stubGlobal('useTxBatch', () => ({ entryCount: ref(0), addEntry: vi.fn() }))
    vi.stubGlobal('useBatchRedirect', () => ({ redirectAfterAdd: vi.fn() }))
    vi.stubGlobal('useTxFinalization', () => ({ finalizeExecutionUi: vi.fn() }))
    vi.stubGlobal('useCowSwapEligibility', () => ({ cowSwapForcedOff: ref(true) }))
    vi.stubGlobal('usePositionCollateralApy', () => ({ getCollateralApySnapshot: async () => ({ supplyUsd: 0, weightedSupplyApy: 0 }) }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({
      runPreparedSimulation: mocks.runPreparedSimulation,
      simulationError: ref(null),
      clearSimulationError: vi.fn(),
    }))
    vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false }) }))
    vi.stubGlobal('useRewardsApy', () => ({
      version: ref(0), getSupplyRewardApy: () => 0, getSupplyRewardCampaigns: () => [],
      getBorrowRewardApyForCollaterals: () => 0, getBorrowRewardCampaignsForCollaterals: () => [],
      getEligibleLoopingRewardApyForCollaterals: () => 0, getEligibleLoopingRewardCampaignsForCollaterals: () => [],
    }))
    vi.stubGlobal('useSlippage', () => ({ slippage }))
    vi.stubGlobal('usePriceInvert', () => ({ invertValue: (v: unknown) => v, autoInvert: vi.fn() }))
    vi.stubGlobal('useDebounceFn', useDebounceFn)
    vi.stubGlobal('getCurrentScope', getCurrentScope)
    vi.stubGlobal('until', () => ({ toBe: async () => {} }))
    vi.stubGlobal('valueToNano', valueToNano)
    vi.stubGlobal('formatSmartAmount', (v: string) => v)
    vi.stubGlobal('getVaultSupplyApy', () => 0)
    vi.stubGlobal('getVaultTotalSupplyApy', () => 0)
    vi.stubGlobal('getVaultBorrowApy', () => 0)
    vi.stubGlobal('getIsSupplyCapReached', () => false)
    vi.stubGlobal('getIsBorrowCapReached', () => false)
    vi.stubGlobal('ltvToPercent', () => 80)
    vi.stubGlobal('logWarn', vi.fn())
    vi.stubGlobal('showError', vi.fn())
  })

  afterEach(() => {
    scope.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const openFlow = async (flow: Flow, borrowPendingSubAccount?: Ref<string | null>): Promise<FlowState> => {
    let state!: FlowState
    let setInput!: () => void
    const app = createSSRApp({})
    app.provide(ssrContextKey, {})
    scope.run(() => app.runWithContext(() => {
      if (flow === 'lend withdraw' || flow === 'lend swap') {
        const component = (flow === 'lend withdraw' ? WithdrawPage : SwapPage) as unknown as {
          setup: (props: object, context: object) => {
            amount: Ref<string>
            selectedOutputAsset: Ref<typeof USDC>
            swapEffectiveQuote: Ref<SwapQuote | null>
            selectSwapQuote: FlowState['select']
            requestSwapQuote: FlowState['request']
            fromAmount: Ref<string>
            selectedQuote: Ref<SwapQuote | null>
            selectProvider: FlowState['select']
            onFromInput: FlowState['request']
          }
        }
        const page = component.setup({}, { expose: vi.fn() })
        if (flow === 'lend withdraw') {
          setInput = () => {
            page.selectedOutputAsset.value = USDC
            page.amount.value = '1'
          }
          state = { quote: page.swapEffectiveQuote, select: page.selectSwapQuote, request: page.requestSwapQuote }
        }
        else {
          setInput = () => {
            page.fromAmount.value = '1'
          }
          state = { quote: page.selectedQuote, select: page.selectProvider, request: page.onFromInput }
        }
      }
      else if (flow === 'position multiply') {
        const component = MultiplyPage as unknown as { setup: (props: object, context: object) => {
          multiplier: Ref<number>
          multiplyEffectiveQuote: Ref<SwapQuote | null>
          isMultiplySubmitDisabled: Ref<boolean>
          selectMultiplyQuote: FlowState['select']
          onMultiplierInput: FlowState['request']
          submitMultiply: () => Promise<void>
        } }
        const page = component.setup({}, { expose: vi.fn() })
        setInput = () => {
          page.multiplier.value = 3
        }
        state = {
          quote: page.multiplyEffectiveQuote,
          select: page.selectMultiplyQuote,
          request: page.onMultiplierInput,
          submitDisabled: page.isMultiplySubmitDisabled,
          submit: page.submitMultiply,
        }
      }
      else if (flow === 'position supply' || flow === 'position withdraw') {
        const supply = flow === 'position supply'
        const form = useCollateralForm({
          mode: supply ? 'supply' : 'withdraw', needsSwap: computed(() => true),
          effectiveAsset: computed(() => supply ? USDC : WETH), effectiveBalance: computed(() => 10n ** 25n),
          computePriceFixed: () => FixedPoint.fromValue(10n ** 18n, 18), computeLiquidationPrice: () => undefined, validateEstimate: () => {},
          buildDirectPlan: async () => [], buildSwapPlan: async () => [], createReviewIntent: () => ({}) as never,
          requestSwapQuoteParams: ({ userAddr, subAccountAddr, amountNano, slippage }) => ({
            tokenIn: supply ? USDC.address : WETH.address, tokenOut: supply ? WETH.address : USDC.address,
            accountIn: supply ? zeroAddress : subAccountAddr, accountOut: supply ? subAccountAddr : zeroAddress,
            amount: amountNano, vaultIn: supply ? zeroAddress : vault.address, receiver: supply ? vault.address : userAddr,
            unusedInputReceiver: supply ? userAddr : undefined, transferOutputToReceiver: !supply,
            slippage, swapperMode: SwapperMode.EXACT_IN, isRepay: false, targetDebt: 0n, currentDebt: 0n,
          }),
          getSwapOutputAsset: () => supply ? WETH : USDC,
          reviewLabel: 'Review', reviewType: supply ? 'supply' : 'withdraw', swapReviewType: supply ? 'swap-supply' : 'swap-withdraw',
          getReviewAsset: () => WETH, getSwapToAsset: () => USDC,
        })
        setInput = () => {
          form.amount.value = '1'
        }
        state = { quote: form.swapEffectiveQuote, select: form.selectSwapQuote, request: form.requestSwapQuote }
      }
      else {
        const common = {
          pair: ref({ collateral: vault, borrow: debtVault, ltv: { borrowLTV: 800000000000000000n, liquidationLTV: 850000000000000000n } }) as never,
          borrowVault: computed(() => debtVault), collateralVault: computed(() => vault), formTab: ref<'borrow' | 'multiply'>(flow),
          resolvePendingSubAccount: resolveSubAccount, isGeoBlocked: computed(() => false),
        }
        if (flow === 'borrow') {
          const form = useBorrowForm({
            ...common, savingPositions: computed(() => []), balance: ref(10n ** 25n), pendingSubAccount: borrowPendingSubAccount ?? computed(subAccount),
            collateralSupplyApy: computed(() => 0), borrowApy: computed(() => 0), collateralSupplyRewardApy: computed(() => 0),
            borrowRewardApy: computed(() => 0), collateralSupplyApyWithRewards: computed(() => 0),
            isSecuritizeCollateral: computed(() => false), isBorrowRestricted: computed(() => false), collateralAddress: vault.address, borrowAddress: debtVault.address,
          })
          setInput = () => {
            form.borrowSelectedAsset.value = USDC
            form.collateralAmount.value = '1'
          }
          state = { quote: form.borrowSwapEffectiveQuote, select: form.selectBorrowSwapQuote, request: form.onRefreshBorrowSwapQuotes }
        }
        else {
          const form = useMultiplyForm({ ...common, isPendingSubAccountLoading: ref(false), isMultiplyRestricted: computed(() => false) })
          setInput = () => {
            form.multiplySupplyVault.value = vault
            form.multiplyInputAmount.value = '1'
            form.multiplier.value = 2
          }
          state = {
            quote: form.multiplyEffectiveQuote,
            select: form.selectMultiplyQuote,
            request: form.onMultiplyInput,
            submitDisabled: form.isMultiplySubmitDisabled,
            submit: form.submitMultiply,
          }
        }
      }
    }))
    await vi.advanceTimersByTimeAsync(0)
    setInput()
    state.request()
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)
    state.select('router')
    return state
  }

  const expectOwner = (flow: Flow, quote: SwapQuote | null, expected: Address) => {
    expect(quote).not.toBeNull()
    if (flow.endsWith('withdraw')) expect(quote?.receiver).toBe(expected)
    else expect(quote?.accountOut).toBe(getSubAccountAddress(expected, 1))
  }

  describe.each(flows)('%s', (flow) => {
    it('refreshes on an ordinary connected-wallet switch', async () => {
      isSpyMode.value = false
      const state = await openFlow(flow)
      expectOwner(flow, state.quote.value, B)
      address.value = A
      expect(state.quote.value).toBeNull()
      await vi.advanceTimersByTimeAsync(500)
      state.select('router')
      expectOwner(flow, state.quote.value, A)
    })

    it('clears A synchronously on Spy Mode exit and fetches a fresh B quote', async () => {
      const state = await openFlow(flow)
      expectOwner(flow, state.quote.value, A)
      isSpyMode.value = false
      expect(state.quote.value).toBeNull()
      await vi.advanceTimersByTimeAsync(500)
      state.select('router')
      expectOwner(flow, state.quote.value, B)
      expect(getSwapQuotes).toHaveBeenLastCalledWith(expect.objectContaining({ chainId: 1, origin: B }), expect.anything())
    })

    it('discards an A response arriving during the debounce after Spy Mode exit', async () => {
      let release!: (quotes: SwapQuote[]) => void
      let request!: SwapQuoteInput
      getSwapQuotes.mockImplementationOnce((params: SwapQuoteInput) => {
        request = params
        return new Promise<SwapQuote[]>((resolve) => {
          release = resolve
        })
      })
      const state = await openFlow(flow)
      expect(release).toBeTypeOf('function')
      isSpyMode.value = false
      release([quoteFor(request)])
      await vi.advanceTimersByTimeAsync(0)
      state.select('router')
      expect(state.quote.value).toBeNull()
      await vi.advanceTimersByTimeAsync(500)
      state.select('router')
      expectOwner(flow, state.quote.value, B)
    })

    it.each(['wallet', 'chain', 'spy address', 'same-address spy exit'] as const)('invalidates synchronously on %s changes', async (change) => {
      if (change === 'same-address spy exit') spyAddress.value = B
      const state = await openFlow(flow)
      expect(state.quote.value).not.toBeNull()
      if (change === 'wallet') address.value = undefined
      if (change === 'chain') chainId.value = 8453
      if (change === 'spy address') spyAddress.value = B
      if (change === 'same-address spy exit') isSpyMode.value = false
      expect(state.quote.value).toBeNull()
    })
  })

  it.each(['multiply', 'position multiply'] as const)('%s clears the selected quote before a slippage refetch', async (flow) => {
    const state = await openFlow(flow)
    expect(state.quote.value).not.toBeNull()
    expect(state.submitDisabled?.value).toBe(false)
    const requests = getSwapQuotes.mock.calls.length

    slippage.value = 0.1

    expect(state.quote.value).toBeNull()
    expect(state.submitDisabled?.value).toBe(true)
    expect(getSwapQuotes).toHaveBeenCalledTimes(requests)

    await vi.advanceTimersByTimeAsync(500)
    expect(getSwapQuotes).toHaveBeenCalledTimes(requests + 1)
    expect(getSwapQuotes).toHaveBeenLastCalledWith(expect.objectContaining({ slippage: 0.1 }), expect.anything())
  })

  it.each(['multiply', 'position multiply'] as const)('%s does not open Review after slippage changes during preparation', async (flow) => {
    const state = await openFlow(flow)
    expect(state.quote.value).not.toBeNull()

    let release!: () => void
    if (flow === 'multiply') {
      resolveSubAccount.mockImplementationOnce(() => new Promise<Address>((resolve) => {
        release = () => resolve(subAccount())
      }))
    }
    else {
      mocks.planMultiply.mockImplementationOnce(() => new Promise((resolve) => {
        release = () => resolve([])
      }))
    }

    const submitting = state.submit!()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    slippage.value = 0.1
    release()
    await submitting

    expect(mocks.openReview).not.toHaveBeenCalled()
  })

  it.each(['multiply', 'position multiply'] as const)('%s keeps the slippage guard active during review launch', async (flow) => {
    const state = await openFlow(flow)
    let release!: () => void
    mocks.prepareReview.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve
    }))

    const submitting = state.submit!()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    slippage.value = 0.1
    release()
    await submitting

    expect(mocks.openReview).not.toHaveBeenCalled()
  })

  it.each(['position supply', 'position withdraw'] as const)('%s waits for the new account position before fetching', async (flow) => {
    const state = await openFlow(flow)
    expectOwner(flow, state.quote.value, A)
    isSpyMode.value = false
    positionAvailable.value = false
    const requests = getSwapQuotes.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(state.quote.value).toBeNull()
    expect(getSwapQuotes).toHaveBeenCalledTimes(requests)
    positionAvailable.value = true
    await vi.advanceTimersByTimeAsync(500)
    state.select('router')
    expectOwner(flow, state.quote.value, B)
  })

  describe.each(['borrow', 'multiply', 'position multiply'] as const)('%s prerequisites', (flow) => {
    const steps = flow === 'position multiply' ? ['preload'] as const : ['resolve', 'preload'] as const
    it.each(steps)('discards an old %s completion after the new account already has a quote', async (step) => {
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      if (step === 'resolve') {
        resolveSubAccount.mockImplementation(async () => {
          const captured = subAccount()
          if (owner() === A) await pending
          return captured
        })
      }
      else {
        preloadSubAccount.mockImplementation(async (_account: unknown, sub: Address) => {
          if (sub === getSubAccountAddress(A, 1)) await pending
        })
      }
      const state = await openFlow(flow)
      expect(getSwapQuotes).not.toHaveBeenCalled()
      isSpyMode.value = false
      await vi.advanceTimersByTimeAsync(500)
      state.select('router')
      expectOwner(flow, state.quote.value, B)
      const requests = getSwapQuotes.mock.calls.length
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(getSwapQuotes).toHaveBeenCalledTimes(requests)
      expectOwner(flow, state.quote.value, B)
    })
  })

  it.each(['wallet switch', 'Spy Mode exit'] as const)('lend swap keeps the same-asset transfer amount on %s', async (change) => {
    if (change === 'wallet switch') isSpyMode.value = false
    const sameAssetVault = makeVault('0x5000000000000000000000000000000000000000', WETH)
    vi.stubGlobal('useVaults', () => ({ isReady: ref(true), isMarketDataResolved: ref(true), getVault: async (a: string) => a === vault.address ? vault : sameAssetVault }))
    vi.stubGlobal('useRoute', () => ({ params: { vault: vault.address, subAccount: '1' }, query: { to: sameAssetVault.address } }))
    const app = createSSRApp({})
    app.provide(ssrContextKey, {})
    const component = SwapPage as unknown as { setup: (props: object, context: object) => {
      fromAmount: Ref<string>
      toAmount: Ref<string>
      isSameAsset: Ref<boolean>
      onFromInput: () => void
    } }
    const page = scope.run(() => app.runWithContext(() => component.setup({}, { expose: vi.fn() })))!
    await vi.advanceTimersByTimeAsync(0)
    page.fromAmount.value = '1'
    page.onFromInput()
    expect(page.isSameAsset.value).toBe(true)
    expect(page.toAmount.value).toBe('1')
    if (change === 'wallet switch') address.value = A
    else isSpyMode.value = false
    expect(page.toAmount.value).toBe('1')
    await vi.advanceTimersByTimeAsync(500)
    expect(page.toAmount.value).toBe('1')
    expect(getSwapQuotes).not.toHaveBeenCalled()
  })

  it('borrow keeps the quote request that resolves its own subaccount', async () => {
    isSpyMode.value = false
    // The page starts with no subaccount; the first quote request resolves it.
    const pendingSubAccount = ref<string | null>(null)
    resolveSubAccount.mockImplementation(async () => {
      await Promise.resolve()
      pendingSubAccount.value = subAccount()
      return subAccount()
    })
    const state = await openFlow('borrow', pendingSubAccount)
    expect(getSwapQuotes).toHaveBeenCalledTimes(1)
    expectOwner('borrow', state.quote.value, B)
    // The page clears the subaccount on owner or chain change.
    pendingSubAccount.value = null
    expect(state.quote.value).toBeNull()
  })

  it.each(['account', 'chain'] as const)('keeps the borrow page subaccount cache bound to the current %s', async (change) => {
    vi.stubGlobal('useVaults', () => ({ getBorrowVaultPair: () => new Promise(() => {}) }))
    vi.stubGlobal('useRoute', () => ({ params: { collateral: vault.address, borrow: debtVault.address }, query: {} }))
    const app = createSSRApp({})
    app.provide(ssrContextKey, {})
    const component = BorrowPage as unknown as { setup: (props: object, context: object) => {
      pendingSubAccount: Ref<string | null>
      isPendingSubAccountLoading: Ref<boolean>
      resolvePendingSubAccount: () => Promise<string>
    } }
    const page = scope.run(() => app.runWithContext(() => component.setup({}, { expose: vi.fn() })))!
    let releaseOld!: (account: Address) => void
    let releaseNew!: (account: Address) => void
    mocks.getNewSubAccount
      .mockImplementationOnce(() => new Promise<Address>((resolve) => {
        releaseOld = resolve
      }))
      .mockImplementationOnce(() => new Promise<Address>((resolve) => {
        releaseNew = resolve
      }))
    const oldRequest = page.resolvePendingSubAccount()
    if (change === 'account') isSpyMode.value = false
    else chainId.value = 8453
    const newRequest = page.resolvePendingSubAccount()
    const stale = expect(oldRequest).rejects.toThrow('Account changed')
    releaseOld(getSubAccountAddress(A, 1))
    await stale
    expect(page.pendingSubAccount.value).toBeNull()
    expect(page.isPendingSubAccountLoading.value).toBe(true)
    releaseNew(subAccount())
    await expect(newRequest).resolves.toBe(subAccount())
    expect(page.pendingSubAccount.value).toBe(subAccount())
    expect(page.isPendingSubAccountLoading.value).toBe(false)
    await expect(page.resolvePendingSubAccount()).resolves.toBe(subAccount())
    expect(mocks.getNewSubAccount).toHaveBeenCalledTimes(2)
  })
})
