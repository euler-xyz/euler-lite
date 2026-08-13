import { ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'

vi.mock('@wagmi/vue', () => ({
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn() }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkFresh: vi.fn(),
}))

vi.mock('~/composables/usePortfolioRefresh', () => ({
  usePortfolioRefresh: () => ({ triggerPortfolioRefresh: vi.fn() }),
}))

const OWNER = '0x1000000000000000000000000000000000000000'

describe('useCowSwapExecutionCore Safe backstop', () => {
  let isSafeWallet: Ref<boolean>
  let isSafeWalletResolved: Ref<boolean>

  const setupCore = async () => {
    const { useCowSwapExecutionCore } = await import('~/composables/cowswap/useCowSwapExecutionCore')
    return useCowSwapExecutionCore()
  }

  const dummyFlow = {
    plan: [] as TransactionPlan,
    chainId: 1,
    cancellationMode: 'cow-api' as const,
    orderbookUrl: 'https://api.cow.fi/mainnet',
  }

  beforeEach(() => {
    vi.resetModules()
    isSafeWallet = ref(false)
    isSafeWalletResolved = ref(true)
    vi.stubGlobal('useWagmi', () => ({ address: ref(OWNER) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet, isSafeWalletResolved }))
    vi.stubGlobal('useCowSwapEligibility', () => ({
      cowSwapForcedOff: computed(() => isSafeWallet.value || !isSafeWalletResolved.value),
    }))
  })

  it('rejects execution for Safe wallets before any transaction is sent', async () => {
    isSafeWallet.value = true
    const core = await setupCore()

    await expect(core.executePlan(dummyFlow)).rejects.toThrow('CoW Swap is not available with Safe wallets')
  })

  it('rejects execution while Safe detection is pending', async () => {
    isSafeWalletResolved.value = false
    const core = await setupCore()

    await expect(core.executePlan(dummyFlow)).rejects.toThrow('CoW Swap is not available with Safe wallets')
  })
})
