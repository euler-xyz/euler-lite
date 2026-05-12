import { describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import { buildScreeningPayload, getTrustedVpnIsUsed, isAddressSuspiciousResponse } from '~/server/api/screen-address.post'

const eventWithHeaders = (headers: Record<string, string | string[] | undefined>): H3Event =>
  ({ node: { req: { headers } } }) as unknown as H3Event

describe('screen-address trusted VPN signal', () => {
  const address = '0x1111111111111111111111111111111111111111'

  it('does not mark VPN usage without trusted provider headers', () => {
    const event = eventWithHeaders({})

    expect(getTrustedVpnIsUsed(event)).toBe(false)
    expect(buildScreeningPayload(address, event)).toEqual({
      address,
      chain: 'all',
      vpnIsUsed: 'false',
    })
  })

  it('derives VPN usage from provider headers', () => {
    const event = eventWithHeaders({ 'x-is-proxy-or-vpn': 'true' })

    expect(getTrustedVpnIsUsed(event)).toBe(true)
    expect(buildScreeningPayload(address, event).vpnIsUsed).toBe('true')
  })

  it('accepts x-is-vpn as an advisory trusted signal', () => {
    const event = eventWithHeaders({ 'x-is-vpn': '1' })

    expect(getTrustedVpnIsUsed(event)).toBe(true)
  })
})

describe('screen-address upstream response parsing', () => {
  it('allows only an explicit false suspicious flag', () => {
    expect(isAddressSuspiciousResponse({ addressIsSuspicious: false })).toBe(false)
  })

  it('fails closed for suspicious, missing, null, or malformed responses', () => {
    expect(isAddressSuspiciousResponse({ addressIsSuspicious: true })).toBe(true)
    expect(isAddressSuspiciousResponse({})).toBe(true)
    expect(isAddressSuspiciousResponse({ addressIsSuspicious: null })).toBe(true)
    expect(isAddressSuspiciousResponse(null)).toBe(true)
  })
})
