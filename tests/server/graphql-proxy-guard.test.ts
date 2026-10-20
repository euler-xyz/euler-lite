import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { assertAllowedGraphqlRequest } from '~/server/utils/graphql-proxy-guard'
import { AAVE_ALLOWED_OPERATIONS, MORPHO_ALLOWED_OPERATIONS } from '~/server/utils/migration-graphql-policy'
import { AAVE_MARKETS_QUERY, MORPHO_MARKETS_QUERY, MORPHO_USER_POSITIONS_QUERY } from '~/utils/migration-graphql'

vi.mock('h3', () => ({ createError: (error: unknown) => error }))

const address = '0x0000000000000000000000000000000000000001'
const cases = [
  { name: 'AaveMigrationMarkets', query: AAVE_MARKETS_QUERY, variables: { request: { chainIds: [1] } }, allowedOperations: AAVE_ALLOWED_OPERATIONS },
  { name: 'EulerMigrationMorphoMarkets', query: MORPHO_MARKETS_QUERY, variables: { chainIds: [1], loanAssets: [address], collateralAssets: [address] }, allowedOperations: MORPHO_ALLOWED_OPERATIONS },
  { name: 'LiteMorphoMigrationPositions', query: MORPHO_USER_POSITIONS_QUERY, variables: { chainId: 1, address }, allowedOperations: MORPHO_ALLOWED_OPERATIONS },
]
const run = (payload: unknown, allowedOperations = MORPHO_ALLOWED_OPERATIONS, contentType = 'application/json') =>
  assertAllowedGraphqlRequest(JSON.stringify(payload), contentType, { allowedOperations })

const rejectsWith = (statusCode: number, run: () => unknown) => {
  expect.assertions(1)
  try {
    run()
  }
  catch (error) {
    expect(error).toMatchObject({ statusCode })
    return
  }
  throw new Error(`Expected ${statusCode}`)
}

describe('migration GraphQL proxy policy', () => {
  it.each(cases)('preserves the actual $name document and variables', ({ name, query, variables, allowedOperations }) => {
    for (const operationName of [undefined, name]) {
      const body = JSON.stringify({ query: `\n${query}\n`, variables, operationName })
      expect(assertAllowedGraphqlRequest(body, 'application/json; charset=utf-8', { allowedOperations })).toBe(body)
    }
  })

  it.each([
    ['aave', 'AAVE_MARKETS_QUERY', AAVE_MARKETS_QUERY],
    ['morpho', 'MORPHO_MARKETS_QUERY', MORPHO_MARKETS_QUERY],
  ])('matches the installed SDK %s document', (connector, name, document) => {
    const source = readFileSync(`node_modules/@eulerxyz/euler-v2-sdk/dist/src/services/positionMigrationService/connectors/${connector}/${connector}Connector.js`, 'utf8')
    const literal = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'))?.[1]
    expect(literal).toBe(document)
  })

  it.each(cases)('blocks introspection under the approved $name name', ({ name, allowedOperations }) => {
    rejectsWith(403, () => run({ query: `query ${name} { __schema { types { name } } }`, operationName: name }, allowedOperations))
  })

  it.each([
    ['extra operation', (query: string) => `${query}\nquery Hidden { __schema { types { name } } }`],
    ['fragment', (query: string) => `${query}\nfragment Hidden on Query { __typename }`],
    ['alias', (query: string) => query.replace('markets(', 'other: markets(')],
    ['pagination', (query: string) => query.replace('first: 100', 'first: 1000000')],
    ['comment spoofing', () => '# query EulerMigrationMorphoMarkets\n{ __schema { types { name } } }'],
    ['mutation', (query: string) => query.replace('query Euler', 'mutation Euler')],
  ])('rejects an altered document: %s', (_, transform) => {
    rejectsWith(403, () => run({ query: transform(MORPHO_MARKETS_QUERY), operationName: 'EulerMigrationMorphoMarkets', variables: cases[1].variables }))
  })

  it('rejects a mismatched explicit operation name', () => {
    rejectsWith(403, () => run({ ...cases[1], operationName: 'LiteMorphoMigrationPositions' }))
  })

  it.each([
    {},
    { chainIds: null, loanAssets: [address], collateralAssets: [address] },
    { chainIds: [1, 2], loanAssets: [address], collateralAssets: [address] },
    { chainIds: [1], loanAssets: null, collateralAssets: [address] },
    { chainIds: [1], loanAssets: [address, address], collateralAssets: [address] },
    { chainIds: [1], loanAssets: [address], collateralAssets: [address], first: 1000000 },
  ])('rejects widened Morpho filters %j', (variables) => {
    rejectsWith(400, () => run({ query: MORPHO_MARKETS_QUERY, variables }))
  })

  it('rejects Aave request fields outside the single chain contract', () => {
    rejectsWith(400, () => run({ query: AAVE_MARKETS_QUERY, variables: { request: { chainIds: [1], first: 1000000 } } }, AAVE_ALLOWED_OPERATIONS))
  })

  it.each([0, -1, 1.5, '1', 0x80000000])('rejects invalid position chain %j', (chainId) => {
    rejectsWith(400, () => run({ query: MORPHO_USER_POSITIONS_QUERY, variables: { chainId, address } }))
  })

  it('rejects an invalid address', () => {
    rejectsWith(400, () => run({ query: MORPHO_USER_POSITIONS_QUERY, variables: { chainId: 1, address: 'anything' } }))
  })

  it('rejects extensions that can change upstream execution', () => {
    rejectsWith(400, () => run({ query: MORPHO_MARKETS_QUERY, variables: cases[1].variables, extensions: { persistedQuery: {} } }))
  })

  it('forwards only the validated value of duplicate JSON keys', () => {
    const body = `{"query":"query Hidden { __schema { types { name } } }",${JSON.stringify({ query: MORPHO_MARKETS_QUERY, variables: cases[1].variables }).slice(1)}`
    const forwarded = assertAllowedGraphqlRequest(body, 'application/json', { allowedOperations: MORPHO_ALLOWED_OPERATIONS })
    expect(forwarded).toBe(JSON.stringify({ query: MORPHO_MARKETS_QUERY, variables: cases[1].variables }))
  })

  it.each([
    [415, () => run({}, undefined, 'text/plain')],
    [400, () => assertAllowedGraphqlRequest('', 'application/json', { allowedOperations: MORPHO_ALLOWED_OPERATIONS })],
    [400, () => assertAllowedGraphqlRequest('{broken', 'application/json', { allowedOperations: MORPHO_ALLOWED_OPERATIONS })],
    [400, () => run([])],
    [400, () => run({ variables: {} })],
    [400, () => run({ query: MORPHO_MARKETS_QUERY, variables: 'nope' })],
    [400, () => run({ query: MORPHO_MARKETS_QUERY, operationName: 1 })],
    [413, () => run({ query: 'x'.repeat(20000) })],
  ] as const)('preserves input rejection %s', (status, action) => rejectsWith(status, action))
})
