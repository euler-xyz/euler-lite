import { computed, ref, shallowRef, watch, watchEffect } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SwapperMode, type EVault, type PortfolioBorrowPosition, type TransactionPlan, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
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
      quoteInstances: [] as Array<{
        options: { amountField: 'amountIn' | 'amountOut' }
        requestQuotes: ReturnType<typeof vi.fn>
        reset: ReturnType<typeof vi.fn>
      }>,
    },
  }
})

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValue: vi.fn(async () => null),
}))

vi.mock('~/composables/useSwapQuotesParallel', () => ({
  useSwapQuotesParallel: (options: { amountField: 'amountIn' | 'amountOut' }) => {
    const instance = {
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
      requestQuotes: vi.fn(async () => undefined),
      selectProvider: vi.fn(),
    }
    mocks.quoteInstances.push({ options, requestQuotes: instance.requestQuotes, reset: instance.reset })
    return instance
  },
}))

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

describe('useRepaySwapCore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.quoteInstances.length = 0
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
})
