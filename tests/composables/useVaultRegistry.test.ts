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

const vault = (targetChainId: number, asset: string) => ({
  type: 'EVault',
  chainId: targetChainId,
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

  it('keeps the same address isolated by chain', () => {
    const registry = useVaultRegistry()
    registry.set(VAULT, vault(1, ASSET_ONE) as never, 'evk')

    expect(registry.getVault(VAULT)?.asset.address).toBe(ASSET_ONE)

    chainId.value = 8453
    expect(registry.get(VAULT)).toBeUndefined()
    registry.set(VAULT, vault(8453, ASSET_TWO) as never, 'evk')
    expect(registry.getVault(VAULT)?.asset.address).toBe(ASSET_TWO)

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
})
