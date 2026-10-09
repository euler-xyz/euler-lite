import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyEulerLabelsData } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { normalizePublicLabelsData } from '~/utils/public-labels'
import { KPK_VAULT, publicLabelsFixture } from '~/tests/fixtures/public-labels-v20260804151305236'
import { buildLabelsView, buildProductDescriptors, buildTokenLogoMap, fetchTokenList } from '~/server/utils/labels-view'
import { getServerSdk } from '~/server/utils/sdk-server'
import { refreshVerifiedAddressSet } from '~/server/utils/verified-vaults'
import { refreshChainVaultMetadata } from '~/server/utils/vault-metadata'
import { getInternalFetchHeaders } from '~/server/utils/internal-headers'
import { getPublicEulerLabelsData } from '~/server/utils/public-labels-source'

vi.mock('~/server/utils/sdk-server', () => ({ getServerSdk: vi.fn() }))
vi.mock('~/server/utils/public-labels-source', () => ({ getPublicEulerLabelsData: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchTokenList', () => {
  it('decorates the internal token-list fetch with the loopback sentinel', async () => {
    const fetch = vi.fn().mockResolvedValue({
      tokens: [
        { address: '0x1111111111111111111111111111111111111111', logoURI: 'https://cdn.example/token.png' },
      ],
    })
    vi.stubGlobal('$fetch', fetch)

    await expect(fetchTokenList(1)).resolves.toEqual([
      { address: '0x1111111111111111111111111111111111111111', logoURI: 'https://cdn.example/token.png' },
    ])
    expect(fetch).toHaveBeenCalledWith('/api/internal/token-list', {
      query: { chainId: 1 },
      headers: getInternalFetchHeaders(),
    })
  })
})

describe('buildTokenLogoMap', () => {
  it('keeps only http(s) logo URLs', () => {
    const map = buildTokenLogoMap([
      { address: '0x1111111111111111111111111111111111111111', logoURI: 'https://cdn.example/token.png' },
      { address: '0x2222222222222222222222222222222222222222', logoURI: 'http://cdn.example/token.png' },
      { address: '0x3333333333333333333333333333333333333333', logoURI: 'javascript:alert(1)' },
      { address: '0x4444444444444444444444444444444444444444', logoURI: 'data:image/svg+xml,<svg />' },
      { address: '0x5555555555555555555555555555555555555555', logoURI: '/relative-token.png' },
      { address: '0x6666666666666666666666666666666666666666', logoURI: 'not a url' },
    ])

    expect(map.get('0x1111111111111111111111111111111111111111')).toBe('https://cdn.example/token.png')
    expect(map.get('0x2222222222222222222222222222222222222222')).toBe('http://cdn.example/token.png')
    expect(map.has('0x3333333333333333333333333333333333333333')).toBe(false)
    expect(map.has('0x4444444444444444444444444444444444444444')).toBe(false)
    expect(map.has('0x5555555555555555555555555555555555555555')).toBe(false)
    expect(map.has('0x6666666666666666666666666666666666666666')).toBe(false)
  })
})

describe('buildProductDescriptors', () => {
  it('applies governance-limited vault override tags per vault', () => {
    const limitedVault = '0x0000000000000000000000000000000000000701'
    const standardVault = '0x0000000000000000000000000000000000000702'

    const { productByVault } = buildProductDescriptors({
      test: {
        name: 'Test',
        description: '',
        entity: [],
        url: '',
        vaults: [limitedVault, standardVault],
        vaultOverrides: {
          [limitedVault]: {
            tags: ['governance limited'],
          },
        },
      },
    })

    expect(productByVault.get(limitedVault)?.governanceLimited).toBe(true)
    expect(productByVault.get(standardVault)?.governanceLimited).toBe(false)
  })

  it('keeps annotation-only EVK notices and deprecation without inventing a product', () => {
    const address = '0x0000000000000000000000000000000000000703'
    const { productByVault, deprecatedSet } = buildProductDescriptors({}, {
      [address.toLowerCase()]: {
        deprecated: true, deprecationReason: 'Retired', portfolioNotice: 'Withdraw when possible',
        tags: ['governance limited'],
      },
    })
    expect(productByVault.get(address)).toMatchObject({
      slug: null, name: '', portfolioNotice: 'Withdraw when possible',
      deprecationReason: 'Retired', governanceLimited: true,
    })
    expect(deprecatedSet.has(address)).toBe(true)
  })
})

describe('SDK escrow classification in public views', () => {
  it('keeps public metadata and perspective trust independent of classification and deployment tags', async () => {
    const flagged = '0x0000000000000000000000000000000000000001'
    const standard = '0x0000000000000000000000000000000000000002'
    const unknown = '0x0000000000000000000000000000000000000003'
    const unloaded = '0x0000000000000000000000000000000000000004'
    const flags: Record<string, boolean | null> = { [flagged]: true, [standard]: false, [unknown]: null }
    vi.stubGlobal('$fetch', vi.fn(async () => ({ tokens: [] })))
    vi.mocked(getPublicEulerLabelsData).mockResolvedValue({
      ...createEmptyEulerLabelsData(),
      verifiedVaultAddresses: [flagged, standard, unknown],
      rawGeoPolicies: [],
      vaultTagAddresses: new Set(),
    })
    vi.mocked(getServerSdk).mockResolvedValue({
      vaultMetaService: { fetchVaultTypes: async () => ({}) },
      eVaultService: {
        fetchVerifiedVaultAddresses: async () => [standard, unknown, unloaded],
        fetchVaults: async (_chain: number, addresses: string[]) => ({ errors: [], result: addresses.map(address => ({
          address, isEscrow: flags[address], collaterals: [], shares: { name: 'Normal vault' },
        })) }),
      },
    } as never)
    const view = await buildLabelsView(991)
    expect(view.snapshot.escrowVaults.map(vault => vault.address)).toEqual([flagged])
    expect(view.snapshot.evkVaults.find(vault => vault.address === standard)).toMatchObject({ vaultCategory: 'standard' })
    expect(view.snapshot.evkVaults.find(vault => vault.address === unknown)).toMatchObject({ isEscrow: null, vaultCategory: undefined })
    expect(view.escrowAddresses).toEqual(new Set([standard, unknown, unloaded]))

    const verified = await refreshVerifiedAddressSet(991)
    expect(verified).toEqual(new Set([standard, unknown, unloaded]))
    expect(verified.has(flagged)).toBe(false)

    const metadata = await refreshChainVaultMetadata(991)
    expect(metadata.get(standard)?.name).toBe('Normal vault')
    expect(metadata.get(unknown)?.name).toBe('Normal vault')
    expect(metadata.get(flagged)?.name).not.toBe('Normal vault')
    expect(metadata.has(unloaded)).toBe(true)
  })
})

describe('V3 public verification', () => {
  it('keeps a published hidden vault in metadata without manager attribution', async () => {
    const source = structuredClone(publicLabelsFixture)
    source.visibility[KPK_VAULT.toLowerCase()] = {
      status: 'hidden', explorableLend: false, explorableBorrow: false, decidedBy: 'config-failed', reason: 'Config failed',
    }
    vi.stubGlobal('$fetch', vi.fn(async () => ({ tokens: [] })))
    vi.mocked(getPublicEulerLabelsData).mockResolvedValue({
      ...normalizePublicLabelsData(1, source), sourceFetchedAt: Date.now(),
    })
    vi.mocked(getServerSdk).mockResolvedValue({
      vaultMetaService: { fetchVaultTypes: async () => ({}) },
      eVaultService: {
        fetchVerifiedVaultAddresses: async () => [],
        fetchVaults: async (_chain: number, addresses: string[]) => ({
          errors: [], result: addresses.map(address => ({ address, collaterals: [], shares: { name: 'On-chain name' } })),
        }),
      },
      eulerEarnService: { fetchVaults: async () => ({ errors: [], result: [] }) },
      securitizeVaultService: { fetchVaults: async () => ({ errors: [], result: [] }) },
    } as never)

    const verified = await refreshVerifiedAddressSet(1)
    expect(verified.has(getAddress(KPK_VAULT))).toBe(false)
    const metadata = await refreshChainVaultMetadata(1)
    expect(metadata.get(getAddress(KPK_VAULT))).toMatchObject({
      name: 'KPK VBILL/USDC Lend',
      description: 'USDC lending vault for the KPK VBILL market.',
      entities: [],
    })
  })

  it('uses published membership even when the local governor cannot be resolved', async () => {
    const listed = '0x0000000000000000000000000000000000000801'
    const hidden = '0x0000000000000000000000000000000000000802'
    vi.stubGlobal('$fetch', vi.fn(async () => ({ tokens: [] })))
    vi.mocked(getPublicEulerLabelsData).mockResolvedValue({
      ...createEmptyEulerLabelsData(),
      source: 'v3',
      sourceFetchedAt: Date.now(),
      verifiedVaultAddresses: [listed],
      candidateVaultAddresses: [listed, hidden],
      managingEntityByVault: { [listed.toLowerCase()]: 'curator' },
      entities: { curator: {
        name: 'Curator', logo: '', description: '', url: '', addresses: {},
        social: { twitter: '', youtube: '', discord: '', telegram: '', github: '' },
      } },
      rawGeoPolicies: [],
    })
    vi.mocked(getServerSdk).mockResolvedValue({
      vaultMetaService: { fetchVaultTypes: async () => ({}) },
      eVaultService: {
        fetchVerifiedVaultAddresses: async () => [],
        fetchVaults: async (_chain: number, addresses: string[]) => ({
          errors: [], result: addresses.map(address => ({ address, collaterals: [], governorAdmin: undefined, shares: { name: address === hidden ? 'Hidden vault' : 'Listed vault' } })),
        }),
      },
    } as never)

    const verified = await refreshVerifiedAddressSet(992)
    expect(verified.has(listed)).toBe(true)
    expect(verified.has(hidden)).toBe(false)
    const metadata = await refreshChainVaultMetadata(992)
    expect(metadata.get(listed)?.entities.map(entity => entity.name)).toEqual(['Curator'])
    expect(metadata.get(hidden)).toMatchObject({ name: 'Hidden vault', entities: [] })
  })
})
