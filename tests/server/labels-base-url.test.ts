import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLabelsSource, resolveLabelsBaseUrl } from '~/server/utils/labels-base-url'

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
