import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { __setEulerLabelsDataForTest, useEulerLabels } from '~/composables/useEulerLabels'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { useVaults } from '~/composables/useVaults'

const LABELED_EVAULT = '0x0000000000000000000000000000000000000101'
const DYNAMIC_EVAULT = '0x0000000000000000000000000000000000000102'
const ESCROW_EVAULT = '0x0000000000000000000000000000000000000103'
const DEPRECATED_EVAULT = '0x0000000000000000000000000000000000000104'

const makeVault = (address: string): EVault => ({
  address: getAddress(address),
  collaterals: [],
}) as unknown as EVault

const fetchVaults = vi.fn()
const fetchVerifiedVaultAddresses = vi.fn()
const fetchVaultTypes = vi.fn()

describe('useVaults EVault verification metadata', () => {
  beforeEach(() => {
    fetchVaults.mockImplementation(async (_chainId: number, addresses: Address[]) => ({
      errors: [],
      result: addresses.map(address => makeVault(address)),
    }))
    fetchVerifiedVaultAddresses.mockResolvedValue([])
    fetchVaultTypes.mockResolvedValue({})

    vi.stubGlobal('useEulerAddresses', () => ({
      chainId: ref(1),
    }))
    vi.stubGlobal('useEulerLabels', useEulerLabels)
    vi.stubGlobal('useEulerSdk', () => ({
      getEulerSdk: vi.fn(async () => ({
        eVaultService: { fetchVaults, fetchVerifiedVaultAddresses },
        vaultMetaService: { fetchVaultTypes },
      })),
    }))

    __setEulerLabelsDataForTest()
    const vaults = useVaults()
    vaults.setShowAllLabelEntries(false)
    vaults.resetVaultsState()
  })

  afterEach(() => {
    useVaultRegistry().clear()
    vi.unstubAllGlobals()
  })

  it('keeps EVault batches out of verified lists unless explicitly display-verified', async () => {
    await useVaults().updateEVaults([LABELED_EVAULT], undefined, true)

    const registry = useVaultRegistry()
    expect(registry.get(LABELED_EVAULT)?.verified).toBe(false)
    expect(registry.getVerifiedEVaults()).toEqual([])
  })

  it('marks display-verified EVault batches verified', async () => {
    await useVaults().updateEVaults([LABELED_EVAULT], undefined, true, {
      verifiedAddresses: new Set([getAddress(LABELED_EVAULT).toLowerCase()]),
    })

    const registry = useVaultRegistry()
    expect(registry.get(LABELED_EVAULT)?.verified).toBe(true)
    expect(registry.getVerifiedEVaults().map(vault => vault.address)).toEqual([getAddress(LABELED_EVAULT)])
  })

  it('marks all label-loaded EVaults verified, including deprecated label entries', async () => {
    __setEulerLabelsDataForTest({
      verifiedVaultAddresses: [getAddress(LABELED_EVAULT), getAddress(DEPRECATED_EVAULT)],
    })

    const vaults = useVaults()
    vaults.setShowAllLabelEntries(true)
    await vaults.loadVaults()

    const registry = useVaultRegistry()
    expect(registry.getVerifiedEVaults(true).map(vault => vault.address)).toEqual([
      getAddress(LABELED_EVAULT),
      getAddress(DEPRECATED_EVAULT),
    ])
  })

  it('keeps dynamically resolved off-label EVaults out of verified EVault lists', async () => {
    await useVaults().updateEVaults([DYNAMIC_EVAULT], undefined, true)

    const registry = useVaultRegistry()
    expect(registry.get(DYNAMIC_EVAULT)?.verified).toBe(false)
    expect(registry.getVerifiedEVaults()).toEqual([])
  })

  it('always treats known escrow EVaults as verified', async () => {
    const registry = useVaultRegistry()
    registry.setEscrowAddresses([ESCROW_EVAULT])

    await useVaults().updateEVaults([ESCROW_EVAULT], undefined, true)

    expect(registry.get(ESCROW_EVAULT)?.verified).toBe(true)
    expect(registry.get(ESCROW_EVAULT)?.vaultCategory).toBe('escrow')
    expect(registry.getVerifiedEVaults().map(vault => vault.address)).toEqual([getAddress(ESCROW_EVAULT)])
  })

  it('preserves registry verification only when refresh metadata omits it', () => {
    const registry = useVaultRegistry()
    registry.set(LABELED_EVAULT, makeVault(LABELED_EVAULT), 'evk', { verified: true, vaultCategory: 'escrow' })

    registry.set(LABELED_EVAULT, makeVault(LABELED_EVAULT), 'evk')
    expect(registry.get(LABELED_EVAULT)?.verified).toBe(true)
    expect(registry.get(LABELED_EVAULT)?.vaultCategory).toBe('escrow')

    registry.set(LABELED_EVAULT, makeVault(LABELED_EVAULT), 'evk', { verified: false, vaultCategory: 'standard' })
    expect(registry.get(LABELED_EVAULT)?.verified).toBe(false)
    expect(registry.get(LABELED_EVAULT)?.vaultCategory).toBe('standard')
    expect(registry.getVerifiedEVaults()).toEqual([])
  })
})
