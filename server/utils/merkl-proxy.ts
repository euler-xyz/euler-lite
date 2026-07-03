import { readMerklApiKey } from '~/utils/api-url-env'

/**
 * Request headers for the Merkl upstream fetch made by `/api/proxy/merkl`.
 *
 * Merkl serves anonymous requests at 10 req/sec, but every user's Merkl read
 * is funnelled through this one server-side proxy origin, so the anonymous
 * quota is shared across all traffic and is the binding limit under load. When
 * `MERKL_API_KEY` is configured we send it as `X-API-Key` for a higher quota;
 * the key stays server-side and is never exposed to the browser. The shape
 * mirrors `buildV3ProxyRequestHeaders` in `v3-proxy.ts`.
 */
export function buildMerklProxyRequestHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const apiKey = readMerklApiKey(env).trim()
  if (apiKey) headers['X-API-Key'] = apiKey
  return headers
}
