import { describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import { forceNoStoreForErrorResponse } from '~/server/plugins/cache-error-responses'

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
