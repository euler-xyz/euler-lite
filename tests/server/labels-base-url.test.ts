import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveLabelsBaseUrl } from '~/server/utils/labels-base-url'

describe('effective policy base URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers the server-only effective-policy URL', () => {
    vi.stubEnv('EFFECTIVE_POLICY_BASE_URL', 'https://policy.example.test/')
    vi.stubEnv('NUXT_PUBLIC_CONFIG_LABELS_BASE_URL', 'https://legacy.example.test')

    expect(resolveLabelsBaseUrl()).toBe('https://policy.example.test')
  })

  it('retains the former public variable as a deployment fallback', () => {
    vi.stubEnv('EFFECTIVE_POLICY_BASE_URL', '')
    vi.stubEnv('NUXT_PUBLIC_CONFIG_LABELS_BASE_URL', 'https://legacy.example.test/')

    expect(resolveLabelsBaseUrl()).toBe('https://legacy.example.test')
  })

  it('builds the repository URL from server-only settings', () => {
    vi.stubEnv('EFFECTIVE_POLICY_BASE_URL', '')
    vi.stubEnv('NUXT_PUBLIC_CONFIG_LABELS_BASE_URL', '')
    vi.stubEnv('EFFECTIVE_POLICY_REPO', 'example/policy')
    vi.stubEnv('EFFECTIVE_POLICY_REPO_BRANCH', 'published')

    expect(resolveLabelsBaseUrl()).toBe(
      'https://raw.githubusercontent.com/example/policy/refs/heads/published',
    )
  })
})
