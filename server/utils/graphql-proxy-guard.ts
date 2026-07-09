import { createError } from 'h3'

// Migration market queries are a few hundred bytes; 16 KiB leaves generous
// headroom while keeping these public endpoints from accepting large payloads.
const DEFAULT_MAX_GRAPHQL_BODY_BYTES = 16 * 1024

// Captures the operation name in `query Foo(...)` / `mutation Foo` / `subscription Foo`.
const OPERATION_NAME_RE = /\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/

export interface GraphqlProxyGuardOptions {
  /** Operation names Lite is allowed to forward through this proxy. */
  allowedOperations: readonly string[]
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
 *  - an allowlisted operation name (also blocks introspection/arbitrary queries)
 *
 * Throws an h3 4xx error on any violation; returns the original raw body to
 * forward on success.
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

  const resolvedOperation = (typeof operationName === 'string' && operationName)
    || query.match(OPERATION_NAME_RE)?.[1]
    || ''
  if (!options.allowedOperations.includes(resolvedOperation)) {
    throw createError({ statusCode: 403, statusMessage: 'GraphQL operation not allowed' })
  }

  return rawBody
}
