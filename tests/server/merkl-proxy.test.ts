import { describe, expect, it } from 'vitest'
import { buildMerklProxyRequestHeaders } from '~/server/utils/merkl-proxy'

describe('merkl proxy headers', () => {
  it('sends only the accept header when no API key is configured', () => {
    const headers = buildMerklProxyRequestHeaders({})

    expect(headers.accept).toBe('application/json')
    expect(headers['X-API-Key']).toBeUndefined()
  })

  it('injects the server-side Merkl API key as X-API-Key', () => {
    const headers = buildMerklProxyRequestHeaders({ MERKL_API_KEY: 'merkl-secret' })

    expect(headers.accept).toBe('application/json')
    expect(headers['X-API-Key']).toBe('merkl-secret')
  })

  it('ignores a blank API key', () => {
    const headers = buildMerklProxyRequestHeaders({ MERKL_API_KEY: '   ' })

    expect(headers['X-API-Key']).toBeUndefined()
  })

  it('does not read a public Merkl API key variable', () => {
    const headers = buildMerklProxyRequestHeaders({ NUXT_PUBLIC_MERKL_API_KEY: 'public-key' })

    expect(headers['X-API-Key']).toBeUndefined()
  })
})
