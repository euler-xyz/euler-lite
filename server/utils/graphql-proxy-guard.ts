import { createError } from 'h3'

// Migration market queries are a few hundred bytes; 16 KiB leaves generous
// headroom while keeping these public endpoints from accepting large payloads.
const DEFAULT_MAX_GRAPHQL_BODY_BYTES = 16 * 1024

export interface AllowedGraphqlOperation {
  name: string
  query: string
  validateVariables: (variables: Record<string, unknown>) => boolean
}

export interface GraphqlProxyGuardOptions {
  /** Exact documents and variable contracts Lite forwards through this proxy. */
  allowedOperations: readonly AllowedGraphqlOperation[]
  /** Overrides the default request body cap. */
  maxBytes?: number
}

/**
 * Bounds a GraphQL request before a same-origin proxy forwards it to a fixed
 * third-party upstream (Morpho / Aave migration discovery). These proxies are
 * public app-server endpoints, so we refuse anything outside the narrow
 * contract Lite actually sends:
 *  - JSON content-type
 *  - a small body-size cap
 *  - a well-formed `{ query: string, variables?: object, operationName?: string }`
 *  - an exact allowlisted document and bounded variables
 *
 * Throws an h3 4xx error on any violation; serializes the validated payload
 * so upstream JSON parsing sees the same fields and values as the guard.
 */
export function assertAllowedGraphqlRequest(
  rawBody: string,
  contentType: string,
  options: GraphqlProxyGuardOptions,
): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_GRAPHQL_BODY_BYTES

  if (!contentType.toLowerCase().includes('application/json')) {
    throw createError({ statusCode: 415, statusMessage: 'Expected application/json' })
  }
  if (!rawBody) {
    throw createError({ statusCode: 400, statusMessage: 'Empty GraphQL body' })
  }
  if (Buffer.byteLength(rawBody, 'utf8') > maxBytes) {
    throw createError({ statusCode: 413, statusMessage: 'GraphQL body too large' })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Malformed JSON body' })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid GraphQL request' })
  }

  const { query, variables, operationName } = parsed as Record<string, unknown>
  if (typeof query !== 'string' || query.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Missing GraphQL query' })
  }
  if (variables !== undefined
    && (typeof variables !== 'object' || variables === null || Array.isArray(variables))) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid GraphQL variables' })
  }
  if (operationName !== undefined && typeof operationName !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Invalid GraphQL operationName' })
  }

  // Match the whole document: names alone do not constrain fields, aliases,
  // fragments, extra operations, or pagination. Only outer whitespace varies.
  const allowed = options.allowedOperations.find(operation => operation.query.trim() === query.trim())
  if (!allowed || (operationName !== undefined && operationName !== allowed.name)) {
    throw createError({ statusCode: 403, statusMessage: 'GraphQL operation not allowed' })
  }
  if (Object.keys(parsed).some(key => !['query', 'variables', 'operationName'].includes(key))) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid GraphQL request' })
  }
  if (!allowed.validateVariables((variables ?? {}) as Record<string, unknown>)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid GraphQL variables' })
  }

  return JSON.stringify({ query: allowed.query, variables, operationName })
}
