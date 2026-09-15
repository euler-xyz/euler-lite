import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLabelsOnchainVerificationChains, readLabelsSource, resolveLabelsBaseUrl } from '~/server/utils/labels-base-url'

describe('label source configuration', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('defaults to V3 regardless of obsolete GitHub settings', () => {
    vi.stubEnv('LABELS_SOURCE', '')
    vi.stubEnv('EFFECTIVE_POLICY_REPO', 'euler-xyz/euler-labels')
    expect(readLabelsSource()).toBe('v3')
  })
  it('requires an explicit static URL and rejects invalid source selection', () => {
    vi.stubEnv('STATIC_LABELS_BASE_URL', '')
    expect(resolveLabelsBaseUrl).toThrow('required')
    vi.stubEnv('LABELS_SOURCE', 'typo')
    expect(readLabelsSource).toThrow('v3 or static')
  })
  it('accepts operator-owned directories without a repository dependency', () => {
    vi.stubEnv('STATIC_LABELS_BASE_URL', 'https://fork.example/labels/')
    expect(resolveLabelsBaseUrl()).toBe('https://fork.example/labels')
  })
  it.each(['file:///tmp/labels', 'https://user:password@example.test', 'https://example.test?token=x'])('rejects unsafe base %s', (base) => {
    vi.stubEnv('STATIC_LABELS_BASE_URL', base)
    expect(resolveLabelsBaseUrl).toThrow()
  })
})

describe('deprecated-chain labels verification selection', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('selects enabled deprecated chains without changing active on-chain chains', () => {
    vi.stubEnv('RPC_URL_146', 'https://rpc.example.test')
    vi.stubEnv('RPC_URL_1', 'https://rpc.example.test')
    vi.stubEnv('ONCHAIN_SDK_CHAINS', '1,146')
    vi.stubEnv('DEPRECATED_CHAINS', '146,146')
    expect(readLabelsOnchainVerificationChains()).toEqual([146])
    vi.stubEnv('DEPRECATED_CHAINS', '')
    expect(readLabelsOnchainVerificationChains()).toEqual([])
  })
  it('ignores deprecated chains without an enabled RPC', () => {
    vi.stubEnv('RPC_URL_1923', '')
    vi.stubEnv('ONCHAIN_SDK_CHAINS', '')
    vi.stubEnv('DEPRECATED_CHAINS', '1923')
    expect(readLabelsOnchainVerificationChains()).toEqual([])
  })
  it('rejects an enabled deprecated chain without on-chain SDK reads', () => {
    vi.stubEnv('RPC_URL_146', 'https://rpc.example.test')
    vi.stubEnv('ONCHAIN_SDK_CHAINS', '1')
    vi.stubEnv('DEPRECATED_CHAINS', '146')
    expect(() => readLabelsOnchainVerificationChains()).toThrow('ONCHAIN_SDK_CHAINS: 146')
  })
})
