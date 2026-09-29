import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { normalizeLabelsBundle } from '~/utils/public-labels'
import { publicLabelsFixture, KPK_VAULT } from '~/tests/fixtures/public-labels-v20260804151305236'

const mocks = vi.hoisted(() => ({ labels: vi.fn(), vaults: vi.fn(), types: vi.fn() }))
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
    vi.stubGlobal('$fetch', vi.fn(async () => ({ tokens: [] })))
    mocks.types.mockResolvedValue({})
    mocks.labels.mockResolvedValue(normalizeLabelsBundle(1, {
      source: 'v3-metadata', labelSet: 'public', version: 'pinned', publicLabels: publicLabelsFixture,
    }))
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
