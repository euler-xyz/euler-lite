/**
 * Tests for the edge-provider abstraction: preset header mapping
 * (utils/edge-presets.ts), the per-request EdgeContext (server/utils/edge.ts),
 * and the boot-time configuration guard.
 *
 * The presets are the ONLY place vendor headers are known — if one of these
 * mappings regresses, geo-blocking, rate-limit identity, or the screening
 * audit silently degrade in production.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import {
  edgeProvidesGeo,
  edgeProvidesVpnEvidence,
  extractEdgeInputs,
  normalizeCountry,
  parseEdgeProvider,
} from '~/utils/edge-presets'
import { assertEdgeConfig, getEdgeContext } from '~/server/utils/edge'

const ENV_KNOBS = ['EDGE_PROVIDER', 'EDGE_ORIGIN_SECRET', 'DEV_GEO_COUNTRY', 'DOPPLER_ENVIRONMENT'] as const

const envSnapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KNOBS) {
    envSnapshot[key] = process.env[key]
    Reflect.deleteProperty(process.env, key)
  }
})

afterEach(() => {
  for (const key of ENV_KNOBS) {
    if (envSnapshot[key] === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = envSnapshot[key]
  }
})

const eventWith = (
  headers: Record<string, string | string[] | undefined>,
  remoteAddress?: string,
): H3Event =>
  ({ node: { req: { headers, socket: { remoteAddress } } } }) as unknown as H3Event

describe('parseEdgeProvider', () => {
  it('defaults to none when unset or blank', () => {
    expect(parseEdgeProvider(undefined)).toBe('none')
    expect(parseEdgeProvider('')).toBe('none')
    expect(parseEdgeProvider('   ')).toBe('none')
  })

  it('accepts every preset name, case- and whitespace-insensitively', () => {
    expect(parseEdgeProvider('cloudflare')).toBe('cloudflare')
    expect(parseEdgeProvider(' Cloudflare ')).toBe('cloudflare')
    expect(parseEdgeProvider('GOOGLE')).toBe('google')
    expect(parseEdgeProvider('cloudfront')).toBe('cloudfront')
    expect(parseEdgeProvider('none')).toBe('none')
  })

  it('throws on unknown values instead of degrading to none', () => {
    expect(() => parseEdgeProvider('cloudflre')).toThrow(/Unknown EDGE_PROVIDER/)
    expect(() => parseEdgeProvider('akamai')).toThrow(/Unknown EDGE_PROVIDER/)
  })
})

describe('normalizeCountry', () => {
  it('uppercases valid alpha-2 codes', () => {
    expect(normalizeCountry('de')).toBe('DE')
    expect(normalizeCountry('US')).toBe('US')
  })

  it('rejects unknown, special, and malformed values', () => {
    for (const value of ['XX', 'T1', 'USA', '1A', '', undefined, null]) {
      expect(normalizeCountry(value)).toBeNull()
    }
  })
})

describe('preset capabilities', () => {
  it('every preset except none provides geo', () => {
    expect(edgeProvidesGeo('cloudflare')).toBe(true)
    expect(edgeProvidesGeo('google')).toBe(true)
    expect(edgeProvidesGeo('cloudfront')).toBe(true)
    expect(edgeProvidesGeo('none')).toBe(false)
  })

  it('only cloudflare provides VPN evidence', () => {
    expect(edgeProvidesVpnEvidence('cloudflare')).toBe(true)
    expect(edgeProvidesVpnEvidence('google')).toBe(false)
    expect(edgeProvidesVpnEvidence('cloudfront')).toBe(false)
    expect(edgeProvidesVpnEvidence('none')).toBe(false)
  })
})

describe('extractEdgeInputs — cloudflare', () => {
  it('maps trusted IP, country, and VPN evidence', () => {
    expect(extractEdgeInputs('cloudflare', {
      'cf-connecting-ip': '203.0.113.7',
      'cf-ipcountry': 'de',
      'x-is-vpn': 'true',
    }, '10.0.0.1')).toEqual({ clientIp: '203.0.113.7', country: 'DE', vpnIsUsed: true })
  })

  it('treats absent, blank, or duplicated identity headers as no identity', () => {
    expect(extractEdgeInputs('cloudflare', {}, '10.0.0.1').clientIp).toBeNull()
    expect(extractEdgeInputs('cloudflare', { 'cf-connecting-ip': '  ' }, undefined).clientIp).toBeNull()
    expect(extractEdgeInputs('cloudflare', { 'cf-connecting-ip': ['1.1.1.1', '2.2.2.2'] }, undefined).clientIp).toBeNull()
  })

  it('never falls back to x-forwarded-for or the socket', () => {
    const inputs = extractEdgeInputs('cloudflare', { 'x-forwarded-for': '198.51.100.9' }, '10.0.0.1')
    expect(inputs.clientIp).toBeNull()
  })

  it('treats XX and Tor exit codes as undetermined country', () => {
    expect(extractEdgeInputs('cloudflare', { 'cf-ipcountry': 'XX' }, undefined).country).toBeNull()
    expect(extractEdgeInputs('cloudflare', { 'cf-ipcountry': 'T1' }, undefined).country).toBeNull()
  })

  it.each([
    [{ 'x-is-vpn': 'true' }, true],
    [{ 'x-is-proxy-or-vpn': 'true' }, true],
    [{ 'x-is-vpn': 'false, TRUE' }, true],
    [{ 'x-is-proxy-or-vpn': ['false', ' true '] }, true],
    [{ 'x-is-vpn': 'false' }, false],
    [{}, null],
  ] as const)('derives VPN evidence %j → %s', (headers, expected) => {
    expect(extractEdgeInputs('cloudflare', headers as Record<string, string | string[]>, undefined).vpnIsUsed).toBe(expected)
  })
})

describe('extractEdgeInputs — google', () => {
  it('takes the second-to-last x-forwarded-for entry (client appended by the LB)', () => {
    const inputs = extractEdgeInputs('google', {
      'x-forwarded-for': 'spoofed, 203.0.113.7, 35.190.0.1',
      'x-client-geo': 'fr',
    }, '10.0.0.1')
    expect(inputs).toEqual({ clientIp: '203.0.113.7', country: 'FR', vpnIsUsed: null })
  })

  it('fails closed with fewer than two forwarded entries', () => {
    expect(extractEdgeInputs('google', { 'x-forwarded-for': '203.0.113.7' }, '10.0.0.1').clientIp).toBeNull()
    expect(extractEdgeInputs('google', {}, '10.0.0.1').clientIp).toBeNull()
  })
})

describe('extractEdgeInputs — cloudfront', () => {
  it('strips the port from the viewer address, IPv6 included', () => {
    expect(extractEdgeInputs('cloudfront', {
      'cloudfront-viewer-address': '203.0.113.7:52443',
      'cloudfront-viewer-country': 'gb',
    }, undefined)).toEqual({ clientIp: '203.0.113.7', country: 'GB', vpnIsUsed: null })
    expect(extractEdgeInputs('cloudfront', {
      'cloudfront-viewer-address': '2001:db8::1:41768',
    }, undefined).clientIp).toBe('2001:db8::1')
  })

  it('fails closed when the viewer address is absent', () => {
    expect(extractEdgeInputs('cloudfront', {}, '10.0.0.1').clientIp).toBeNull()
  })
})

describe('extractEdgeInputs — none', () => {
  it('uses the rightmost x-forwarded-for entry, then the socket', () => {
    expect(extractEdgeInputs('none', {
      'x-forwarded-for': 'spoofed, 203.0.113.7',
    }, '10.0.0.1').clientIp).toBe('203.0.113.7')
    expect(extractEdgeInputs('none', {}, '10.0.0.1').clientIp).toBe('10.0.0.1')
    expect(extractEdgeInputs('none', {}, undefined).clientIp).toBeNull()
  })

  it('never reports a country or VPN evidence', () => {
    const inputs = extractEdgeInputs('none', {
      'cf-ipcountry': 'DE',
      'x-is-vpn': 'true',
    }, undefined)
    expect(inputs.country).toBeNull()
    expect(inputs.vpnIsUsed).toBeNull()
  })
})

describe('getEdgeContext', () => {
  it('is authenticated by default when no origin-auth secret is configured', () => {
    process.env.EDGE_PROVIDER = 'cloudflare'
    const context = getEdgeContext(eventWith({ 'cf-connecting-ip': '203.0.113.7', 'cf-ipcountry': 'DE' }))
    expect(context).toMatchObject({
      clientIp: '203.0.113.7',
      country: 'DE',
      authenticated: true,
      isInternal: false,
      providesGeo: true,
    })
  })

  it('honours the origin-auth secret when the header matches', () => {
    process.env.EDGE_PROVIDER = 'cloudflare'
    process.env.EDGE_ORIGIN_SECRET = 'shared-secret'
    const context = getEdgeContext(eventWith({
      'cf-connecting-ip': '203.0.113.7',
      'cf-ipcountry': 'DE',
      'x-edge-origin-auth': 'shared-secret',
    }))
    expect(context).toMatchObject({ clientIp: '203.0.113.7', country: 'DE', authenticated: true })
  })

  it('nulls every trusted input when origin auth fails', () => {
    process.env.EDGE_PROVIDER = 'cloudflare'
    process.env.EDGE_ORIGIN_SECRET = 'shared-secret'
    for (const headers of [
      { 'cf-connecting-ip': '203.0.113.7', 'cf-ipcountry': 'DE', 'x-is-vpn': 'true' },
      { 'cf-connecting-ip': '203.0.113.7', 'cf-ipcountry': 'DE', 'x-edge-origin-auth': 'wrong' },
      // Same byte length as the secret — exercises the timing-safe compare.
      { 'cf-ipcountry': 'DE', 'x-edge-origin-auth': 'shared-secreX' },
    ]) {
      expect(getEdgeContext(eventWith(headers))).toMatchObject({
        clientIp: null,
        country: null,
        vpnIsUsed: null,
        authenticated: false,
      })
    }
  })

  it('skips the DEV_GEO_COUNTRY fallback when origin auth fails', () => {
    process.env.EDGE_PROVIDER = 'cloudflare'
    process.env.EDGE_ORIGIN_SECRET = 'shared-secret'
    process.env.DEV_GEO_COUNTRY = 'GB'
    expect(getEdgeContext(eventWith({})).country).toBeNull()
  })

  it('applies the DEV_GEO_COUNTRY fallback when the edge provides no country', () => {
    process.env.DEV_GEO_COUNTRY = 'gb'
    expect(getEdgeContext(eventWith({})).country).toBe('GB')

    process.env.EDGE_PROVIDER = 'cloudflare'
    expect(getEdgeContext(eventWith({})).country).toBe('GB')
    // The real edge header still wins over the fallback.
    expect(getEdgeContext(eventWith({ 'cf-ipcountry': 'US' })).country).toBe('US')
  })

  it('flags internal requests', () => {
    expect(getEdgeContext(eventWith({ 'cf-connecting-ip': '127.0.0.1' })).isInternal).toBe(true)

    process.env.EDGE_ORIGIN_SECRET = 'shared-secret'
    expect(getEdgeContext(eventWith({
      'x-edge-origin-auth': 'shared-secret',
      'x-edge-internal': 'shared-secret',
    })).isInternal).toBe(true)
  })

  it('defaults to the none preset: geo off, best-effort identity', () => {
    const context = getEdgeContext(eventWith({ 'x-forwarded-for': 'spoofed, 203.0.113.7' }))
    expect(context).toMatchObject({
      clientIp: '203.0.113.7',
      country: null,
      vpnIsUsed: null,
      providesGeo: false,
    })
  })
})

describe('assertEdgeConfig', () => {
  it('allows any environment with a valid preset, and non-prd without one', () => {
    expect(() => assertEdgeConfig()).not.toThrow()

    process.env.DOPPLER_ENVIRONMENT = 'dev'
    expect(() => assertEdgeConfig()).not.toThrow()

    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'cloudflare'
    expect(() => assertEdgeConfig()).not.toThrow()

    // Explicitly opting out of an edge in production is a deliberate choice.
    process.env.EDGE_PROVIDER = 'none'
    expect(() => assertEdgeConfig()).not.toThrow()
  })

  it('refuses to boot production without an explicit preset', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    expect(() => assertEdgeConfig()).toThrow(/EDGE_PROVIDER must be set in production/)
  })

  it('refuses to boot on a typoed preset in any environment', () => {
    process.env.EDGE_PROVIDER = 'cloudflre'
    expect(() => assertEdgeConfig()).toThrow(/Unknown EDGE_PROVIDER/)
  })
})
