import { describe, expect, it } from 'vitest'
import { TERMS_SCROLL_END_THRESHOLD, isScrolledToEnd } from '~/components/entities/operation/termsScrollGate'

describe('isScrolledToEnd', () => {
  it('is false at the top of overflowing content', () => {
    expect(isScrolledToEnd({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 })).toBe(false)
  })

  it('is false partway through overflowing content', () => {
    expect(isScrolledToEnd({ scrollTop: 300, clientHeight: 400, scrollHeight: 1000 })).toBe(false)
  })

  it('is true when scrolled exactly to the bottom', () => {
    expect(isScrolledToEnd({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true)
  })

  it('is true when within the default threshold of the bottom', () => {
    expect(isScrolledToEnd({ scrollTop: 600 - TERMS_SCROLL_END_THRESHOLD, clientHeight: 400, scrollHeight: 1000 })).toBe(true)
  })

  it('is false just beyond the default threshold from the bottom', () => {
    expect(isScrolledToEnd({ scrollTop: 600 - TERMS_SCROLL_END_THRESHOLD - 1, clientHeight: 400, scrollHeight: 1000 })).toBe(false)
  })

  it('is true when the content does not overflow (nothing to scroll)', () => {
    expect(isScrolledToEnd({ scrollTop: 0, clientHeight: 500, scrollHeight: 400 })).toBe(true)
  })

  it('respects a custom threshold', () => {
    const metrics = { scrollTop: 550, clientHeight: 400, scrollHeight: 1000 }
    expect(isScrolledToEnd(metrics, 0)).toBe(false)
    expect(isScrolledToEnd(metrics, 50)).toBe(true)
  })
})
