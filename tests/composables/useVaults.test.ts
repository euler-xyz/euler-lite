import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { useVaults } from '~/composables/useVaults'

const LABELED_EVAULT = '0x0000000000000000000000000000000000000101'
const DYNAMIC_EVAULT = '0x0000000000000000000000000000000000000102'
const ESCROW_EVAULT = '0x0000000000000000000000000000000000000103'

const makeVault = (address: string): EVault => ({
  address: getAddress(address),
  collaterals: [],
}) as unknown as EVault

const fetchVaults = vi.fn()

describe('useVaults EVault verification metadata', () => {
  beforeEach(() => {
    fetchVaults.mockImplementation(async (_chainId: number, addresses: Address[]) => ({
      errors: [],
      result: addresses.map(address => makeVault(address)),
    }))

    vi.stubGlobal('useEulerAddresses', () => ({
      chainId: ref(1),
    }))
    vi.stubGlobal('useEulerSdk', () => ({
      getEulerSdk: vi.fn(async () => ({
        eVaultService: { fetchVaults },
      })),
    }))

    useVaults().resetVaultsState()
  })

  afterEach(() => {
    useVaultRegistry().clear()
    vi.unstubAllGlobals()
  })

  it('marks label-backed EVault batches verified', async () => {
    await useVaults().updateEVaults([LABELED_EVAULT], undefined, true, { verified: true })

    const registry = useVaultRegistry()
    expect(registry.get(LABELED_EVAULT)?.verified).toBe(true)
    expect(registry.getVerifiedEVaults().map(vault => vault.address)).toEqual([getAddress(LABELED_EVAULT)])
  })

  it('keeps dynamically resolved off-label EVaults out of verified EVault lists', async () => {
    await useVaults().updateEVaults([DYNAMIC_EVAULT], undefined, true, { verified: false })

    const registry = useVaultRegistry()
    expect(registry.get(DYNAMIC_EVAULT)?.verified).toBe(false)
    expect(registry.getVerifiedEVaults()).toEqual([])
  })

  it('always treats known escrow EVaults as verified', async () => {
    const registry = useVaultRegistry()
    registry.setEscrowAddresses([ESCROW_EVAULT])

    await useVaults().updateEVaults([ESCROW_EVAULT], undefined, true, { verified: false })

    expect(registry.get(ESCROW_EVAULT)?.verified).toBe(true)
    expect(registry.get(ESCROW_EVAULT)?.vaultCategory).toBe('escrow')
    expect(registry.getVerifiedEVaults().map(vault => vault.address)).toEqual([getAddress(ESCROW_EVAULT)])
  })
})
