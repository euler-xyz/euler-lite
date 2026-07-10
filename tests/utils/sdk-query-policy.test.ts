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
import { PositionMigrationService } from '@eulerxyz/euler-v2-sdk'
import type { BuildQueryFn } from '@eulerxyz/euler-v2-sdk'
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

/**
 * Completeness guard for the SDK's PositionMigrationService queries.
 *
 * These six reads are exposed as `query*` fields the SDK decorates with the
 * supplied `buildQuery`, so — like every other SDK query — an unlisted name
 * silently inherits `DEFAULT_STALE_TIME_MS` on both the browsing and plan-time
 * instances. That would let a migration reuse stale position / authorization /
 * source-target state. The set is enumerated from the live service (not a
 * hardcoded list) so a future SDK bump that adds a migration query fails here
 * until it is classified in SDK_QUERY_POLICY.
 */
const collectMigrationQueryNames = (): string[] => {
  const names = new Set<string>()
  const recordingBuildQuery: BuildQueryFn = (queryName, fn) => {
    names.add(queryName)
    return fn
  }
  // The constructor only registers connectors and decorates its `query*` fields
  // via buildQuery — no network / provider I/O — so stub deps are sufficient.
  new PositionMigrationService(
    {} as unknown as ConstructorParameters<typeof PositionMigrationService>[0],
    {} as unknown as ConstructorParameters<typeof PositionMigrationService>[1],
    undefined,
    recordingBuildQuery,
  )
  return [...names].sort()
}

describe('SDK_QUERY_POLICY position-migration completeness', () => {
  it('enumerates the expected migration query set from the SDK', () => {
    // If the SDK adds/renames a migration query, this pins the change so the
    // classification below is revisited alongside it.
    expect(collectMigrationQueryNames()).toEqual([
      'queryEulerSourceVaultAssets',
      'queryEulerTargetVaultData',
      'queryGetAuthorization',
      'queryGetPosition',
      'queryListPositions',
      'queryListTargets',
    ])
  })

  it('classifies every migration query so none inherits DEFAULT_STALE_TIME_MS', () => {
    for (const name of collectMigrationQueryNames()) {
      expect(
        Object.prototype.hasOwnProperty.call(SDK_QUERY_POLICY, name),
        `${name}: PositionMigrationService query is unclassified — it would silently inherit DEFAULT_STALE_TIME_MS`,
      ).toBe(true)
    }
  })

  it('pins operator authorization to the shortest stale window in the table', () => {
    const shortest = Math.min(...Object.values(SDK_QUERY_POLICY).map(p => p.staleTimeMs))
    expect(SDK_QUERY_POLICY.queryGetAuthorization?.staleTimeMs).toBe(shortest)
  })

  it('invalidates the external position list after a tx', () => {
    expect(INVALIDATE_AFTER_TX).toContain('queryListPositions')
  })
})
