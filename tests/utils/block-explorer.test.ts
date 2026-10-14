import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  explorerUrls: undefined as Record<number, string> | undefined,
}))

vi.mock('~/composables/useChainConfig', () => ({
  useChainConfig: () => ({ explorerUrls: mocks.explorerUrls }),
}))

const { getExplorerLink } = await import('~/utils/block-explorer')

const ADDRESS = `0x${'ab'.repeat(20)}`
const TX_HASH = `0x${'cd'.repeat(32)}`

describe('getExplorerLink', () => {
  beforeEach(() => {
    mocks.explorerUrls = undefined
  })

  it('prefers the registry explorer URL for a chain', () => {
    mocks.explorerUrls = { 8453: 'https://registry-basescan.example' }

    expect(getExplorerLink(ADDRESS, 8453, true)).toBe(`https://registry-basescan.example/address/${ADDRESS}`)
    expect(getExplorerLink(TX_HASH, 8453)).toBe(`https://registry-basescan.example/tx/${TX_HASH}`)
    expect(getExplorerLink(undefined, 8453)).toBe('https://registry-basescan.example/')
  })

  it('falls back to the chain registry explorer when the registry has none', () => {
    mocks.explorerUrls = { 8453: 'https://registry-basescan.example' }

    expect(getExplorerLink(ADDRESS, 143, true)).toBe(`https://monadscan.com/address/${ADDRESS}`)
    expect(getExplorerLink(TX_HASH, 1)).toBe(`https://etherscan.io/tx/${TX_HASH}`)
  })

  it('falls back to the chain registry explorer when no registry URLs were injected', () => {
    expect(getExplorerLink(ADDRESS, 143, true)).toBe(`https://monadscan.com/address/${ADDRESS}`)
  })

  it('falls back to the mainnet explorer for an unknown chain', () => {
    expect(getExplorerLink(TX_HASH, 424242)).toBe(`https://etherscan.io/tx/${TX_HASH}`)
    expect(getExplorerLink(TX_HASH)).toBe(`https://etherscan.io/tx/${TX_HASH}`)
  })
})
