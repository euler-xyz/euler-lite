import { afterEach, describe, expect, it, vi } from 'vitest'
import { readHostedLabelImageOrigins, readLabelsSource, resolveLabelsBaseUrl, validateLabelsConfiguration } from '~/server/utils/labels-base-url'
import { LabelsConfigurationError } from '~/server/utils/labels-configuration-error'

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
  it('does not reveal malformed static URLs in configuration errors', () => {
    vi.stubEnv('STATIC_LABELS_BASE_URL', 'not a URL with a secret')
    expect(resolveLabelsBaseUrl).toThrow(LabelsConfigurationError)
    expect(resolveLabelsBaseUrl).toThrow('STATIC_LABELS_BASE_URL must be')
  })
  it('accepts static labels without V3 or deprecated-chain verification configuration', () => {
    vi.stubEnv('LABELS_SOURCE', 'static')
    vi.stubEnv('STATIC_LABELS_BASE_URL', 'https://fork.example/labels')
    vi.stubEnv('DISABLE_V3', 'true')
    vi.stubEnv('RPC_URL_146', 'https://rpc.example')
    vi.stubEnv('DEPRECATED_CHAINS', '146')
    vi.stubEnv('ONCHAIN_SDK_CHAINS', '')
    expect(validateLabelsConfiguration).not.toThrow()
  })
  it('explains contradictory V3 selections', () => {
    vi.stubEnv('LABELS_SOURCE', 'v3')
    vi.stubEnv('DISABLE_V3', 'true')
    expect(validateLabelsConfiguration).toThrow('DISABLE_V3 requires LABELS_SOURCE=static')
    vi.stubEnv('LABELS_SOURCE', 'static')
    vi.stubEnv('SERVER_VAULT_CACHE_SOURCE', 'v3')
    expect(validateLabelsConfiguration).toThrow('SERVER_VAULT_CACHE_SOURCE')
  })
  it('trusts a configured V3 host and additional image origins without changing default host restrictions', () => {
    vi.stubEnv('V3_API_URL', 'https://v3.euler.finance')
    vi.stubEnv('LABELS_IMAGE_ORIGINS', '')
    expect(readHostedLabelImageOrigins()).toEqual([])
    vi.stubEnv('V3_API_URL', 'https://v3.fork.test')
    vi.stubEnv('LABELS_IMAGE_ORIGINS', 'https://cdn.fork.test, http://localhost:8080/')
    expect(readHostedLabelImageOrigins()).toEqual(['https://cdn.fork.test', 'http://localhost:8080', 'https://v3.fork.test'])
    vi.stubEnv('LABELS_IMAGE_ORIGINS', 'https://cdn.fork.test/path')
    expect(readHostedLabelImageOrigins).toThrow('without paths')
  })
})
