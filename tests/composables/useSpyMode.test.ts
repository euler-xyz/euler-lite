import { beforeEach, describe, expect, it, vi } from 'vitest'

const FIRST = '0x0000000000000000000000000000000000000001'
const SECOND = '0x0000000000000000000000000000000000000002'

describe('useSpyMode', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('useRoute', () => ({ path: '/portfolio/activity', query: {}, hash: '' }))
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
  })

  it('replaces the active spy address synchronously for internal account links', async () => {
    const { useSpyMode } = await import('~/composables/useSpyMode')
    const spy = useSpyMode()

    expect(spy.activateSpyMode(FIRST)).toBe(true)
    expect(spy.spyAddress.value.toLowerCase()).toBe(FIRST)

    expect(spy.activateSpyMode(SECOND)).toBe(true)
    expect(spy.spyAddress.value.toLowerCase()).toBe(SECOND)
  })
})
