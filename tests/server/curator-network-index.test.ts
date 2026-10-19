import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicProductLabel, PublicVaultLabel } from '@eulerxyz/euler-v2-sdk/public-labels'
import { summarizeCuratorNetworks } from '~/server/utils/curator-network-index'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  peekEulerChains: vi.fn(),
  getEnabledChainIds: vi.fn(),
}))

vi.mock('~/server/utils/public-labels-source', () => ({ createPublicLabelsRequest: () => mocks.request }))
vi.mock('~/server/api/internal/euler-chains.get', () => ({ peekEulerChains: mocks.peekEulerChains }))
vi.mock('~/utils/chain-env', () => ({ getEnabledChainIds: mocks.getEnabledChainIds }))

describe('summarizeCuratorNetworks', () => {
  it('counts only owned products and Earn vaults on enabled chains', () => {
    const products = [
      { chainId: 1, entityId: 'k3-capital' },
      { chainId: 56, entityId: 'other', coBrandEntityIds: ['k3-capital'] },
      { chainId: 42161, entityId: 'k3-capital' },
      { chainId: 99999, entityId: 'k3-capital' },
    ] as PublicProductLabel[]
    const vaults = [
      { chainId: 1, entityId: 'k3-capital', vaultType: 'earn' },
      { chainId: 56, entityId: 'k3-capital', vaultType: 'evk' },
      { chainId: 56, entityId: 'other', vaultType: 'earn' },
      { chainId: 143, entityId: 'k3-capital', vaultType: 'earn' },
      { chainId: 99999, entityId: 'k3-capital', vaultType: 'earn' },
    ] as PublicVaultLabel[]

    expect(summarizeCuratorNetworks('k3-capital', [1, 56, 143, 42161], products, vaults)).toEqual([
      { chainId: 1, productCount: 1, earnVaultCount: 1 },
      { chainId: 143, productCount: 0, earnVaultCount: 1 },
      { chainId: 42161, productCount: 1, earnVaultCount: 0 },
    ])
  })
})

describe('getCuratorNetworkIndex', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('LABELS_SOURCE', 'v3')
    vi.stubEnv('LABELS_V3_SET', 'public')
    vi.stubEnv('LABELS_V3_VERSION', 'latest')
    vi.stubEnv('V3_API_URL', 'https://v3.example.test')
    vi.stubEnv('DISABLE_V3', 'false')
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    mocks.getEnabledChainIds.mockReturnValue([1, 56, 8453, 42161, 10])
    mocks.peekEulerChains.mockReturnValue([
      { chainId: 1, status: 'production' },
      { chainId: 56, status: 'unlisted' },
      { chainId: 8453, status: 'staging' },
      { chainId: 42161, status: 'deprecated' },
    ])
    mocks.request.mockReset().mockImplementation(async (path: string) => {
      if (path.endsWith('/versions')) {
        return { data: [{ versionKey: 'v20260929000000000', status: 'published', isLatest: true }] }
      }
      const data = path === '/labels/products'
        ? [1, 56, 8453, 42161, 10].map(chainId => ({ chainId, entityId: 'k3-capital' }))
        : [56, 42161].map(chainId => ({ chainId, entityId: 'k3-capital', vaultType: 'earn' }))
      return { data, meta: { total: data.length } }
    })
  })

  afterEach(() => vi.unstubAllEnvs())

  it('excludes unlisted, staging and unadmitted chains in production', async () => {
    const { getCuratorNetworkIndex } = await import('~/server/utils/curator-network-index')

    expect((await getCuratorNetworkIndex('k3-capital')).networks).toEqual([
      { chainId: 1, productCount: 1, earnVaultCount: 0 },
      { chainId: 42161, productCount: 1, earnVaultCount: 1 },
    ])
  })

  it('keeps staging chains selectable outside production', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'dev')
    const { getCuratorNetworkIndex } = await import('~/server/utils/curator-network-index')

    expect((await getCuratorNetworkIndex('k3-capital')).networks.map(network => network.chainId))
      .toEqual([1, 8453, 42161])
  })

  it('reapplies registry admission while the previous index is cached', async () => {
    const { getCuratorNetworkIndex } = await import('~/server/utils/curator-network-index')
    expect((await getCuratorNetworkIndex('k3-capital')).networks).toHaveLength(2)

    mocks.peekEulerChains.mockReturnValue([{ chainId: 1, status: 'production' }])

    expect((await getCuratorNetworkIndex('k3-capital')).networks).toEqual([
      { chainId: 1, productCount: 1, earnVaultCount: 0 },
    ])
  })

  it('uses configured chains when the manifest is unavailable, matching app configuration', async () => {
    mocks.peekEulerChains.mockReturnValue(undefined)
    const { getCuratorNetworkIndex } = await import('~/server/utils/curator-network-index')

    expect((await getCuratorNetworkIndex('k3-capital')).networks.map(network => network.chainId))
      .toEqual([1, 10, 56, 8453, 42161])
  })
})
