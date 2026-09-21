import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildLabelsView, buildProductDescriptors, buildTokenLogoMap, fetchTokenList } from '~/server/utils/labels-view'
import { getServerSdk } from '~/server/utils/sdk-server'
import { refreshVerifiedAddressSet } from '~/server/utils/verified-vaults'
import { refreshChainVaultMetadata } from '~/server/utils/vault-metadata'
import { getInternalFetchHeaders } from '~/server/utils/internal-headers'

vi.mock('~/server/utils/sdk-server', () => ({ getServerSdk: vi.fn() }))

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
})

describe('SDK escrow classification in public views', () => {
  it('uses flags for presentation while retaining full perspective trust coverage', async () => {
    const flagged = '0x0000000000000000000000000000000000000001'
    const standard = '0x0000000000000000000000000000000000000002'
    const unknown = '0x0000000000000000000000000000000000000003'
    const unloaded = '0x0000000000000000000000000000000000000004'
    const flags: Record<string, boolean | null> = { [flagged]: true, [standard]: false, [unknown]: null }
    vi.stubGlobal('$fetch', vi.fn(async () => ({ tokens: [] })))
    vi.mocked(getServerSdk).mockResolvedValue({
      eulerLabelsService: { fetchEulerLabelsData: async () => ({
        verifiedVaultAddresses: [flagged, standard, unknown], earnVaults: [],
        products: {}, entities: {}, earnVaultEntries: {}, deprecatedEarnVaults: {},
      }) },
      vaultMetaService: { fetchVaultTypes: async () => ({}) },
      eVaultService: {
        fetchVerifiedVaultAddresses: async () => [standard, unknown, unloaded],
        fetchVaults: async (_chain: number, addresses: string[]) => ({ errors: [], result: addresses.map(address => ({
          address, isEscrow: flags[address], collaterals: [], shares: { name: 'Normal vault' },
        })) }),
      },
    } as never)
    const view = await buildLabelsView(991)
    expect(view.snapshot.escrowVaults.map(vault => vault.address)).toEqual([flagged, unknown])
    expect(view.snapshot.evkVaults.find(vault => vault.address === standard)).toMatchObject({ vaultCategory: 'standard' })
    expect(view.escrowAddresses).toEqual(new Set([standard, unknown, unloaded]))

    const verified = await refreshVerifiedAddressSet(991)
    expect(verified).toEqual(new Set([standard, unknown, unloaded]))
    expect(verified.has(flagged)).toBe(false)

    const metadata = await refreshChainVaultMetadata(991)
    expect(metadata.get(standard)?.name).toBe('Normal vault')
    expect(metadata.get(flagged)?.name).not.toBe('Normal vault')
    expect(metadata.has(unloaded)).toBe(true)
  })
})
