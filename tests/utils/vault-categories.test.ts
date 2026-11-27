import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultType } from '@eulerxyz/euler-v2-sdk'
import { ref } from 'vue'
import { fetchChainVaultCategories, fetchVaultCategory, resetVaultCategoryCache } from '~/utils/vault/categories'

const VAULT = '0x0000000000000000000000000000000000000001'
const escrow = vi.fn()
const type = vi.fn()
const types = vi.fn()
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('vault category cache invalidation', () => {
  beforeEach(() => {
    resetVaultCategoryCache()
    escrow.mockReset().mockResolvedValue([])
    type.mockReset()
    types.mockReset()
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('useEulerLabels', () => ({ verifiedVaultAddresses: ref([VAULT]), earnVaults: ref([]) }))
    vi.stubGlobal('useEulerSdk', () => ({ getEulerSdkForChain: async () => ({
      eVaultService: { fetchVerifiedVaultAddresses: escrow },
      vaultMetaService: { fetchVaultType: type, fetchVaultTypes: types },
    }) }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('does not let an earlier address resolution overwrite the refreshed cache', async () => {
    const old = deferred<VaultType>()
    type.mockReturnValueOnce(old.promise).mockResolvedValueOnce(VaultType.SecuritizeCollateral)
    const pending = fetchVaultCategory(VAULT, 1)
    await vi.waitFor(() => expect(type).toHaveBeenCalledOnce())
    resetVaultCategoryCache()
    expect(await fetchVaultCategory(VAULT, 1)).toBe('securitize')
    old.resolve(VaultType.EVault)
    await pending
    expect(await fetchVaultCategory(VAULT, 1)).toBe('securitize')
    expect(type).toHaveBeenCalledTimes(2)
  })

  it('does not restore an invalidated escrow set', async () => {
    const old = deferred<string[]>()
    escrow.mockReturnValueOnce(old.promise)
    type.mockResolvedValue(VaultType.EVault)
    const pending = fetchVaultCategory(VAULT, 1)
    await vi.waitFor(() => expect(escrow).toHaveBeenCalledOnce())
    resetVaultCategoryCache()
    expect(await fetchVaultCategory(VAULT, 1)).toBe('evk')
    old.resolve([VAULT])
    await pending
    expect(await fetchVaultCategory(VAULT, 1)).toBe('evk')
  })

  it('keeps replacement catalogue requests deduplicated when earlier work finishes', async () => {
    const old = deferred<Record<string, VaultType>>()
    const current = deferred<Record<string, VaultType>>()
    types.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const first = fetchChainVaultCategories()
    await vi.waitFor(() => expect(types).toHaveBeenCalledOnce())
    resetVaultCategoryCache()
    const replacement = fetchChainVaultCategories()
    await vi.waitFor(() => expect(types).toHaveBeenCalledTimes(2))
    old.resolve({ [VAULT]: VaultType.EVault })
    await first
    const joined = fetchChainVaultCategories()
    current.resolve({ [VAULT]: VaultType.SecuritizeCollateral })
    await Promise.all([replacement, joined])
    expect(await fetchVaultCategory(VAULT, 1)).toBe('securitize')
    expect(types).toHaveBeenCalledTimes(2)
  })
})
