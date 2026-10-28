import { describe, expect, it } from 'vitest'
import { buildTurtleProxyRequestHeaders } from '~/server/utils/turtle-proxy'

describe('turtle proxy headers', () => {
  it('returns no headers when the API key is missing', () => {
    expect(buildTurtleProxyRequestHeaders({})).toBeUndefined()
  })

  it('returns no headers when the API key is blank', () => {
    expect(buildTurtleProxyRequestHeaders({ TURTLE_EARN_API_KEY: '   ' })).toBeUndefined()
  })

  it('injects the server-side Turtle API key as X-API-Key', () => {
    const headers = buildTurtleProxyRequestHeaders({ TURTLE_EARN_API_KEY: ' sk_live_secret ' })

    expect(headers).toEqual({ 'accept': 'application/json', 'X-API-Key': 'sk_live_secret' })
  })

  it('does not read a public Turtle API key variable', () => {
    expect(buildTurtleProxyRequestHeaders({ NUXT_PUBLIC_TURTLE_EARN_API_KEY: 'pk_live_public' })).toBeUndefined()
  })
})
