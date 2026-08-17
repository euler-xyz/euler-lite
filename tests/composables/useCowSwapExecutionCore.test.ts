import { computed, ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import {
  COW_SWAP_REVIEW_CONTEXT_CHANGED_ERROR,
  useCowSwapExecutionCore,
} from '~/composables/cowswap/useCowSwapExecutionCore'

vi.mock('@wagmi/vue', () => ({
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn() }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkFresh: vi.fn(),
}))

const owner = '0x0000000000000000000000000000000000000001' as Address
const otherOwner = '0x0000000000000000000000000000000000000002' as Address
let currentAddress = ref<Address | undefined>(owner)
let currentChainId = ref<number | undefined>(1)

describe('useCowSwapExecutionCore policy freshness', () => {
  beforeEach(() => {
    currentAddress = ref(owner)
    currentChainId = ref(1)
    vi.stubGlobal('useWagmi', () => ({ address: currentAddress, chainId: currentChainId }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useCowSwapEligibility', () => ({ cowSwapForcedOff: computed(() => false) }))
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
      account: owner,
      chainId: 1,
      cancellationMode: 'cow-api',
    }, [() => policyBlocked.value ? 'CoW operation policy changed' : undefined]))
      .rejects.toThrow('CoW operation policy changed')

    expect(submitOrder).not.toHaveBeenCalled()
  })

  it('records an accepted order when policy changes before completed progress', async () => {
    const policyBlocked = ref(false)
    const acceptedUid = `0x${'11'.repeat(56)}` as const
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      executionService: {
        executeCowSwapTransactionPlan: vi.fn(async ({ onProgress }) => {
          onProgress?.({ completed: 0, total: 1, status: 'submitOrder' })
          policyBlocked.value = true
          onProgress?.({ completed: 1, total: 1, status: 'completed', orderUid: acceptedUid })
          return { results: [], orderUids: [acceptedUid], hashes: [], plan: [] }
        }),
      },
    } as never)

    const core = useCowSwapExecutionCore()
    await expect(core.executePlan({
      plan: [],
      account: owner,
      chainId: 1,
      cancellationMode: 'cow-api',
    }, [() => policyBlocked.value ? 'CoW operation policy changed' : undefined]))
      .resolves.toBe(acceptedUid)

    expect(core.orderUid.value).toBe(acceptedUid)
    expect(core.status.value).toBe('submitted')
    expect(core.error.value).toBeNull()
  })

  it.each([
    ['account', () => { currentAddress.value = otherOwner }],
    ['chain', () => { currentChainId.value = 10 }],
  ] as const)('rejects %s drift after the reviewed source unmounts', async (_kind, drift) => {
    const executeCowSwapTransactionPlan = vi.fn()
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      executionService: { executeCowSwapTransactionPlan },
    } as never)
    const core = useCowSwapExecutionCore()

    drift()

    await expect(core.executePlan({
      plan: [],
      account: owner,
      chainId: 1,
      cancellationMode: 'cow-api',
    })).rejects.toThrow(COW_SWAP_REVIEW_CONTEXT_CHANGED_ERROR)
    expect(executeCowSwapTransactionPlan).not.toHaveBeenCalled()
  })
})

vi.mock('~/composables/usePortfolioRefresh', () => ({
  usePortfolioRefresh: () => ({ triggerPortfolioRefresh: vi.fn() }),
}))

const OWNER = '0x1000000000000000000000000000000000000000'

describe('useCowSwapExecutionCore Safe backstop', () => {
  let isSafeWallet: Ref<boolean>
  let isSafeWalletResolved: Ref<boolean>

  const setupCore = () => useCowSwapExecutionCore()

  const dummyFlow = {
    plan: [] as TransactionPlan,
    account: OWNER as Address,
    chainId: 1,
    cancellationMode: 'cow-api' as const,
    orderbookUrl: 'https://api.cow.fi/mainnet',
  }

  beforeEach(() => {
    isSafeWallet = ref(false)
    isSafeWalletResolved = ref(true)
    vi.stubGlobal('useWagmi', () => ({ address: ref(OWNER), chainId: ref(1) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet, isSafeWalletResolved }))
    vi.stubGlobal('useCowSwapEligibility', () => ({
      cowSwapForcedOff: computed(() => isSafeWallet.value || !isSafeWalletResolved.value),
    }))
  })

  it('rejects execution for Safe wallets before any transaction is sent', async () => {
    isSafeWallet.value = true
    const core = setupCore()

    await expect(core.executePlan(dummyFlow)).rejects.toThrow('CoW Swap is not available with Safe wallets')
  })

  it('rejects execution while Safe detection is pending', async () => {
    isSafeWalletResolved.value = false
    const core = setupCore()

    await expect(core.executePlan(dummyFlow)).rejects.toThrow('CoW Swap is not available with Safe wallets')
  })
})
