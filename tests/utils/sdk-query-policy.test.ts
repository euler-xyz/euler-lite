/**
 * Invariants for the SDK_QUERY_POLICY table.
 *
 * Policy drives:
 *   - INVALIDATE_AFTER_TX — names marked stale in the QueryClient after every
 *     successful tx so display surfaces refresh. Entries are invalidated, not
 *     removed, and nothing is invalidated at form mount.
 *   - STALE_TIMES — staleTime applied by the browsing SDK's wrapper.
 *   - FORM_STALE_TIMES — staleTime applied by the plan-time/form SDK's
 *     wrapper. Pre-resolved as `formStaleTimeMs ?? staleTimeMs` so runtime
 *     is a single-table lookup.
 *
 * These tests guard against drift between the entry shape and the derived
 * exports.
 */
import { describe, expect, it } from 'vitest'
import { buildEulerSDK, createKeyringPlugin, createPythPlugin } from '@eulerxyz/euler-v2-sdk'
import type { BuildQueryFn } from '@eulerxyz/euler-v2-sdk'
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

describe('SDK_QUERY_POLICY completeness', () => {
  // Builds the real SDK with a buildQuery that records every query name it is
  // asked to wrap. Every wrapped name must have an explicit policy row —
  // otherwise a query added by an SDK bump silently inherits
  // DEFAULT_STALE_TIME_MS on both the browsing and the plan-time instance
  // (the regression that shipped the position-migration queries with a
  // 5-minute plan-time cache).
  it('classifies every query name the SDK routes through buildQuery', async () => {
    const recorded = new Set<string>()
    const recordingBuildQuery: BuildQueryFn = ((name: string, fn: unknown) => {
      recorded.add(name)
      // buildEulerSDK resolves deployments through buildQuery at build time;
      // stub it so the build needs no network. Every URL below points at a
      // closed port so any other build-time fetch fails the test loudly.
      if (name === 'queryDeployments') return async () => []
      return fn
    }) as BuildQueryFn

    const sdk = await buildEulerSDK({
      config: {
        rpcUrls: { 1: 'http://127.0.0.1:9/rpc' },
        deploymentsUrl: 'http://127.0.0.1:9/deployments',
        // V3 keeps the v3 adapters in the build so their query names are
        // covered as well.
        v3ApiUrl: 'http://127.0.0.1:9/v3',
      },
      buildQuery: recordingBuildQuery,
      plugins: [
        createPythPlugin({ buildQuery: recordingBuildQuery }),
        createKeyringPlugin({
          hookTargets: {},
          getCredentialData: async () => undefined,
          buildQuery: recordingBuildQuery,
        }),
      ],
    })
    expect(sdk).toBeTruthy()
    expect(recorded.size).toBeGreaterThan(0)

    const unclassified = [...recorded].filter(name => !(name in SDK_QUERY_POLICY)).sort()
    expect(
      unclassified,
      'SDK query names without an SDK_QUERY_POLICY row — classify them so they do not silently inherit DEFAULT_STALE_TIME_MS',
    ).toEqual([])

    const unwrapped = Object.keys(SDK_QUERY_POLICY).filter(name => !recorded.has(name)).sort()
    expect(
      unwrapped,
      'policy rows whose query name the SDK build never wrapped — likely a typo or a query removed upstream',
    ).toEqual([])
  }, 30_000)
})
