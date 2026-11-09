import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computed, createSSRApp, nextTick, ref, ssrContextKey, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { clearAssetGeoCache, useGeoBlock } from '~/composables/useGeoBlock'
import { setAddressExitOnly } from '~/composables/addressExitOnlyState'
import { valueToNano } from '~/utils/crypto-utils'
import WithdrawPage from '~/pages/lend/[vault]/[subAccount]/withdraw.vue'
import EarnWithdrawPage from '~/pages/earn/[vault]/[subAccount]/withdraw.vue'

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '../..', path), 'utf8')

const VAULT = '0x63bA834bFf27Dd1d80533a56cA27Aa058AAA1130'
const USER = '0x9Db3e0FBd969ec2468C8d9f85440dC5595CE1FD9'
const USDC = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 }
const WETH = { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }
const vault = { address: VAULT, chainId: 1, asset: USDC, shares: { name: 'Cozy', decimals: 6 }, totalCash: 10n ** 12n, totalBorrowed: 0n, availableLiquidity: 10n ** 12n }
const earnVault = { ...vault, availableAssets: 10n ** 12n }
const CONTROLLER = '0x7777777777777777777777777777777777777777'
const quote = { amountIn: '1000000', amountOut: '1', provider: 'test', route: [] }

const mocks = vi.hoisted(() => ({
  openReview: vi.fn(async () => undefined),
  addBatchEntry: vi.fn(async () => undefined),
  planWithdrawOrRedeem: vi.fn(async () => []),
  selectedQuote: { value: null as unknown },
}))

vi.mock('#components', () => ({ SwapTokenSelector: {}, SlippageSettingsModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: vi.fn() }) }))
vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('~/utils/vault/categories', () => ({ isSecuritizeVault: async () => false }))
vi.mock('~/utils/sdk-prices', () => ({ getAssetUsdValueOrZero: async () => 0 }))
vi.mock('~/utils/vault/apy', () => ({ getProjectedRates: async () => null }))
vi.mock('~/utils/vault-intrinsic-apy', () => ({ withVaultIntrinsicApy: (apy: number) => apy }))
vi.mock('~/composables/useLayeredVaults', () => ({ getLayeredVault: (_address: string, fallback: unknown) => fallback }))
vi.mock('~/utils/client-observability', () => ({ reportClientEvent: vi.fn() }))
vi.mock('@eulerxyz/euler-v2-sdk', async original => ({
  ...await original<typeof import('@eulerxyz/euler-v2-sdk')>(),
  computeSupplyApyBreakdown: () => ({}),
}))
vi.mock('~/composables/useVaultWarnings', () => ({ getHookDisabledWarning: () => null, getUtilisationWarning: () => null }))
vi.mock('~/composables/useSwapPriceImpact', () => ({ useSwapPriceImpact: () => ({ priceImpact: ref(0) }) }))
vi.mock('~/composables/usePriceImpactGate', () => ({
  usePriceImpactGate: () => ({ guardWithPriceImpact: async (run: () => Promise<void>) => run() }),
}))
vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => ({ getVault: () => vault }) }))
vi.mock('~/composables/useSwapQuotesParallel', () => ({
  useSwapQuotesParallel: () => ({
    sortedQuoteCards: computed(() => []),
    selectedProvider: computed(() => 'test'),
    selectedQuote: computed(() => mocks.selectedQuote.value),
    selectedQuoteCard: computed(() => null),
    effectiveQuote: computed(() => mocks.selectedQuote.value),
    effectiveQuoteFetchedAt: computed(() => 1),
    isLoading: ref(false),
    quoteError: ref(null),
    statusLabel: ref(''),
    getQuoteDiffPct: () => 0,
    reset: vi.fn(),
    requestQuotes: vi.fn(),
    selectProvider: vi.fn(),
  }),
}))

interface PageState {
  isLoading: Ref<boolean>
  amount: Ref<string>
  needsSwap: Ref<boolean>
  isSwapOutBlocked: Ref<boolean>
  reviewWithdrawDisabled: Ref<boolean>
  disabledReasonInfo: Ref<{ message: string } | undefined>
  canAddToBatch: Ref<boolean>
  onSelectOutputAsset: (asset: typeof USDC | typeof WETH) => void
  submit: () => Promise<void>
  addToBatch: () => Promise<void>
}

const subAccountState = {
  enabledCollaterals: [] as string[],
  borrowed: 0n,
  batchBorrowed: null as bigint | null,
  chainAccountLoaded: true,
}

const subAccountWith = (borrowed: bigint) => ({
  enabledCollaterals: subAccountState.enabledCollaterals,
  enabledControllers: [CONTROLLER],
  positions: [
    { vaultAddress: VAULT, shares: 10n ** 12n, assets: 10n ** 12n, borrowed: 0n },
    { vaultAddress: CONTROLLER, shares: 0n, assets: 0n, borrowed },
  ],
})

// Runs the page's real <script setup>; vitest compiles it non-inline, so setup returns its bindings.
const openPage = async (component: unknown = WithdrawPage): Promise<PageState> => {
  const page = component as { setup: (props: object, context: object) => PageState }
  const app = createSSRApp({})
  app.provide(ssrContextKey, {})
  const state = app.runWithContext(() => page.setup({}, { expose: vi.fn(), emit: vi.fn(), attrs: {}, slots: {} }))
  await vi.waitFor(() => expect(state.isLoading.value).toBe(false))
  state.amount.value = '1'
  await nextTick()
  return state
}

describe('withdraw forms on a blocked vault', () => {
  beforeEach(() => {
    subAccountState.enabledCollaterals = []
    subAccountState.borrowed = 0n
    subAccountState.batchBorrowed = null
    subAccountState.chainAccountLoaded = true
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
    vi.stubGlobal('useRoute', () => ({ params: { vault: VAULT, subAccount: '0' }, query: {} }))
    vi.stubGlobal('useFullBalances', vi.fn())
    vi.stubGlobal('useOperationGuard', vi.fn())
    vi.stubGlobal('useEulerTx', () => ({
      planWithdrawOrRedeem: mocks.planWithdrawOrRedeem,
      prepareTransactionPlan: async () => ({ plan: [] }),
      prefetchPluginData: vi.fn(),
    }))
    vi.stubGlobal('useOperationIntentFactory', () => ({ create: (intent: unknown) => intent }))
    vi.stubGlobal('useExecutionReview', () => ({
      capture: (intents: unknown[]) => ({ intents, open: mocks.openReview }),
    }))
    vi.stubGlobal('useTxBatch', () => ({ addEntry: mocks.addBatchEntry }))
    vi.stubGlobal('useBatchRedirect', () => ({ redirectAfterAdd: vi.fn() }))
    vi.stubGlobal('useFreshAccount', () => ({
      account: ref(subAccountState.chainAccountLoaded
        ? { getSubAccount: () => subAccountWith(subAccountState.borrowed) }
        : undefined),
    }))
    vi.stubGlobal('useVaults', () => ({
      getVault: async () => vault,
      getEarnVault: async () => earnVault,
      getSecuritizeVault: vi.fn(),
      getEscrowVault: vi.fn(),
      isMarketDataResolved: ref(true),
    }))
    vi.stubGlobal('useEffectiveAddress', () => ({ isConnected: ref(true), isSpyMode: ref(false), effectiveAddress: ref(USER) }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({
      runPreparedSimulation: async () => true,
      runSimulation: async () => true,
      simulationError: ref(null),
      clearSimulationError: vi.fn(),
    }))
    vi.stubGlobal('useRewardsApy', () => ({
      version: ref(0),
      getSupplyRewardApy: () => 0,
      getSupplyRewardCampaigns: () => [],
    }))
    vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false }) }))
    vi.stubGlobal('usePlanAccount', () => ({
      account: ref({
        getSubAccount: () => subAccountWith(subAccountState.batchBorrowed ?? subAccountState.borrowed),
      }),
    }))
    vi.stubGlobal('useApyVisibility', () => ({ viewer: ref('all'), visibleTotal: () => 0 }))
    vi.stubGlobal('useEulerProductOfVault', () => ({ name: 'Cozy' }))
    vi.stubGlobal('useSlippage', () => ({ slippage: ref(0.5) }))
    vi.stubGlobal('useDebounceFn', (run: unknown) => run)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('valueToNano', valueToNano)
    vi.stubGlobal('getVaultSupplyApy', () => 0)
    vi.stubGlobal('getVaultTotalSupplyApy', () => 0)
    vi.stubGlobal('logWarn', vi.fn())
    vi.stubGlobal('showError', vi.fn())

    clearAssetGeoCache()
    __setEulerLabelsDataForTest({ geoContext: { chainId: 1, policies: [], productByVault: {} } })
    useGeoBlock().country.value = 'NL'
    mocks.selectedQuote.value = quote
    mocks.openReview.mockClear()
    mocks.addBatchEntry.mockClear()
    mocks.planWithdrawOrRedeem.mockClear()
  })

  afterEach(() => {
    setAddressExitOnly(false)
    vi.unstubAllGlobals()
  })

  it('offers swap-out when the vault is not blocked', async () => {
    const page = await openPage()
    page.onSelectOutputAsset(WETH)
    page.amount.value = '1'

    expect(page.needsSwap.value).toBe(true)
    expect(page.isSwapOutBlocked.value).toBe(false)
    await vi.waitFor(() => expect(page.reviewWithdrawDisabled.value).toBe(false))
    expect(page.canAddToBatch.value).toBe(true)
  })

  describe.each([
    ['an exit-only address', () => setAddressExitOnly(true), /can only repay and withdraw/],
    ['a real geographic block', () => { useGeoBlock().country.value = 'IR' }, /not available in your region/],
    ['an unknown country', () => { useGeoBlock().country.value = null }, /country could not be determined/],
  ])('with %s', (_case, block, reason) => {
    beforeEach(block)

    it('keeps direct withdraw enabled and reaches review', async () => {
      const page = await openPage()

      expect(page.needsSwap.value).toBe(false)
      expect(page.isSwapOutBlocked.value).toBe(false)
      expect(page.reviewWithdrawDisabled.value).toBe(false)
      expect(page.disabledReasonInfo.value).toBeUndefined()
      expect(page.canAddToBatch.value).toBe(true)

      await page.submit()
      expect(mocks.openReview).toHaveBeenCalledTimes(1)

      await page.addToBatch()
      expect(mocks.addBatchEntry).toHaveBeenCalledTimes(1)
    })

    it('disables swap-out in the form, the submit guard and the batch', async () => {
      const page = await openPage()
      page.onSelectOutputAsset(WETH)
      page.amount.value = '1'

      expect(page.isSwapOutBlocked.value).toBe(true)
      expect(page.reviewWithdrawDisabled.value).toBe(true)
      expect(page.disabledReasonInfo.value?.message).toMatch(reason)
      expect(page.canAddToBatch.value).toBe(false)

      await page.submit()
      await page.addToBatch()
      expect(mocks.planWithdrawOrRedeem).not.toHaveBeenCalled()
      expect(mocks.openReview).not.toHaveBeenCalled()
      expect(mocks.addBatchEntry).not.toHaveBeenCalled()
    })

    it('re-enables direct withdraw when the output goes back to the underlying', async () => {
      const page = await openPage()
      page.onSelectOutputAsset(WETH)
      expect(page.isSwapOutBlocked.value).toBe(true)

      page.onSelectOutputAsset(USDC)
      page.amount.value = '1'

      expect(page.isSwapOutBlocked.value).toBe(false)
      await vi.waitFor(() => expect(page.reviewWithdrawDisabled.value).toBe(false))
    })
  })

  it('never uses regional wording for an exit-only address', async () => {
    setAddressExitOnly(true)
    const page = await openPage()
    page.onSelectOutputAsset(WETH)
    page.amount.value = '1'

    expect(page.disabledReasonInfo.value?.message).not.toMatch(/region/i)
  })

  describe.each([
    ['lend', WithdrawPage],
    ['earn', EarnWithdrawPage],
  ])('%s withdraw of collateral', (_page, component) => {
    const expectRefused = async (page: PageState) => {
      expect(page.reviewWithdrawDisabled.value).toBe(true)
      expect(page.canAddToBatch.value).toBe(false)
      expect(page.disabledReasonInfo.value?.message).toMatch(/Repay any debt before withdrawing/)

      await page.submit()
      await page.addToBatch()
      expect(mocks.planWithdrawOrRedeem).not.toHaveBeenCalled()
      expect(mocks.openReview).not.toHaveBeenCalled()
      expect(mocks.addBatchEntry).not.toHaveBeenCalled()
    }
    const expectAllowed = async (page: PageState) => {
      await vi.waitFor(() => expect(page.reviewWithdrawDisabled.value).toBe(false))
      expect(page.canAddToBatch.value).toBe(true)

      await page.submit()
      expect(mocks.openReview).toHaveBeenCalledTimes(1)
    }

    it('refuses an exit-only address while the sub-account owes debt', async () => {
      setAddressExitOnly(true)
      subAccountState.enabledCollaterals = [VAULT]
      subAccountState.borrowed = 1n

      await expectRefused(await openPage(component))
    })

    it('allows it once the debt is repaid, even with the collateral still enabled', async () => {
      setAddressExitOnly(true)
      subAccountState.enabledCollaterals = [VAULT]

      await expectAllowed(await openPage(component))
    })

    it('stays refused while the repay is only queued in the batch', async () => {
      setAddressExitOnly(true)
      subAccountState.enabledCollaterals = [VAULT]
      subAccountState.borrowed = 1n
      subAccountState.batchBorrowed = 0n

      await expectRefused(await openPage(component))
    })

    it('refuses until the real account has loaded', async () => {
      setAddressExitOnly(true)
      subAccountState.chainAccountLoaded = false

      await expectRefused(await openPage(component))
    })

    it('does not wait for the real account without the exit-only flag', async () => {
      subAccountState.chainAccountLoaded = false

      await expectAllowed(await openPage(component))
    })

    it('allows a deposit that is not collateral for that debt', async () => {
      setAddressExitOnly(true)
      subAccountState.enabledCollaterals = [CONTROLLER]
      subAccountState.borrowed = 1n

      await expectAllowed(await openPage(component))
    })

    it('leaves real geographic blocks as they were', async () => {
      useGeoBlock().country.value = 'IR'
      subAccountState.enabledCollaterals = [VAULT]
      subAccountState.borrowed = 1n

      await expectAllowed(await openPage(component))
    })
  })

  it('wires the alert through GeoBlockAlert, ahead of the asset alert', () => {
    const source = read('pages/lend/[vault]/[subAccount]/withdraw.vue')

    expect(source).toMatch(/<GeoBlockAlert\s+v-if="isWithdrawBlocked"/)
    expect(source).toMatch(/<UiAlert\s+v-else-if="isOutputAssetBlocked \|\| isOutputAssetRestricted"/)
    expect(read('pages/earn/[vault]/[subAccount]/withdraw.vue')).toMatch(/<GeoBlockAlert\s+v-if="isCollateralWithdrawBlocked"/)
  })
})
