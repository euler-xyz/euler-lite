import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { getAddress } from 'viem'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

const { fetchVaultCategoryMock } = vi.hoisted(() => ({
  fetchVaultCategoryMock: vi.fn(),
}))

vi.mock('~/utils/vault/categories', () => ({
  fetchVaultCategory: fetchVaultCategoryMock,
}))

const VAULT = getAddress('0x00000000000000000000000000000000000000a1')
const ASSET_ONE = getAddress('0x00000000000000000000000000000000000000b1')
const ASSET_TWO = getAddress('0x00000000000000000000000000000000000000b2')
const chainId = ref<number | undefined>()

const vault = (asset: string) => ({
  type: 'EVault',
  address: VAULT,
  asset: { address: asset, name: 'Asset', symbol: 'AST', decimals: 18 },
  shares: { address: VAULT, name: 'Vault', symbol: 'vAST', decimals: 18 },
  totalShares: 0n,
  totalAssets: 0n,
})

describe('useVaultRegistry chain-scoped identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    chainId.value = undefined
    useVaultRegistry().clear()
    chainId.value = 1
  })

  it.each([1, 146])('uses SDK flags over discovered and cached categories on chain %s', (id) => {
    chainId.value = id
    const registry = useVaultRegistry()
    registry.setEscrowAddresses([VAULT])
    registry.set(VAULT, { ...vault(ASSET_ONE), isEscrow: false } as never, 'evk', {
      verified: true, vaultCategory: 'escrow',
    })
    expect(registry.getVaultCategory(VAULT)).toBe('standard')
    expect(registry.isEscrowVault(VAULT)).toBe(false)
    expect(registry.getEscrowVaults()).toEqual([])
    expect(registry.get(VAULT)?.verified).toBe(true)
    expect(registry.isKnownEscrowAddress(VAULT)).toBe(true)

    registry.setMany([{ address: VAULT, vault: { ...vault(ASSET_ONE), isEscrow: true } as never,
      type: 'evk', vaultCategory: 'standard' }])
    expect(registry.isEscrowVault(VAULT)).toBe(true)
    expect(registry.get(VAULT)?.verified).toBe(false)
    expect(registry.getEscrowVaults()).toHaveLength(1)

    registry.set(VAULT, { ...vault(ASSET_ONE), isEscrow: null } as never, 'evk')
    expect(registry.getVaultCategory(VAULT)).toBe('escrow')
    registry.setMany([{ address: VAULT, vault: vault(ASSET_ONE) as never, type: 'evk' }])
    expect(registry.getVaultCategory(VAULT)).toBe('escrow')
  })

  it('does not infer escrow categories for other vault types', () => {
    const registry = useVaultRegistry()
    registry.set(VAULT, { ...vault(ASSET_ONE), isEscrow: true } as never, 'earn')
    expect(registry.isEscrowVault(VAULT)).toBe(false)
    expect(registry.getVaultCategory(VAULT)).toBeUndefined()
  })

  it('keeps the same address isolated by chain', () => {
    const registry = useVaultRegistry()
    registry.set(VAULT, vault(ASSET_ONE) as never, 'evk')

    expect(registry.getVault(VAULT)?.asset.address).toBe(ASSET_ONE)

    chainId.value = 8453
    expect(registry.get(VAULT)).toBeUndefined()
    registry.set(VAULT, vault(ASSET_TWO) as never, 'evk')
    expect(registry.getVault(VAULT)?.asset.address).toBe(ASSET_TWO)

    chainId.value = 1
    expect(registry.getVault(VAULT)?.asset.address).toBe(ASSET_ONE)
  })

  it('registers against an explicitly captured chain after the active chain changes', () => {
    const registry = useVaultRegistry()
    chainId.value = 8453

    registry.set(VAULT, vault(ASSET_ONE) as never, 'evk', undefined, 1)

    expect(registry.get(VAULT)).toBeUndefined()
    chainId.value = 1
    expect(registry.getVault(VAULT)?.asset.address).toBe(ASSET_ONE)
  })

  it('exposes only the active chain escrow addresses', () => {
    const registry = useVaultRegistry()
    registry.setEscrowAddresses([VAULT], 1)
    registry.setEscrowAddresses([ASSET_TWO], 8453)

    expect(registry.escrowAddresses.value).toEqual(new Set([VAULT]))
    expect(registry.isKnownEscrowAddress(VAULT)).toBe(true)

    chainId.value = 8453
    expect(registry.escrowAddresses.value).toEqual(new Set([ASSET_TWO]))
    expect(registry.isKnownEscrowAddress(VAULT)).toBe(false)
  })

  it('drops an in-flight resolution after the active chain changes', async () => {
    let resolveCategory: (value: 'evk') => void = () => {}
    fetchVaultCategoryMock.mockImplementation(() => new Promise<'evk'>((resolve) => {
      resolveCategory = resolve
    }))
    const fetchVault = vi.fn()
    vi.stubGlobal('useEulerSdk', () => ({
      getEulerSdkForChain: vi.fn(async () => ({
        eVaultService: { fetchVault },
      })),
    }))
    const registry = useVaultRegistry()

    const pending = registry.getOrFetch(VAULT)
    chainId.value = 8453
    resolveCategory('evk')

    await expect(pending).resolves.toBeUndefined()
    expect(fetchVault).not.toHaveBeenCalled()

    chainId.value = 1
    expect(registry.get(VAULT)).toBeUndefined()
  })

  it('starts a fresh resolution after clearing the active chain', async () => {
    fetchVaultCategoryMock
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce('evk')
    const fetchVault = vi.fn(async () => ({
      result: vault(ASSET_ONE),
      errors: [],
    }))
    vi.stubGlobal('useEulerSdk', () => ({
      getEulerSdkForChain: vi.fn(async () => ({
        eVaultService: { fetchVault },
      })),
    }))
    const registry = useVaultRegistry()

    void registry.getOrFetch(VAULT)
    await Promise.resolve()
    registry.clear()

    await expect(registry.getOrFetch(VAULT)).resolves.toMatchObject({
      asset: { address: ASSET_ONE },
    })
    expect(fetchVaultCategoryMock).toHaveBeenCalledTimes(2)
  })
})
