import { ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { readPendingSubmission, resetPendingSubmissionMemoryFallback, writePendingSubmission } from '~/utils/pendingSubmissions'

// Hoisted so the same spy instances survive vi.resetModules() — the mock
// factories re-run for each fresh module graph but hand back these objects.
const wagmiMocks = vi.hoisted(() => ({
  sendTransactionAsync: vi.fn(),
  signTypedDataAsync: vi.fn(),
}))

const sdkMocks = vi.hoisted(() => ({
  getEulerSdkFresh: vi.fn(),
}))

vi.mock('@wagmi/vue', () => ({
  useSendTransaction: () => ({ sendTransactionAsync: wagmiMocks.sendTransactionAsync }),
  useSignTypedData: () => ({ signTypedDataAsync: wagmiMocks.signTypedDataAsync }),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkFresh: sdkMocks.getEulerSdkFresh,
}))

vi.mock('~/composables/usePortfolioRefresh', () => ({
  usePortfolioRefresh: () => ({ triggerPortfolioRefresh: vi.fn() }),
}))

const OWNER = getAddress('0x1000000000000000000000000000000000000000')

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
    vi.clearAllMocks()
    isSafeWallet = ref(false)
    isSafeWalletResolved = ref(true)
    vi.stubGlobal('useWagmi', () => ({ address: ref(OWNER) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet, isSafeWalletResolved }))
    vi.stubGlobal('useCowSwapEligibility', () => ({
      cowSwapForcedOff: computed(() => isSafeWallet.value || !isSafeWalletResolved.value),
    }))
    // The pending-submission quarantine is module state shared across tests.
    resetPendingSubmissionMemoryFallback()
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

  it('blocks execution while an ambiguous submission from another surface is unresolved', async () => {
    // The CoW executor sends approvals and signs the order permit straight
    // through the wallet callbacks, without passing any plan-executor gate —
    // a quarantined submission from any flow must stop it before either.
    writePendingSubmission('batch', {
      phase: 'armed',
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
      submittedAt: 1_000,
    })
    const executeCowSwapTransactionPlan = vi.fn()
    sdkMocks.getEulerSdkFresh.mockResolvedValue({
      providerService: {
        getProvider: vi.fn(() => ({
          getTransactionReceipt: vi.fn(async () => {
            throw new Error('receipt not found')
          }),
        })),
      },
      executionService: { executeCowSwapTransactionPlan },
    })
    const core = await setupCore()

    await expect(core.executePlan(dummyFlow)).rejects.toThrow(
      'handed to the wallet but no transaction id came back',
    )

    // Nothing crossed the wallet boundary: no approval transaction was sent
    // and no order or permit signature was requested.
    expect(executeCowSwapTransactionPlan).not.toHaveBeenCalled()
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
    expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
    expect(readPendingSubmission('batch', OWNER, 1)).toBeDefined()
  })
})
