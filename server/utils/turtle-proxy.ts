import { readTurtleEarnApiKey } from '~/utils/api-url-env'

/**
 * Credential handling for Turtle Earn requests made by
 * `/api/internal/proxy/turtle` and by the server-side SDK builder.
 *
 * Turtle Earn requires an API key on every request (`X-API-Key`, per Turtle's
 * own 401 body and their Earn API docs). The key is read from the server-only
 * `TURTLE_EARN_API_KEY` variable — never from a `NUXT_PUBLIC_*` name.
 *
 * The upstream is a constant rather than an env override on purpose: because
 * the key rides along, a configurable upstream would turn a misconfigured URL
 * into a credential leak, and nothing needs Turtle traffic pointed elsewhere.
 * Tests intercept `fetch` instead of redirecting the host.
 */
export const TURTLE_EARN_API_URL = 'https://earn.turtle.xyz/v1'

/**
 * Request headers for the Turtle upstream fetch. Returns `undefined` when no
 * key is configured so callers fail closed instead of sending an
 * unauthenticated request that Turtle would reject with 401 anyway.
 */
export function buildTurtleProxyRequestHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const apiKey = readTurtleEarnApiKey(env).trim()
  if (!apiKey) return undefined
  return { 'accept': 'application/json', 'X-API-Key': apiKey }
}
