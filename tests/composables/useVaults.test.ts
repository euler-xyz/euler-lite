import type { EVault, EulerEarn } from '@eulerxyz/euler-v2-sdk'
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
const VISIBLE_WETH_EVAULT = '0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2'
const HIDDEN_WETH_LENDING_EVAULT = '0x2ff5F1Ca35f5100226ac58E1BFE5aac56919443B'
const HIDDEN_TELOSC_WORMHOLE_EVAULT = '0x2e6Dff8907aFdA5D62A278e21B2e65c8595D746E'
const BASE_EARN_VAULT = '0x8bF41Ad2b816F7c220b22F4BCD63fC2A35Ab4247'

const makeVault = (address: string, targetChainId = 1): EVault => ({
  chainId: targetChainId,
  address: getAddress(address),
  collaterals: [],
}) as unknown as EVault

const makeEarnVault = (address: string, targetChainId = 1): EulerEarn => ({
  chainId: targetChainId,
  address: getAddress(address),
}) as unknown as EulerEarn

const fetchVaults = vi.fn()
const fetchEarnVaults = vi.fn()
const fetchEarnVault = vi.fn()
const fetchVerifiedVaultAddresses = vi.fn()
const fetchVaultTypes = vi.fn()
const chainId = ref(1)

describe('useVaults EVault verification metadata', () => {
  beforeEach(() => {
    fetchVaults.mockReset()
    fetchEarnVaults.mockReset()
    fetchEarnVault.mockReset()
    fetchVerifiedVaultAddresses.mockReset()
    fetchVaultTypes.mockReset()

    fetchVaults.mockImplementation(async (targetChainId: number, addresses: Address[]) => ({
      errors: [],
      result: addresses.map(address => makeVault(address, targetChainId)),
    }))
    fetchEarnVaults.mockResolvedValue({ errors: [], result: [] })
    fetchEarnVault.mockImplementation(async (targetChainId: number, address: Address) => ({
      errors: [],
      result: makeEarnVault(address, targetChainId),
    }))
    fetchVerifiedVaultAddresses.mockResolvedValue([])
    fetchVaultTypes.mockResolvedValue({})
    chainId.value = 1

    vi.stubGlobal('useEulerAddresses', () => ({
      chainId,
    }))
    vi.stubGlobal('useChainConfig', () => ({
      deprecatedChainIds: [],
      eVaultFetchChunkChainIds: [],
    }))
    vi.stubGlobal('useEulerLabels', useEulerLabels)
    const sdk = {
      eVaultService: { fetchVaults, fetchVerifiedVaultAddresses },
      eulerEarnService: { fetchVaults: fetchEarnVaults, fetchVault: fetchEarnVault },
      vaultMetaService: { fetchVaultTypes },
    }
    vi.stubGlobal('useEulerSdk', () => ({
      getEulerSdk: vi.fn(async () => sdk),
      getEulerSdkForChain: vi.fn(async () => sdk),
    }))

    __setEulerLabelsDataForTest()
    const vaults = useVaults()
    vaults.setShowAllLabelEntries(false)
    vaults.resetVaultsState()
  })

  afterEach(() => {
    vi.useRealTimers()
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

  it('hides not-explorable deprecated WETH lend vaults unless showAll is enabled', () => {
    __setEulerLabelsDataForTest({
      products: {
        'euler-prime': {
          name: 'Euler Prime',
          description: '',
          entity: 'euler',
          url: '',
          vaults: [getAddress(VISIBLE_WETH_EVAULT)],
          deprecatedVaults: [],
        },
        'origin-arm-weth': {
          name: 'Origin stETH ARM / WETH',
          description: '',
          entity: 'alphagrowth',
          url: '',
          vaults: [],
          deprecatedVaults: [getAddress(HIDDEN_WETH_LENDING_EVAULT)],
          notExplorable: true,
        },
        'telosc-wormhole': {
          name: 'TelosC Wormhole',
          description: '',
          entity: 'telosc',
          url: '',
          vaults: [],
          deprecatedVaults: [getAddress(HIDDEN_TELOSC_WORMHOLE_EVAULT)],
          notExplorable: true,
        },
      },
    })

    const registry = useVaultRegistry()
    registry.setMany(
      [VISIBLE_WETH_EVAULT, HIDDEN_WETH_LENDING_EVAULT, HIDDEN_TELOSC_WORMHOLE_EVAULT].map(address => ({
        address,
        vault: makeVault(address),
        type: 'evk' as const,
        verified: true,
      })),
    )

    expect(registry.getVerifiedEVaults().map(vault => vault.address)).toEqual([
      getAddress(VISIBLE_WETH_EVAULT),
    ])
    expect(registry.getVerifiedEVaults(true).map(vault => vault.address)).toEqual([
      getAddress(VISIBLE_WETH_EVAULT),
      getAddress(HIDDEN_WETH_LENDING_EVAULT),
      getAddress(HIDDEN_TELOSC_WORMHOLE_EVAULT),
    ])
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

  it('chunks EVault fetches for configured chunk chains', async () => {
    const addresses = Array.from(
      { length: 7 },
      (_, index) => getAddress(`0x${(0x200 + index).toString(16).padStart(40, '0')}`),
    )
    vi.stubGlobal('useChainConfig', () => ({
      deprecatedChainIds: [],
      eVaultFetchChunkChainIds: [1],
    }))

    await useVaults().updateEVaults(addresses, undefined, true, {
      verifiedAddresses: new Set(addresses.map(address => address.toLowerCase())),
    })

    expect(fetchVaults).toHaveBeenCalledTimes(2)
    expect(fetchVaults.mock.calls.map(([, fetched]) => fetched)).toEqual([
      addresses.slice(0, 6),
      addresses.slice(6),
    ])
    expect(useVaultRegistry().getVerifiedEVaults(true).map(vault => vault.address)).toEqual(addresses)
  })

  it('does not chunk deprecated chains unless chunking is configured', async () => {
    const addresses = Array.from(
      { length: 7 },
      (_, index) => getAddress(`0x${(0x300 + index).toString(16).padStart(40, '0')}`),
    )
    vi.stubGlobal('useChainConfig', () => ({
      deprecatedChainIds: [1],
      eVaultFetchChunkChainIds: [],
    }))

    await useVaults().updateEVaults(addresses, undefined, true)

    expect(fetchVaults).toHaveBeenCalledTimes(1)
    expect(fetchVaults.mock.calls[0]?.[1]).toEqual(addresses)
  })

  it('does not fetch stale Earn vault addresses after a chain switch invalidates the load', async () => {
    chainId.value = 8453
    __setEulerLabelsDataForTest({
      earnVaults: [getAddress(BASE_EARN_VAULT)],
    })
    fetchVaultTypes.mockImplementationOnce(async () => {
      chainId.value = 1
      useVaults().resetVaultsState()
      return {}
    })

    await useVaults().loadVaults()

    expect(fetchEarnVaults).not.toHaveBeenCalled()
  })

  it('falls back to direct fetch when a known Earn vault never reaches the registry', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('until', () => ({
      toMatch: vi.fn(() => new Promise<void>(() => undefined)),
    }))
    __setEulerLabelsDataForTest({
      earnVaults: [getAddress(BASE_EARN_VAULT)],
    })

    const promise = useVaults().getEarnVault(BASE_EARN_VAULT)
    await vi.advanceTimersByTimeAsync(10_000)
    const vault = await promise

    expect(vault.address).toBe(getAddress(BASE_EARN_VAULT))
    expect(fetchEarnVault).toHaveBeenCalledWith(
      1,
      getAddress(BASE_EARN_VAULT),
      expect.objectContaining({
        populateMarketPrices: true,
        populateStrategyVaults: true,
      }),
    )
    expect(useVaultRegistry().get(BASE_EARN_VAULT)?.type).toBe('earn')
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
