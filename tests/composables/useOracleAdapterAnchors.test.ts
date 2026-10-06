import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { registerOracleAdapterAnchors, useOracleAdapterAnchors } from '~/composables/useOracleAdapterAnchors'

describe('oracle adapter anchors', () => {
  it('offers an anchor only while a section renders it', async () => {
    const { hasAnchor } = useOracleAdapterAnchors()
    const ids = ref<string[]>(['oracle-adapter-0xaa'])
    const scope = effectScope()
    scope.run(() => registerOracleAdapterAnchors(ids))
    expect(hasAnchor('oracle-adapter-0xaa')).toBe(true)
    expect(hasAnchor('oracle-adapter-0xbb')).toBe(false)

    ids.value = ['oracle-adapter-0xbb']
    await nextTick()
    expect(hasAnchor('oracle-adapter-0xaa')).toBe(false)
    expect(hasAnchor('oracle-adapter-0xbb')).toBe(true)

    scope.stop()
    expect(hasAnchor('oracle-adapter-0xbb')).toBe(false)
  })

  it('keeps an anchor two sections both render until the last one leaves', () => {
    const { hasAnchor } = useOracleAdapterAnchors()
    const first = effectScope()
    const second = effectScope()
    first.run(() => registerOracleAdapterAnchors(ref(['oracle-adapter-0xcc'])))
    second.run(() => registerOracleAdapterAnchors(ref(['oracle-adapter-0xcc'])))
    first.stop()
    expect(hasAnchor('oracle-adapter-0xcc')).toBe(true)
    second.stop()
    expect(hasAnchor('oracle-adapter-0xcc')).toBe(false)
  })
})
