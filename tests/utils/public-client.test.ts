import { describe, expect, it } from 'vitest'
import { isPublicAnkrRpcUrl } from '~/utils/public-client'

describe('isPublicAnkrRpcUrl', () => {
  it('matches the free public-tier shape (single chain segment)', () => {
    expect(isPublicAnkrRpcUrl('https://rpc.ankr.com/tac')).toBe(true)
    expect(isPublicAnkrRpcUrl('https://rpc.ankr.com/swell')).toBe(true)
    expect(isPublicAnkrRpcUrl('https://rpc.ankr.com/eth/')).toBe(true)
  })

  it('rejects premium URLs that carry an API key in the path', () => {
    expect(isPublicAnkrRpcUrl('https://rpc.ankr.com/eth/abc123def456')).toBe(false)
    expect(isPublicAnkrRpcUrl('https://rpc.ankr.com/premium-http/eth/abc123def456')).toBe(false)
  })

  it('rejects unrelated hosts', () => {
    expect(isPublicAnkrRpcUrl('https://rpc.soniclabs.com/')).toBe(false)
    expect(isPublicAnkrRpcUrl('https://chaotic-blissful-moon.quiknode.pro/abc/')).toBe(false)
    expect(isPublicAnkrRpcUrl('https://example.com/ankr.com/eth')).toBe(false)
  })

  it('does not match a host that merely ends with ankr.com', () => {
    // Defends against future host changes — guard is exact-match on host.
    expect(isPublicAnkrRpcUrl('https://attacker-rpc.ankr.com.evil.tld/eth')).toBe(false)
  })

  it('returns false for malformed input', () => {
    expect(isPublicAnkrRpcUrl('not-a-url')).toBe(false)
    expect(isPublicAnkrRpcUrl('')).toBe(false)
  })
})
