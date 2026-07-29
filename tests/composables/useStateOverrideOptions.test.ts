import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { fetchErc20SlotHints } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import { useStateOverrideOptions } from '~/composables/useStateOverrideOptions'
import {
  getBatchPrefetchedSlotHints,
  resetBatchPrefetchState,
} from '~/composables/batchPrefetchState'

vi.mock('@eulerxyz/euler-v2-sdk', () => ({
  fetchErc20SlotHints: vi.fn(),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkForChain: vi.fn(),
}))

const chainId = ref<number | undefined>(1)
const tokenA = '0x1000000000000000000000000000000000000001' as const
const tokenB = '0x2000000000000000000000000000000000000002' as const
const permit2 = '0x3000000000000000000000000000000000000003' as const

describe('useStateOverrideOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetBatchPrefetchState()
    chainId.value = 1
    vi.stubGlobal('useWallets', () => ({ balances: ref(new Map()) }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.mocked(getEulerSdkForChain).mockImplementation(async cid => ({
      deploymentService: {
        getDeployment: () => ({
          addresses: { coreAddrs: { permit2 } },
        }),
      },
      providerService: {
        getProvider: () => ({ chainId: cid }),
      },
    }) as never)
    vi.mocked(fetchErc20SlotHints).mockImplementation(async (provider) => {
      const providerChainId = (provider as unknown as { chainId: number }).chainId
      return { balanceSlotIndex: BigInt(providerChainId) }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps local and shared slot hints isolated across chain changes', async () => {
    const stateOverrideOptions = useStateOverrideOptions()

    await stateOverrideOptions.primeSlotHintsFor([tokenA])
    expect(getBatchPrefetchedSlotHints(1)).toEqual({
      [tokenA]: { balanceSlotIndex: 1n },
    })

    chainId.value = 8453
    expect(stateOverrideOptions.slotHints.value).toEqual({})

    await stateOverrideOptions.primeSlotHintsFor([tokenB])

    expect(stateOverrideOptions.slotHints.value).toEqual({
      [tokenB]: { balanceSlotIndex: 8453n },
    })
    expect(getBatchPrefetchedSlotHints(8453)).toEqual({
      [tokenB]: { balanceSlotIndex: 8453n },
    })
    expect(getBatchPrefetchedSlotHints(8453)).not.toHaveProperty(tokenA)
    expect(stateOverrideOptions.buildStateOverrideOptions().slotHints).toEqual({
      [tokenB]: { balanceSlotIndex: 8453n },
    })
  })

  it('does not restore old-chain local hints when a probe resolves after switching chains', async () => {
    let resolveChainOneHint!: (hint: { balanceSlotIndex: bigint }) => void
    vi.mocked(fetchErc20SlotHints)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveChainOneHint = resolve
      }))
      .mockResolvedValueOnce({ balanceSlotIndex: 8453n })
    const stateOverrideOptions = useStateOverrideOptions()

    const chainOnePrime = stateOverrideOptions.primeSlotHintsFor([tokenA])
    await vi.waitFor(() => expect(fetchErc20SlotHints).toHaveBeenCalledTimes(1))

    chainId.value = 8453
    await stateOverrideOptions.primeSlotHintsFor([tokenB])
    resolveChainOneHint({ balanceSlotIndex: 1n })
    await chainOnePrime

    expect(stateOverrideOptions.slotHints.value).toEqual({
      [tokenB]: { balanceSlotIndex: 8453n },
    })
    expect(getBatchPrefetchedSlotHints(1)).toEqual({
      [tokenA]: { balanceSlotIndex: 1n },
    })
    expect(getBatchPrefetchedSlotHints(8453)).toEqual({
      [tokenB]: { balanceSlotIndex: 8453n },
    })
  })
})
