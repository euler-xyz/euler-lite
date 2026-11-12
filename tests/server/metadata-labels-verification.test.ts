import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { normalizeLabelsBundle } from '~/utils/public-labels'
import { publicLabelsFixture, KPK_VAULT } from '~/tests/fixtures/public-labels-v20260804151305236'

const mocks = vi.hoisted(() => ({ labels: vi.fn(), vaults: vi.fn(), types: vi.fn(), loadEulerChains: vi.fn(), catalog: { indexedChainIds: [] as number[] } }))
vi.mock('~/server/utils/v3-chain-catalog', () => ({
  loadV3ChainCatalog: async () => mocks.catalog,
  peekV3ChainCatalog: () => mocks.catalog,
}))
vi.mock('~/server/api/internal/euler-chains.get', () => ({ loadEulerChains: mocks.loadEulerChains }))
vi.mock('~/server/utils/public-labels-source', () => ({ getPublicEulerLabelsData: mocks.labels }))
vi.mock('~/server/utils/sdk-server', () => ({ getServerSdk: async () => ({
  eVaultService: { fetchVerifiedVaultAddresses: async () => [], fetchVaults: mocks.vaults },
  eulerEarnService: { fetchVaults: async () => ({ result: [], errors: [] }) },
  securitizeVaultService: { fetchVaults: async () => ({ result: [], errors: [] }) },
  vaultMetaService: { fetchVaultTypes: mocks.types },
}) }))

describe('public API metadata-only governance verification', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('RPC_URL_1', 'https://rpc.example')
    vi.stubEnv('LABELS_SOURCE', 'v3')
    vi.stubEnv('DEPRECATED_CHAINS', '')
    vi.stubEnv('ONCHAIN_SDK_CHAINS', '')
    mocks.loadEulerChains.mockResolvedValue([{ chainId: 1, status: 'deprecated' }])
    mocks.catalog = { indexedChainIds: [] }
    vi.stubGlobal('$fetch', vi.fn(async () => ({ tokens: [] })))
    mocks.types.mockResolvedValue({})
    mocks.labels.mockResolvedValue(normalizeLabelsBundle(1, {
      source: 'v3-metadata', labelSet: 'public', version: 'pinned', publicLabels: publicLabelsFixture, sourceFetchedAt: Date.now(),
    }))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('invalidates warm verification and metadata caches on catalog retirement and reactivation', async () => {
    const labels = await mocks.labels()
    const vault = getAddress(KPK_VAULT)
    // The hosted assessment trusts this vault, but its live governor does not match the curator.
    mocks.vaults.mockResolvedValue({ result: [{ address: vault, governorAdmin: '0x0000000000000000000000000000000000000001', collaterals: [] }], errors: [] })
    mocks.labels.mockResolvedValue({ ...labels, source: 'v3', verifiedVaultAddresses: [vault] })
    mocks.catalog = { indexedChainIds: [1] }
    const { getVerifiedAddressSet } = await import('~/server/utils/verified-vaults')
    const { getChainVaultMetadata } = await import('~/server/utils/vault-metadata')
    expect((await getVerifiedAddressSet(1)).has(vault)).toBe(true)
    expect((await getChainVaultMetadata(1)).get(vault)?.entities.length).toBeGreaterThan(0)

    mocks.catalog = { indexedChainIds: [] }
    mocks.labels.mockResolvedValue(labels)
    expect((await getVerifiedAddressSet(1)).has(vault)).toBe(false)
    expect((await getChainVaultMetadata(1)).get(vault)?.entities).toEqual([])
    mocks.catalog = { indexedChainIds: [1] }
    mocks.labels.mockResolvedValue({ ...labels, source: 'v3', verifiedVaultAddresses: [vault] })
    expect((await getVerifiedAddressSet(1)).has(vault)).toBe(true)
    expect((await getChainVaultMetadata(1)).get(vault)?.entities.length).toBeGreaterThan(0)
  })

  it('does not serve stale assessments when the new metadata mode cannot load', async () => {
    const labels = await mocks.labels()
    const vault = getAddress(KPK_VAULT)
    mocks.vaults.mockResolvedValue({ result: [], errors: [] })
    mocks.labels.mockResolvedValue({ ...labels, source: 'v3', verifiedVaultAddresses: [vault] })
    mocks.catalog = { indexedChainIds: [1] }
    const { getVerifiedAddressSet } = await import('~/server/utils/verified-vaults')
    const { getChainVaultMetadata } = await import('~/server/utils/vault-metadata')
    await getVerifiedAddressSet(1)
    await getChainVaultMetadata(1)
    mocks.catalog = { indexedChainIds: [] }
    mocks.labels.mockRejectedValue(new Error('metadata unavailable'))
    await expect(getVerifiedAddressSet(1)).rejects.toThrow('metadata unavailable')
    await expect(getChainVaultMetadata(1)).rejects.toThrow('metadata unavailable')
  })
  it('fetches candidates with empty verified membership, then rejects mismatches and refreshed claim removal', async () => {
    const labels = await mocks.labels()
    const governor = Object.keys(labels.entities.kpk.addresses)[0]
    mocks.vaults.mockResolvedValue({ result: [{ address: getAddress(KPK_VAULT), governorAdmin: governor, collaterals: [] }], errors: [] })
    const { refreshVerifiedAddressSet } = await import('~/server/utils/verified-vaults')
    expect(labels.verifiedVaultAddresses).toEqual([])
    expect((await refreshVerifiedAddressSet(1)).has(getAddress(KPK_VAULT))).toBe(true)
    expect(mocks.vaults.mock.calls[0][1]).toContain(getAddress(KPK_VAULT))
    mocks.labels.mockResolvedValue({ ...labels, managingEntityByVault: {} })
    expect((await refreshVerifiedAddressSet(1)).has(getAddress(KPK_VAULT))).toBe(false)
    mocks.labels.mockResolvedValue(labels)
    mocks.vaults.mockResolvedValue({ result: [{ address: getAddress(KPK_VAULT), governorAdmin: '0x0000000000000000000000000000000000000001', collaterals: [] }], errors: [] })
    expect((await refreshVerifiedAddressSet(1)).has(getAddress(KPK_VAULT))).toBe(false)
  })
})
