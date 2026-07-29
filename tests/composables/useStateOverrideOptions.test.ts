import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { fetchErc20SlotHints } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import { useStateOverrideOptions, useStateOverrideResolution } from '~/composables/useStateOverrideOptions'

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

  it('drops hints from the previous chain when the chain changes', async () => {
    const stateOverrideOptions = useStateOverrideOptions()

    await stateOverrideOptions.primeSlotHintsFor([tokenA])
    expect(stateOverrideOptions.slotHints.value).toEqual({
      [tokenA]: { balanceSlotIndex: 1n },
    })

    chainId.value = 8453
    expect(stateOverrideOptions.slotHints.value).toEqual({})

    await stateOverrideOptions.primeSlotHintsFor([tokenB])

    // Chain 1's slot indices must not leak into chain 8453's simulator options.
    expect(stateOverrideOptions.slotHints.value).toEqual({
      [tokenB]: { balanceSlotIndex: 8453n },
    })
    expect(stateOverrideOptions.buildStateOverrideOptions().slotHints).toEqual({
      [tokenB]: { balanceSlotIndex: 8453n },
    })
  })

  it('does not restore old-chain hints when a probe resolves after switching chains', async () => {
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
  })

  it('keeps hints from concurrent primes instead of letting the last one win', async () => {
    let resolveFirst!: (hint: { balanceSlotIndex: bigint }) => void
    vi.mocked(fetchErc20SlotHints)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve
      }))
      .mockResolvedValueOnce({ balanceSlotIndex: 2n })
    const stateOverrideOptions = useStateOverrideOptions()

    const firstPrime = stateOverrideOptions.primeSlotHintsFor([tokenA])
    await vi.waitFor(() => expect(fetchErc20SlotHints).toHaveBeenCalledTimes(1))

    // Second prime resolves and writes first; the slower first prime must merge
    // onto that result rather than overwrite it with a pre-await snapshot.
    await stateOverrideOptions.primeSlotHintsFor([tokenB])
    resolveFirst({ balanceSlotIndex: 1n })
    await firstPrime

    expect(stateOverrideOptions.slotHints.value).toEqual({
      [tokenA]: { balanceSlotIndex: 1n },
      [tokenB]: { balanceSlotIndex: 2n },
    })
  })

  it('does not report background primes as pending work', async () => {
    const { isResolvingStateOverrideHints } = useStateOverrideResolution()
    const stateOverrideOptions = useStateOverrideOptions()

    let resolveHint!: (hint: { balanceSlotIndex: bigint }) => void
    vi.mocked(fetchErc20SlotHints).mockImplementationOnce(() => new Promise((resolve) => {
      resolveHint = resolve
    }))

    const backgroundPrime = stateOverrideOptions.primeSlotHintsFor([tokenA], { background: true })
    await vi.waitFor(() => expect(fetchErc20SlotHints).toHaveBeenCalledTimes(1))

    // Page-load priming must not disable submit / add-to-batch while in flight.
    expect(isResolvingStateOverrideHints.value).toBe(false)
    resolveHint({ balanceSlotIndex: 1n })
    await backgroundPrime
    expect(isResolvingStateOverrideHints.value).toBe(false)
  })

  it('reports foreground primes as pending work', async () => {
    const { isResolvingStateOverrideHints } = useStateOverrideResolution()
    const stateOverrideOptions = useStateOverrideOptions()

    let resolveHint!: (hint: { balanceSlotIndex: bigint }) => void
    vi.mocked(fetchErc20SlotHints).mockImplementationOnce(() => new Promise((resolve) => {
      resolveHint = resolve
    }))

    const prime = stateOverrideOptions.primeSlotHintsFor([tokenA])
    await vi.waitFor(() => expect(isResolvingStateOverrideHints.value).toBe(true))

    resolveHint({ balanceSlotIndex: 1n })
    await prime
    expect(isResolvingStateOverrideHints.value).toBe(false)
  })
})
