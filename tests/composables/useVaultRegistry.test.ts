import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { VaultType } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { resetVaultCategoryCache } from '~/utils/vault/categories'

const VAULT_ADDRESS = getAddress('0x0000000000000000000000000000000000000101')

const mocks = vi.hoisted(() => ({
  fetchVault: vi.fn(),
  fetchVaultType: vi.fn(),
  fetchVerifiedVaultAddresses: vi.fn(),
  getEulerSdkForChain: vi.fn(),
}))

const chainId = ref(1)

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

const makeVault = (vaultChainId: number, totalAssets = 0n): EVault => ({
  address: VAULT_ADDRESS,
  chainId: vaultChainId,
  totalAssets,
}) as unknown as EVault

describe('useVaultRegistry lazy resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetVaultCategoryCache()
    chainId.value = 1

    mocks.fetchVaultType.mockResolvedValue(VaultType.EVault)
    mocks.fetchVerifiedVaultAddresses.mockResolvedValue([])
    const sdk = {
      eVaultService: {
        fetchVault: mocks.fetchVault,
        fetchVerifiedVaultAddresses: mocks.fetchVerifiedVaultAddresses,
      },
      eulerEarnService: { fetchVault: vi.fn() },
      securitizeVaultService: { fetchVault: vi.fn() },
      vaultMetaService: { fetchVaultType: mocks.fetchVaultType },
    }
    mocks.getEulerSdkForChain.mockResolvedValue(sdk)

    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.stubGlobal('useEulerSdk', () => ({ getEulerSdkForChain: mocks.getEulerSdkForChain }))
    useVaultRegistry().clear()
  })

  afterEach(() => {
    useVaultRegistry().clear()
    resetVaultCategoryCache()
    vi.unstubAllGlobals()
  })

  it('does not commit an old-chain resolution that finishes after replacement', async () => {
    const oldFetch = deferred<{ result: EVault }>()
    const currentVault = makeVault(8453, 2n)
    mocks.fetchVault.mockImplementation(async (targetChainId: number) => {
      if (targetChainId === 1) return oldFetch.promise
      return { result: currentVault }
    })

    const registry = useVaultRegistry()
    const oldResolution = registry.getOrFetch(VAULT_ADDRESS)
    await vi.waitFor(() => expect(mocks.fetchVault).toHaveBeenCalledWith(
      1,
      VAULT_ADDRESS as Address,
      expect.any(Object),
    ))

    chainId.value = 8453
    registry.clear()
    await expect(registry.getOrFetch(VAULT_ADDRESS)).resolves.toBe(currentVault)
    expect(registry.getVault(VAULT_ADDRESS)).toBe(currentVault)

    oldFetch.resolve({ result: makeVault(1, 1n) })
    await expect(oldResolution).resolves.toBeUndefined()
    expect(registry.getVault(VAULT_ADDRESS)).toBe(currentVault)
  })

  it('keeps a same-address replacement pending when the stale promise settles', async () => {
    const staleFetch = deferred<{ result: EVault }>()
    const replacementFetch = deferred<{ result: EVault }>()
    const replacementVault = makeVault(1, 2n)
    mocks.fetchVault
      .mockImplementationOnce(() => staleFetch.promise)
      .mockImplementationOnce(() => replacementFetch.promise)
      .mockResolvedValue({ result: makeVault(1, 3n) })

    const registry = useVaultRegistry()
    const staleResolution = registry.getOrFetch(VAULT_ADDRESS)
    await vi.waitFor(() => expect(mocks.fetchVault).toHaveBeenCalledTimes(1))

    registry.clear()
    const replacementResolution = registry.getOrFetch(VAULT_ADDRESS)
    await vi.waitFor(() => expect(mocks.fetchVault).toHaveBeenCalledTimes(2))

    staleFetch.resolve({ result: makeVault(1, 1n) })
    await expect(staleResolution).resolves.toBeUndefined()

    const deduplicatedResolution = registry.getOrFetch(VAULT_ADDRESS)
    await Promise.resolve()
    expect(mocks.fetchVault).toHaveBeenCalledTimes(2)

    replacementFetch.resolve({ result: replacementVault })
    await expect(replacementResolution).resolves.toBe(replacementVault)
    await expect(deduplicatedResolution).resolves.toBe(replacementVault)
    expect(registry.getVault(VAULT_ADDRESS)).toBe(replacementVault)
  })
})
