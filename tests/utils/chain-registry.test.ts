import { describe, expect, it } from 'vitest'
import {
  EXPLORER_OVERRIDES,
  getChainById,
  getChainIdByName,
  getKnownChainIds,
  getNetworksByChainIds,
  getUnknownChainIds,
  isKnownChainId,
  parseChainId,
} from '~/entities/chainRegistry'

describe('chainRegistry', () => {
  it('identifies supported chain IDs', () => {
    expect(isKnownChainId(1)).toBe(true)
    expect(isKnownChainId(999)).toBe(true)
    expect(isKnownChainId(923)).toBe(false)
  })

  it('resolves HyperEVM for chain ID 999 despite upstream ID collisions', () => {
    const chain = getChainById(999)

    expect(chain?.name).toBe('HyperEVM')
    expect(chain?.nativeCurrency.symbol).toBe('HYPE')
    expect(chain?.rpcUrls.default.http).toContain('https://rpc.hyperliquid.xyz/evm')
  })

  it.each([...EXPLORER_OVERRIDES])('applies the block explorer override for chain %i', (chainId, explorer) => {
    const chain = getChainById(chainId)

    expect(chain?.blockExplorers?.default).toMatchObject(explorer)
    expect(getChainIdByName(chain?.name ?? '')).toBe(chainId)
  })

  it('keeps reverse slug lookup pinned to canonical chain ID collisions', () => {
    expect(getChainIdByName('hyperEvm')).toBe(999)
    expect(getChainIdByName('hyperliquid')).toBe(999)
    expect(parseChainId('HyperEVM')).toBe(999)

    expect(getChainIdByName('wanchainTestnet')).toBeUndefined()
    expect(getChainIdByName('zoraTestnet')).toBeUndefined()
    expect(parseChainId('zora-goerli-testnet')).toBeNull()
  })

  it('partitions known and unknown chain IDs', () => {
    const chainIds = [1, 923, 42161]

    expect(getKnownChainIds(chainIds)).toEqual([1, 42161])
    expect(getUnknownChainIds(chainIds)).toEqual([923])
  })

  it('keeps strict network lookup errors for unsupported chains', () => {
    expect(() => getNetworksByChainIds([923])).toThrow(
      '[chainRegistry] Unknown chain ID 923. Not found in @reown/appkit/networks.',
    )
  })
})
