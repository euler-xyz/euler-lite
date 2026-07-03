import { describe, expect, it } from 'vitest'
import { parseEVaultFetchChunkChainIds, shouldChunkEVaultFetch } from '~/utils/eVaultFetchChunkConfig'

describe('eVaultFetchChunkConfig', () => {
  it('parses configured chunk chains against the enabled chain set', () => {
    const enabled = new Set([1, 146, 80094])

    expect(parseEVaultFetchChunkChainIds({
      EVAULT_FETCH_CHUNK_CHAINS: '146, 999, 80094, invalid',
    } as NodeJS.ProcessEnv, enabled)).toEqual([146, 80094])
  })

  it('checks a single chain against the chunk config', () => {
    const env = {
      EVAULT_FETCH_CHUNK_CHAINS: '146',
    } as NodeJS.ProcessEnv

    expect(shouldChunkEVaultFetch(146, env)).toBe(true)
    expect(shouldChunkEVaultFetch(80094, env)).toBe(false)
  })
})
