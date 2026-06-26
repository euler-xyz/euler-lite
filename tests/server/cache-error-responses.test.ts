import { describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import {
  forceNoStoreForErrorResponse,
  shouldForceNoStoreForPath,
} from '~/server/plugins/cache-error-responses'

function createMockEvent(statusCode: number) {
  const headers: Record<string, string> = {}
  return {
    event: {
      node: {
        res: {
          statusCode,
          setHeader: (name: string, value: string) => {
            headers[name] = value
          },
        },
      },
    } as unknown as H3Event,
    headers,
  }
}

describe('forceNoStoreForErrorResponse', () => {
  it('overrides route-rule cache headers on error responses', () => {
    const { event, headers } = createMockEvent(451)

    forceNoStoreForErrorResponse(event)

    expect(headers['Cache-Control']).toBe('no-store')
    expect(headers['CDN-Cache-Control']).toBe('no-store')
    expect(headers['Cloudflare-CDN-Cache-Control']).toBe('no-store')
  })

  it('leaves successful responses untouched', () => {
    const { event, headers } = createMockEvent(200)

    forceNoStoreForErrorResponse(event)

    expect(headers).toEqual({})
  })
})

describe('shouldForceNoStoreForPath', () => {
  it.each([
    '/api/proxy/fuul/claimable-rewards',
    '/api/proxy/incentra/v1/getMerkleProofsBatch',
    '/api/proxy/merkl/users/0x0000000000000000000000000000000000000000/rewards',
    '/api/proxy/subgraph/1',
    '/api/proxy/turtle/streams/merkle_proofs',
  ])('forces no-store for sensitive path %s', (pathname) => {
    expect(shouldForceNoStoreForPath(pathname)).toBe(true)
  })

  it.each([
    '/api/proxy/merkl/opportunities',
    '/api/proxy/fuul/incentives',
    '/api/proxy/incentra/sdk/v1/eulerCampaigns',
    '/api/proxy/intrinsic-apy-overrides',
  ])('leaves public cache path %s to route rules', (pathname) => {
    expect(shouldForceNoStoreForPath(pathname)).toBe(false)
  })
})
