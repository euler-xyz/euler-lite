import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFlaggedVault } from '~/composables/useFlaggedVault'

const ADDRESS = '0x00000000000000000000000000000000000000a1'

const flagged = (status: string | undefined, options: { ready?: boolean, source?: string } = {}) => {
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(options.ready ?? true),
    source: ref(options.source ?? 'v3'),
    visibility: ref(status ? { [ADDRESS]: { status, decidedBy: 'config-failed', reason: null } } : {}),
  }))
  return useFlaggedVault(() => ADDRESS.toUpperCase().replace('0X', '0x')).value
}

afterEach(() => vi.unstubAllGlobals())

describe('useFlaggedVault', () => {
  it('means a V3 hidden verdict only', () => {
    expect(flagged('hidden')).toBe(true)
    expect(flagged('pending_review')).toBe(false)
    expect(flagged('visible')).toBe(false)
    expect(flagged('warning')).toBe(false)
    expect(flagged(undefined)).toBe(false)
  })

  it('needs ready V3 labels', () => {
    expect(flagged('hidden', { ready: false })).toBe(false)
    expect(flagged('hidden', { source: 'static' })).toBe(false)
  })
})
