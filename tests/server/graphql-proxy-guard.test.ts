import { describe, expect, it, vi } from 'vitest'

import { assertAllowedGraphqlRequest } from '~/server/utils/graphql-proxy-guard'

// Mirror the h3 mock used by other server tests: createError just returns the
// descriptor so a thrown error carries a readable `statusCode`.
vi.mock('h3', () => ({
  createError: (error: unknown) => error,
}))

const JSON_CT = 'application/json'
const MORPHO_OPS = ['EulerMigrationMorphoMarkets'] as const

const morphoBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    query: '#graphql\nquery EulerMigrationMorphoMarkets($chainIds: [Int!]) {\n  markets { id }\n}',
    variables: { chainIds: [1] },
    ...overrides,
  })

const rejectsWith = (statusCode: number, run: () => unknown) => {
  try {
    run()
  }
  catch (err) {
    expect((err as { statusCode?: number }).statusCode).toBe(statusCode)
    return
  }
  throw new Error(`expected rejection with status ${statusCode}`)
}

describe('assertAllowedGraphqlRequest', () => {
  it('accepts the exact operation Lite sends and returns the raw body unchanged', () => {
    const body = morphoBody()
    expect(assertAllowedGraphqlRequest(body, JSON_CT, { allowedOperations: MORPHO_OPS })).toBe(body)
    // content-type with charset suffix still passes
    expect(assertAllowedGraphqlRequest(body, 'application/json; charset=utf-8', { allowedOperations: MORPHO_OPS })).toBe(body)
  })

  it('honours an explicit operationName field', () => {
    const body = morphoBody({ operationName: 'EulerMigrationMorphoMarkets' })
    expect(assertAllowedGraphqlRequest(body, JSON_CT, { allowedOperations: MORPHO_OPS })).toBe(body)
  })

  it('accepts every operation in a multi-operation allowlist (markets + positions)', () => {
    const ops = ['EulerMigrationMorphoMarkets', 'LiteMorphoMigrationPositions'] as const
    const positionsBody = JSON.stringify({
      query: '#graphql\nquery LiteMorphoMigrationPositions($chainId: Int!, $address: String!) {\n  userByAddress { marketPositions { market { id } } }\n}',
      variables: { chainId: 1, address: '0x0000000000000000000000000000000000000001' },
    })
    expect(assertAllowedGraphqlRequest(morphoBody(), JSON_CT, { allowedOperations: ops })).toBe(morphoBody())
    expect(assertAllowedGraphqlRequest(positionsBody, JSON_CT, { allowedOperations: ops })).toBe(positionsBody)
  })

  it('rejects a non-JSON content-type (415)', () => {
    rejectsWith(415, () => assertAllowedGraphqlRequest(morphoBody(), 'text/plain', { allowedOperations: MORPHO_OPS }))
  })

  it('rejects an empty body (400)', () => {
    rejectsWith(400, () => assertAllowedGraphqlRequest('', JSON_CT, { allowedOperations: MORPHO_OPS }))
  })

  it('rejects an oversized body (413)', () => {
    const huge = JSON.stringify({ query: `query EulerMigrationMorphoMarkets { ${'a'.repeat(20_000)} }` })
    rejectsWith(413, () => assertAllowedGraphqlRequest(huge, JSON_CT, { allowedOperations: MORPHO_OPS }))
  })

  it('rejects malformed JSON (400)', () => {
    rejectsWith(400, () => assertAllowedGraphqlRequest('{ not json', JSON_CT, { allowedOperations: MORPHO_OPS }))
  })

  it('rejects a JSON array / non-object (400)', () => {
    rejectsWith(400, () => assertAllowedGraphqlRequest('[]', JSON_CT, { allowedOperations: MORPHO_OPS }))
  })

  it('rejects a missing/non-string query (400)', () => {
    rejectsWith(400, () => assertAllowedGraphqlRequest(JSON.stringify({ variables: {} }), JSON_CT, { allowedOperations: MORPHO_OPS }))
  })

  it('rejects non-object variables (400)', () => {
    rejectsWith(400, () => assertAllowedGraphqlRequest(morphoBody({ variables: 'nope' }), JSON_CT, { allowedOperations: MORPHO_OPS }))
  })

  it('rejects a disallowed operation, including introspection (403)', () => {
    rejectsWith(403, () => assertAllowedGraphqlRequest(
      JSON.stringify({ query: 'query SomethingElse { markets { id } }' }),
      JSON_CT,
      { allowedOperations: MORPHO_OPS },
    ))
    rejectsWith(403, () => assertAllowedGraphqlRequest(
      JSON.stringify({ query: 'query IntrospectionQuery { __schema { types { name } } }' }),
      JSON_CT,
      { allowedOperations: MORPHO_OPS },
    ))
  })
})
