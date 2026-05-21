/**
 * Invariants for the SDK_QUERY_POLICY table.
 *
 * Policy drives:
 *   - INVALIDATE_AFTER_TX — names evicted from the QueryClient at form mount
 *     and after every successful tx so display surfaces refresh.
 *   - STALE_TIMES — staleTime applied by the browsing SDK's wrapper.
 *   - FORM_STALE_TIMES — staleTime applied by the plan-time/form SDK's
 *     wrapper. Pre-resolved as `formStaleTimeMs ?? staleTimeMs` so runtime
 *     is a single-table lookup.
 *
 * These tests guard against drift between the entry shape and the derived
 * exports.
 */
import { describe, expect, it } from 'vitest'
import {
  FORM_STALE_TIMES,
  INVALIDATE_AFTER_TX,
  SDK_QUERY_POLICY,
  STALE_TIMES,
} from '~/utils/sdk-query-policy'

describe('SDK_QUERY_POLICY structural invariants', () => {
  it('every entry name starts with "query"', () => {
    for (const name of Object.keys(SDK_QUERY_POLICY)) {
      expect(name.startsWith('query'), `${name}: SDK query names start with "query"`).toBe(true)
    }
  })

  it('every entry has a numeric staleTimeMs', () => {
    for (const [name, p] of Object.entries(SDK_QUERY_POLICY)) {
      expect(typeof p.staleTimeMs, `${name}.staleTimeMs must be a number`).toBe('number')
      expect(p.staleTimeMs, `${name}.staleTimeMs must be >= 0`).toBeGreaterThanOrEqual(0)
    }
  })

  it('formStaleTimeMs is a non-negative number when set', () => {
    for (const [name, p] of Object.entries(SDK_QUERY_POLICY)) {
      if (p.formStaleTimeMs === undefined) continue
      expect(typeof p.formStaleTimeMs).toBe('number')
      expect(p.formStaleTimeMs, `${name}.formStaleTimeMs must be >= 0`).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('SDK_QUERY_POLICY derived lists', () => {
  it('INVALIDATE_AFTER_TX is exactly the set of names with invalidateAfterTx=true', () => {
    const derived = new Set(INVALIDATE_AFTER_TX)
    const expected = new Set(
      Object.entries(SDK_QUERY_POLICY)
        .filter(([, p]) => p.invalidateAfterTx === true)
        .map(([name]) => name),
    )
    expect(derived).toEqual(expected)
  })

  it('STALE_TIMES is exactly the map of names to staleTimeMs', () => {
    const expected: Record<string, number> = {}
    for (const [name, p] of Object.entries(SDK_QUERY_POLICY)) {
      expected[name] = p.staleTimeMs
    }
    expect(STALE_TIMES).toEqual(expected)
  })

  it('FORM_STALE_TIMES resolves formStaleTimeMs ?? staleTimeMs per row', () => {
    const expected: Record<string, number> = {}
    for (const [name, p] of Object.entries(SDK_QUERY_POLICY)) {
      expected[name] = p.formStaleTimeMs ?? p.staleTimeMs
    }
    expect(FORM_STALE_TIMES).toEqual(expected)
  })

  it('FORM_STALE_TIMES <= STALE_TIMES for every name', () => {
    // Plan-time should never be staler than browsing — that would be a bug.
    for (const name of Object.keys(SDK_QUERY_POLICY)) {
      const form = FORM_STALE_TIMES[name as keyof typeof FORM_STALE_TIMES] ?? Infinity
      const browse = STALE_TIMES[name as keyof typeof STALE_TIMES] ?? Infinity
      expect(form, `${name}: form-time stale must be <= browsing stale`).toBeLessThanOrEqual(browse)
    }
  })
})
