import { computed, nextTick, ref, shallowRef, watch, watchEffect } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SwapperMode, type EVault, type PortfolioBorrowPosition, type SwapQuote, type TransactionPlan, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import { useRepaySwapCore } from '~/composables/repay/useRepaySwapCore'

const { USER, sourceVault, borrowVault, position, mocks } = vi.hoisted(() => {
  const USER = '0x0000000000000000000000000000000000000001' as Address
  const SOURCE_VAULT = '0x0000000000000000000000000000000000000002' as Address
  const SOURCE_ASSET = '0x0000000000000000000000000000000000000003' as Address
  const BORROW_VAULT = '0x0000000000000000000000000000000000000004' as Address
  const BORROW_ASSET = '0x0000000000000000000000000000000000000005' as Address

  const sourceVault = {
    address: SOURCE_VAULT,
    availableLiquidity: 5_000n,
    asset: {
      address: SOURCE_ASSET,
      symbol: 'WETH',
      decimals: 0,
    },
    shares: {
      address: SOURCE_VAULT,
      symbol: 'eWETH',
      decimals: 0,
    },
  } as unknown as EVault

  const borrowVault = {
    address: BORROW_VAULT,
    asset: {
      address: BORROW_ASSET,
      symbol: 'USDC',
      decimals: 0,
    },
    shares: {
      address: BORROW_VAULT,
      symbol: 'eUSDC',
      decimals: 0,
    },
    collaterals: [],
  } as unknown as EVault

  const position = {
    subAccount: USER,
    borrowed: 2_000n,
  } as unknown as PortfolioBorrowPosition<VaultEntity>

  return {
    USER,
    sourceVault,
    borrowVault,
    position,
    mocks: {
      getAssetUsdValue: vi.fn(async (_amount?: number | bigint) => null as number | null),
      quoteInstances: [] as Array<{
        options: { amountField: 'amountIn' | 'amountOut' }
        selectedQuote: { value: SwapQuote | null }
        effectiveQuote: { value: SwapQuote | null }
        requestQuotes: ReturnType<typeof vi.fn>
        reset: ReturnType<typeof vi.fn>
      }>,
    },
  }
})

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValue: mocks.getAssetUsdValue,
}))

vi.mock('~/composables/useSwapQuotesParallel', () => ({
  useSwapQuotesParallel: (options: { amountField: 'amountIn' | 'amountOut' }) => {
    const selectedQuote = ref<SwapQuote | null>(null)
    const effectiveQuote = ref<SwapQuote | null>(null)
    const reset = vi.fn(() => {
      selectedQuote.value = null
      effectiveQuote.value = null
    })
    const instance = {
      sortedQuoteCards: ref([]),
      selectedProvider: ref(null),
      selectedQuote,
      effectiveQuote,
      effectiveQuoteFetchedAt: ref(null),
      providersCount: ref(0),
      isLoading: ref(false),
      quoteError: ref(null),
      statusLabel: ref(null),
      getQuoteDiffPct: vi.fn(() => null),
      reset,
      requestQuotes: vi.fn(async () => undefined),
      selectProvider: vi.fn(),
    }
    mocks.quoteInstances.push({
      options,
      selectedQuote,
      effectiveQuote,
      requestQuotes: instance.requestQuotes,
      reset,
    })
    return instance
  },
}))

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

describe('useRepaySwapCore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.quoteInstances.length = 0
    mocks.getAssetUsdValue.mockResolvedValue(null)
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('useWagmi', () => ({
      address: ref(USER),
    }))
    vi.stubGlobal('useSpyMode', () => ({
      isSpyMode: ref(false),
      spyAddress: ref(undefined),
    }))
    vi.stubGlobal('useEffectiveAddress', () => ({
      address: ref(USER),
      isConnected: ref(false),
      isSpyMode: ref(false),
      spyAddress: ref(undefined),
      effectiveAddress: ref(USER),
    }))
    vi.stubGlobal('useEulerAddresses', () => ({
      chainId: ref(999_999),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('requests a target-debt quote when max debt is entered', async () => {
    const repay = useRepaySwapCore({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      sourceVault: shallowRef<EVault | undefined>(sourceVault),
      sourceAssets: ref(5_000n),
      sourceBalance: computed(() => 5_000n),
      formTab: ref('collateral'),
      formTabName: 'collateral',
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      getCurrentDebt: () => position.borrowed,
      getQuoteAccounts: () => ({ accountIn: USER, accountOut: USER }),
      buildTxPlanForQuote: vi.fn(async () => [] as unknown as TransactionPlan),
    })

    repay.debtAmount.value = '2000'
    repay.onDebtInput()
    await flushPromises()

    const exactIn = mocks.quoteInstances.find(instance => instance.options.amountField === 'amountOut')
    const targetDebt = mocks.quoteInstances.find(instance => instance.options.amountField === 'amountIn')
    expect(exactIn?.requestQuotes).not.toHaveBeenCalled()
    expect(targetDebt?.requestQuotes).toHaveBeenCalledWith(expect.objectContaining({
      tokenIn: sourceVault.asset.address,
      tokenOut: borrowVault.asset.address,
      amount: 2_000n,
      swapperMode: SwapperMode.TARGET_DEBT,
      isRepay: true,
      targetDebt: 0n,
      currentDebt: 2_000n,
    }))
  })

  it('uses the mode-aware, source-capped swap input for shared source depletion', async () => {
    const repay = useRepaySwapCore({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      sourceVault: shallowRef<EVault | undefined>(sourceVault),
      sourceAssets: ref(105n),
      sourceBalance: computed(() => 5_000n),
      formTab: ref('collateral'),
      formTabName: 'collateral',
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      getCurrentDebt: () => position.borrowed,
      getQuoteAccounts: () => ({ accountIn: USER, accountOut: USER }),
      buildTxPlanForQuote: vi.fn(async () => [] as unknown as TransactionPlan),
    })
    const quote = {
      amountIn: '100',
      amountInMax: '110',
      amountOut: '200',
    } as SwapQuote
    const exactIn = mocks.quoteInstances.find(instance => instance.options.amountField === 'amountOut')
    const targetDebt = mocks.quoteInstances.find(instance => instance.options.amountField === 'amountIn')

    exactIn!.effectiveQuote.value = quote
    await nextTick()
    expect(repay.spent.value).toBe(100n)

    repay.direction.value = SwapperMode.TARGET_DEBT
    targetDebt!.effectiveQuote.value = quote
    await nextTick()
    expect(repay.spent.value).toBe(105n)

    targetDebt!.effectiveQuote.value = { ...quote, amountInMax: '0' }
    await nextTick()
    expect(repay.spent.value).toBe(100n)

    targetDebt!.effectiveQuote.value = { ...quote, amountInMax: 'invalid' }
    await nextTick()
    expect(repay.spent.value).toBeNull()
    expect(repay.debtRepaid.value).toBeNull()

    targetDebt!.effectiveQuote.value = { ...quote, amountIn: '106' }
    await nextTick()
    expect(repay.spent.value).toBeNull()
    expect(repay.debtRepaid.value).toBeNull()
  })

  it('invalidates the previous quote before debouncing a replacement', async () => {
    let runPendingQuote: (() => Promise<void>) | undefined
    vi.stubGlobal('useDebounceFn', (fn: () => Promise<void>) => () => {
      runPendingQuote = fn
    })
    const repay = useRepaySwapCore({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      sourceVault: shallowRef<EVault | undefined>(sourceVault),
      sourceAssets: ref(5_000n),
      sourceBalance: computed(() => 5_000n),
      formTab: ref('collateral'),
      formTabName: 'collateral',
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      getCurrentDebt: () => position.borrowed,
      getQuoteAccounts: () => ({ accountIn: USER, accountOut: USER }),
      buildTxPlanForQuote: vi.fn(async () => [] as unknown as TransactionPlan),
    })
    const targetDebt = mocks.quoteInstances.find(instance => instance.options.amountField === 'amountIn')!
    const previousQuote = {
      amountIn: '100',
      amountInMax: '110',
      amountOut: '200',
    } as SwapQuote
    repay.direction.value = SwapperMode.TARGET_DEBT
    targetDebt.selectedQuote.value = previousQuote
    targetDebt.effectiveQuote.value = previousQuote
    await nextTick()
    expect(repay.spent.value).toBe(110n)

    repay.debtAmount.value = '300'
    repay.onDebtInput()

    expect(targetDebt.reset).toHaveBeenCalled()
    expect(repay.spent.value).toBeNull()
    expect(repay.debtRepaid.value).toBeNull()
    expect(targetDebt.requestQuotes).not.toHaveBeenCalled()

    await runPendingQuote?.()
    expect(targetDebt.requestQuotes).toHaveBeenCalledWith(expect.objectContaining({
      amount: 300n,
      swapperMode: SwapperMode.TARGET_DEBT,
    }))
  })

  it('invalidates pending next-debt USD values on newer input and missing position', async () => {
    let resolve1900!: (value: number) => void
    let resolve1700!: (value: number) => void
    const pending1900 = new Promise<number>((resolve) => {
      resolve1900 = resolve
    })
    const pending1700 = new Promise<number>((resolve) => {
      resolve1700 = resolve
    })
    mocks.getAssetUsdValue.mockImplementation(async (amount?: number | bigint) => {
      if (amount === undefined) return null
      if (amount === 1900n) return pending1900
      if (amount === 1700n) return pending1700
      return Number(amount) / 100
    })
    const positionRef = shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position)
    const sameAssetSource = {
      ...sourceVault,
      asset: { ...sourceVault.asset, address: borrowVault.asset.address },
    } as EVault
    const repay = useRepaySwapCore({
      position: positionRef,
      borrowVault: computed(() => borrowVault),
      sourceVault: shallowRef<EVault | undefined>(sameAssetSource),
      sourceAssets: ref(5_000n),
      sourceBalance: computed(() => 5_000n),
      formTab: ref('collateral'),
      formTabName: 'collateral',
      slippage: ref(0.5),
      clearSimulationError: vi.fn(),
      getCurrentDebt: () => positionRef.value?.borrowed ?? 0n,
      getQuoteAccounts: () => ({ accountIn: USER, accountOut: USER }),
      buildTxPlanForQuote: vi.fn(async () => [] as unknown as TransactionPlan),
    })

    repay.debtAmount.value = '100'
    await vi.waitFor(() => expect(mocks.getAssetUsdValue).toHaveBeenCalledWith(1900n, borrowVault, 'off-chain'))
    expect(repay.nextBorrowValueUsd.value).toBeNull()

    repay.debtAmount.value = '200'
    await vi.waitFor(() => expect(repay.nextBorrowValueUsd.value).toBe(18))
    resolve1900(19)
    await flushPromises()
    expect(repay.nextBorrowValueUsd.value).toBe(18)

    repay.debtAmount.value = '300'
    await vi.waitFor(() => expect(mocks.getAssetUsdValue).toHaveBeenCalledWith(1700n, borrowVault, 'off-chain'))
    positionRef.value = undefined
    await nextTick()
    expect(repay.nextBorrowValueUsd.value).toBeNull()
    resolve1700(17)
    await flushPromises()
    expect(repay.nextBorrowValueUsd.value).toBeNull()
  })
})
