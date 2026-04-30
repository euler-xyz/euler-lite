/**
 * Scans `process.env` for chain-related environment variables.
 *
 * Lives in `utils/` (not `server/utils/`) so both server-side code
 * (plugins, API handlers) and client-side code executed during SSR
 * (e.g. `useChainConfig` on the server branch) import from a single
 * source of truth. The convention is:
 *   - `RPC_URL_<chainId>` — enables a chain (presence, not value, matters)
 *   - `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` — subgraph URL for that chain
 */
import { getKnownChainIds } from '~/entities/chainRegistry'

export function getConfiguredChainIds(env: NodeJS.ProcessEnv = process.env): number[] {
  const ids: number[] = []
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^RPC_URL_(\d+)$/)
    if (match && value) {
      ids.push(Number(match[1]))
    }
  }
  return ids.sort((a, b) => a - b)
}

export function getEnabledChainIds(env: NodeJS.ProcessEnv = process.env): number[] {
  return getKnownChainIds(getConfiguredChainIds(env))
}

export function getSubgraphUris(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const uris: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^NUXT_PUBLIC_SUBGRAPH_URI_(\d+)$/)
    if (match && value) {
      uris[match[1]] = value
    }
  }
  return uris
}
