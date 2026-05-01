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

const RPC_URL_KEY = /^RPC_URL_(\d+)$/
const SUBGRAPH_URI_KEY = /^NUXT_PUBLIC_SUBGRAPH_URI_(\d+)$/

export interface ChainEnvIssues {
  emptyRpcUrlChainIds: number[]
  malformedRpcUrlChainIds: number[]
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  }
  catch {
    return null
  }
}

function uniqueSorted(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b)
}

function isValidRpcUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false
  return parseHttpUrl(value) != null
}

export function getConfiguredChainIds(env: NodeJS.ProcessEnv = process.env): number[] {
  const ids: number[] = []
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(RPC_URL_KEY)
    if (match && isValidRpcUrl(value)) {
      ids.push(Number(match[1]))
    }
  }
  return uniqueSorted(ids)
}

export function getEnabledChainIds(env: NodeJS.ProcessEnv = process.env): number[] {
  return getKnownChainIds(getConfiguredChainIds(env))
}

export function getChainEnvIssues(env: NodeJS.ProcessEnv = process.env): ChainEnvIssues {
  const emptyRpcUrlChainIds: number[] = []
  const malformedRpcUrlChainIds: number[] = []

  for (const [key, value] of Object.entries(env)) {
    const rpcMatch = key.match(RPC_URL_KEY)
    if (rpcMatch) {
      const chainId = Number(rpcMatch[1])
      if (!value?.trim()) {
        emptyRpcUrlChainIds.push(chainId)
      }
      else if (parseHttpUrl(value) == null) {
        malformedRpcUrlChainIds.push(chainId)
      }
    }
  }

  return {
    emptyRpcUrlChainIds: uniqueSorted(emptyRpcUrlChainIds),
    malformedRpcUrlChainIds: uniqueSorted(malformedRpcUrlChainIds),
  }
}

export function getSubgraphUris(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const uris: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(SUBGRAPH_URI_KEY)
    if (match && value) {
      uris[match[1]] = value
    }
  }
  return uris
}
