import { beforeEach, describe, expect, it, vi } from 'vitest'
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
}))

vi.mock('@eulerxyz/euler-v2-sdk', () => ({
  StandardEVaultPerspectives: {
    ESCROW: 'escrow',
  },
  VaultType: {
    EulerEarn: 'EulerEarn',
    SecuritizeCollateral: 'SecuritizeCollateral',
  },
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
})
