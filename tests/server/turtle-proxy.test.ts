import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TURTLE_EARN_API_URL,
  buildTurtleProxyRequestHeaders,
  resolveTurtleUpstreamBase,
} from '~/server/utils/turtle-proxy'

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

describe('turtle upstream resolution', () => {
  it('defaults to the Turtle Earn API', () => {
    expect(resolveTurtleUpstreamBase({})).toEqual({ ok: true, base: DEFAULT_TURTLE_EARN_API_URL })
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: '  ' })).toEqual({ ok: true, base: DEFAULT_TURTLE_EARN_API_URL })
  })

  it('accepts https overrides on turtle.xyz hosts and strips trailing slashes', () => {
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: 'https://earn.turtle.xyz/v2/' }))
      .toEqual({ ok: true, base: 'https://earn.turtle.xyz/v2' })
    expect(resolveTurtleUpstreamBase({ NUXT_PUBLIC_TURTLE_EARN_API_URL: 'https://staging.turtle.xyz' }))
      .toEqual({ ok: true, base: 'https://staging.turtle.xyz' })
  })

  it('prefers the server-only URL variable over the public one', () => {
    expect(resolveTurtleUpstreamBase({
      TURTLE_EARN_API_URL: 'https://earn.turtle.xyz/v1',
      NUXT_PUBLIC_TURTLE_EARN_API_URL: 'https://evil.example/v1',
    })).toEqual({ ok: true, base: 'https://earn.turtle.xyz/v1' })
  })

  it('allows loopback hosts over plain http for local development', () => {
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: 'http://localhost:4010/v1' }))
      .toEqual({ ok: true, base: 'http://localhost:4010/v1' })
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: 'http://127.0.0.1:4010' }))
      .toEqual({ ok: true, base: 'http://127.0.0.1:4010' })
  })

  it('refuses to send the key to hosts outside turtle.xyz', () => {
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: 'https://evil.example/v1' }))
      .toEqual({ ok: false, reason: 'untrusted-host' })
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: 'https://turtle.xyz.evil.example/v1' }))
      .toEqual({ ok: false, reason: 'untrusted-host' })
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: 'https://notturtle.xyz/v1' }))
      .toEqual({ ok: false, reason: 'untrusted-host' })
  })

  it('refuses plain http to non-loopback hosts', () => {
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: 'http://earn.turtle.xyz/v1' }))
      .toEqual({ ok: false, reason: 'insecure-protocol' })
  })

  it('refuses URLs carrying credentials or unparseable values', () => {
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: 'https://user:pass@earn.turtle.xyz/v1' }))
      .toEqual({ ok: false, reason: 'credentials-in-url' })
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: 'not a url' }))
      .toEqual({ ok: false, reason: 'invalid-url' })
    expect(resolveTurtleUpstreamBase({ TURTLE_EARN_API_URL: 'ftp://earn.turtle.xyz/v1' }))
      .toEqual({ ok: false, reason: 'insecure-protocol' })
  })
})
