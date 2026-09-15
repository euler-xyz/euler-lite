import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { normalizeLabelsBundle } from '~/utils/public-labels'
import { buildProductDescriptors } from '~/server/utils/labels-view'
import { publicLabelsFixture, KPK_VAULT } from '~/tests/fixtures/public-labels-v20260804151305236'

const mocks = vi.hoisted(() => ({ view: vi.fn() }))
vi.mock('~/server/utils/labels-view', async original => ({
  ...await original<typeof import('~/server/utils/labels-view')>(),
  buildLabelsView: mocks.view,
}))
vi.mock('~/server/utils/verified-vaults', () => ({ refreshVerifiedAddressSet: async () => new Set() }))

const address = getAddress(KPK_VAULT)

async function metadata(vaultType: 'evk' | 'earn', standalone = false, cleared = true) {
  const source = structuredClone(publicLabelsFixture)
  source.products[0].description = 'Product description'
  source.products[0].portfolioNotice = 'Product notice'
  source.products[0].deprecationReason = 'Product reason'
  source.vaults = [{ ...source.vaults[0], vaultType,
    productId: standalone ? null : source.products[0].id,
    name: 'Vault-specific name',
    description: cleared ? null : 'Vault description',
    portfolioNotice: cleared ? null : 'Vault notice',
    deprecationReason: cleared ? null : 'Vault reason',
  }]
  const labels = normalizeLabelsBundle(1, {
    source: 'v3-metadata', labelSet: 'public', version: 'test', publicLabels: source,
  })
  const vault = { address, shares: { name: 'On-chain name' } }
  mocks.view.mockResolvedValue({
    ...buildProductDescriptors(labels.products),
    snapshot: { evkVaults: vaultType === 'evk' ? [vault] : [], earnVaults: vaultType === 'earn' ? [vault] : [], securitizeVaults: [], escrowVaults: [] },
    deprecatedEarnSet: new Set(), escrowAddresses: new Set(),
    earnByAddr: new Map(Object.values(labels.earnVaultEntries).map(entry => [getAddress(entry.address), entry])),
    tokenLogos: new Map(), entitiesRaw: {},
  })
  const { refreshChainVaultMetadata } = await import('~/server/utils/vault-metadata')
  return (await refreshChainVaultMetadata(1)).get(address)
}

describe('public metadata resolved V3 content', () => {
  beforeEach(() => vi.resetModules())

  it.each(['evk', 'earn'] as const)('preserves cleared %s fields and the vault-specific name', async (type) => {
    expect(await metadata(type)).toMatchObject({
      name: 'Vault-specific name', description: null, portfolioNotice: null, deprecationReason: null,
      productId: 'kpk-securitize',
    })
  })

  it('keeps nonempty resolved vault text', async () => {
    expect(await metadata('evk', false, false)).toMatchObject({
      description: 'Vault description', portfolioNotice: 'Vault notice', deprecationReason: 'Vault reason',
    })
  })

  it('does not expose synthetic display groups as V3 product IDs', async () => {
    expect(await metadata('evk', true)).toMatchObject({ name: 'Vault-specific name', productId: null })
  })
})
