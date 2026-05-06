import { describe, expect, it } from 'vitest'
import {
  getKnownChainIds,
  getNetworksByChainIds,
  getUnknownChainIds,
  isKnownChainId,
} from '~/entities/chainRegistry'

describe('chainRegistry', () => {
  it('identifies supported chain IDs', () => {
    expect(isKnownChainId(1)).toBe(true)
    expect(isKnownChainId(923)).toBe(false)
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
