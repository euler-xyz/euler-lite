import { describe, expect, it } from 'vitest'
import {
  getChainById,
  getChainIdByName,
  getDefiLlamaChainName,
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
    expect(getDefiLlamaChainName(999)).toBe('Hyperliquid')
  })

  it('uses MonadScan as the Monad block explorer', () => {
    const chain = getChainById(143)

    expect(chain?.blockExplorers?.default.name).toBe('MonadScan')
    expect(chain?.blockExplorers?.default.url).toBe('https://monadscan.com/')
    expect(getChainIdByName('monad')).toBe(143)
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
