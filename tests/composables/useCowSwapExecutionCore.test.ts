import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Address } from 'viem'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { useCowSwapExecutionCore } from '~/composables/cowswap/useCowSwapExecutionCore'

vi.mock('@wagmi/vue', () => ({
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn() }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkFresh: vi.fn(),
}))

const owner = '0x0000000000000000000000000000000000000001' as Address

describe('useCowSwapExecutionCore policy freshness', () => {
  beforeEach(() => {
    vi.stubGlobal('useWagmi', () => ({ address: ref(owner) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('usePortfolioRefresh', () => ({ triggerPortfolioRefresh: vi.fn() }))
  })

  it('re-checks policy immediately before the SDK submits the signed order', async () => {
    const policyBlocked = ref(false)
    const submitOrder = vi.fn()
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      executionService: {
        executeCowSwapTransactionPlan: vi.fn(async ({ onProgress }) => {
          policyBlocked.value = true
          onProgress?.({ completed: 0, total: 1, status: 'submitOrder' })
          submitOrder()
          return { results: [], orderUids: [], hashes: [], plan: [] }
        }),
      },
    } as never)

    const core = useCowSwapExecutionCore()
    await expect(core.executePlan({
      plan: [],
      chainId: 1,
      cancellationMode: 'cow-api',
    }, [() => policyBlocked.value ? 'CoW operation policy changed' : undefined]))
      .rejects.toThrow('CoW operation policy changed')

    expect(submitOrder).not.toHaveBeenCalled()
  })
})
