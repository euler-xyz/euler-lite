import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EVault as SdkEVault, type IEVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import type { SerialisedSnapshot } from '~/server/utils/vaults-cache'

const VAULTS = [
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000002',
  '0x0000000000000000000000000000000000000003',
  '0x0000000000000000000000000000000000000004',
  '0x0000000000000000000000000000000000000005',
  '0x0000000000000000000000000000000000000006',
  '0x0000000000000000000000000000000000000007',
] as const

const mocks = vi.hoisted(() => ({
  fetchVaults: vi.fn(),
  fetchVerifiedVaultAddresses: vi.fn(),
  fetchVaultTypes: vi.fn(),
  refreshLabelFile: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  readContract: vi.fn(),
}))

vi.mock('~/server/api/internal/labels/[file].get', () => ({
  LABEL_FILES: [],
  refreshLabelFile: mocks.refreshLabelFile,
}))

vi.mock('~/server/utils/sdk-server', () => ({
  getServerSdk: vi.fn(async () => ({
    eVaultService: {
      fetchVaults: mocks.fetchVaults,
      fetchVerifiedVaultAddresses: mocks.fetchVerifiedVaultAddresses,
    },
    eulerEarnService: {
      fetchVaults: vi.fn(async () => ({ result: [], errors: [] })),
    },
    securitizeVaultService: {
      fetchVaults: vi.fn(async () => ({ result: [], errors: [] })),
    },
    vaultMetaService: {
      fetchVaultTypes: mocks.fetchVaultTypes,
    },
    providerService: {
      getProvider: vi.fn(() => ({ readContract: mocks.readContract })),
    },
  })),
}))

vi.mock('~/server/utils/logger', () => ({
  logger: {
    warn: mocks.warn,
    error: mocks.error,
  },
}))

describe('vaults cache', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.fetchVaults.mockReset()
    mocks.fetchVerifiedVaultAddresses.mockReset()
    mocks.fetchVaultTypes.mockReset()
    mocks.refreshLabelFile.mockReset()
    mocks.warn.mockReset()
    mocks.error.mockReset()
    mocks.readContract.mockReset()
    process.env.EVAULT_FETCH_CHUNK_CHAINS = '146'

    mocks.fetchVerifiedVaultAddresses.mockResolvedValue([])
    mocks.fetchVaultTypes.mockResolvedValue({})
    mocks.refreshLabelFile.mockImplementation(async (_scope, file) => {
      if (file === 'products.json') {
        return {
          test: {
            vaults: [...VAULTS],
          },
        }
      }
      return []
    })
  })

  it('does not replace the previous snapshot when a chunked eVault refresh throws', async () => {
    const { refreshChainVaults, vaultsCache } = await import('~/server/utils/vaults-cache')
    const previous: SerialisedSnapshot = {
      chainId: 146,
      fetchedAt: 123,
      evkVaults: [{ kind: 'evk', data: { address: VAULTS[0] } }],
      earnVaults: [],
      securitizeVaults: [],
      escrowVaults: [],
    }

    vaultsCache.set('146', previous)
    mocks.fetchVaults
      .mockResolvedValueOnce({
        result: VAULTS.slice(0, 6).map(address => ({ address })),
        errors: [],
      })
      .mockRejectedValueOnce(new Error('chunk failed'))

    await expect(refreshChainVaults(146)).rejects.toThrow('chunk failed')

    expect(vaultsCache.getStale('146')).toBe(previous)
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 146,
        chunkIndex: 1,
        chunkSize: 1,
        ctx: 'vaults-cache',
      }),
      'eVault chunk fetch failed',
    )
  })

  it('serialises resolved EulerRouter governance from real SDK EVaults', async () => {
    const router = getAddress('0x0000000000000000000000000000000000000101')
    const governor = getAddress('0x0000000000000000000000000000000000000102')
    const sdkVault = Object.assign(new SdkEVault({
      address: getAddress(VAULTS[0]),
      governorAdmin: governor,
      oracle: { oracle: router, name: 'EulerRouter' },
      asset: { address: router, symbol: 'TST', decimals: 18 },
      shares: { decimals: 18 },
      collaterals: [],
    } as unknown as IEVault), {
      type: 'EVault',
      caps: { supplyCap: 0n, borrowCap: 0n },
    })
    mocks.fetchVaults.mockImplementation(async (_chainId, addresses: string[]) => ({
      result: addresses.map(address => getAddress(address) === sdkVault.address ? sdkVault : { address }),
      errors: [],
    }))
    mocks.readContract.mockResolvedValue(governor)

    const { refreshChainVaults } = await import('~/server/utils/vaults-cache')
    const snapshot = await refreshChainVaults(1)
    const data = snapshot.evkVaults.find(entry =>
      (entry.data as { address?: string }).address === sdkVault.address,
    )?.data as { eulerRouterGovernor?: string }

    expect(data.eulerRouterGovernor).toBe(governor)
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: router,
      functionName: 'governor',
    }))
  })
})
