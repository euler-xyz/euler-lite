/**
 * Shared scanner for `RPC_URL_HTTP_<chainId>` env vars.
 * Used by chain-config plugin (to inject into HTML) and warm-cache plugin
 * (to iterate chains on startup).
 */
export function getEnabledChainIds(env: NodeJS.ProcessEnv = process.env): number[] {
  const ids: number[] = []
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^RPC_URL_HTTP_(\d+)$/)
    if (match && value) {
      ids.push(Number(match[1]))
    }
  }
  return ids.sort((a, b) => a - b)
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
