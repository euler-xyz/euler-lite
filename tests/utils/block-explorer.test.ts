import { beforeEach, describe, expect, it, vi } from 'vitest'

const { CHAIN_ID, CHAIN_EXPLORER, MAINNET_EXPLORER, mocks } = vi.hoisted(() => {
  const CHAIN_ID = 424242
  const CHAIN_EXPLORER = 'https://chain-explorer.example/'
  const MAINNET_EXPLORER = 'https://mainnet-explorer.example/'
  return {
    CHAIN_ID,
    CHAIN_EXPLORER,
    MAINNET_EXPLORER,
    mocks: {
      explorerUrls: undefined as Record<number, string> | undefined,
      chains: new Map([
        [1, { blockExplorers: { default: { name: 'Mainnet Explorer', url: MAINNET_EXPLORER } } }],
        [CHAIN_ID, { blockExplorers: { default: { name: 'Chain Explorer', url: CHAIN_EXPLORER } } }],
      ]),
    },
  }
})

vi.mock('~/composables/useChainConfig', () => ({
  useChainConfig: () => ({ explorerUrls: mocks.explorerUrls }),
}))

vi.mock('~/entities/chainRegistry', () => ({
  getChainById: (chainId: number) => mocks.chains.get(chainId),
}))

const { getExplorerLink } = await import('~/utils/block-explorer')

const REGISTRY_EXPLORER = 'https://registry-explorer.example'
const OTHER_CHAIN_ID = 424243
const ADDRESS = `0x${'ab'.repeat(20)}`
const TX_HASH = `0x${'cd'.repeat(32)}`

describe('getExplorerLink', () => {
  beforeEach(() => {
    mocks.explorerUrls = undefined
  })

  it('prefers the registry explorer URL for a chain', () => {
    mocks.explorerUrls = { [CHAIN_ID]: REGISTRY_EXPLORER }

    expect(getExplorerLink(ADDRESS, CHAIN_ID, true)).toBe(`${REGISTRY_EXPLORER}/address/${ADDRESS}`)
    expect(getExplorerLink(TX_HASH, CHAIN_ID)).toBe(`${REGISTRY_EXPLORER}/tx/${TX_HASH}`)
    expect(getExplorerLink(undefined, CHAIN_ID)).toBe(`${REGISTRY_EXPLORER}/`)
  })

  it('falls back to the chain registry explorer when the registry has none', () => {
    mocks.explorerUrls = { [OTHER_CHAIN_ID]: REGISTRY_EXPLORER }

    expect(getExplorerLink(ADDRESS, CHAIN_ID, true)).toBe(`${CHAIN_EXPLORER}address/${ADDRESS}`)
    expect(getExplorerLink(TX_HASH, 1)).toBe(`${MAINNET_EXPLORER}tx/${TX_HASH}`)
  })

  it('falls back to the chain registry explorer when no registry URLs were injected', () => {
    expect(getExplorerLink(ADDRESS, CHAIN_ID, true)).toBe(`${CHAIN_EXPLORER}address/${ADDRESS}`)
  })

  it('falls back to the mainnet explorer for an unknown chain', () => {
    expect(getExplorerLink(TX_HASH, OTHER_CHAIN_ID)).toBe(`${MAINNET_EXPLORER}tx/${TX_HASH}`)
    expect(getExplorerLink(TX_HASH)).toBe(`${MAINNET_EXPLORER}tx/${TX_HASH}`)
  })
})
