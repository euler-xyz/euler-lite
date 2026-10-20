import { createHash } from 'node:crypto'
import { withWallClock } from './fetchWithTimeout'

export type SubgraphUnavailableReason = 'disabled' | 'missing' | 'retired' | 'invalid' | 'unsupported-capability' | 'catalog-unavailable'
export class SubgraphUnavailableError extends Error {
  constructor(public readonly reason: SubgraphUnavailableReason) {
    super(`Subgraph unavailable: ${reason}`)
  }
}
export interface SubgraphSource {
  endpoint: string
  identity: string
  deploymentId?: string
}
type Row = { endpoint: string, deploymentId: string, capabilities: string[] } | SubgraphUnavailableReason
const requiredCapabilities = ['account-vault-discovery', 'vault-factory-lookup']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const validEndpoint = (value: unknown): value is string => {
  if (!nonempty(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  }
  catch { return false }
}

export function parseSubgraphCatalog(input: unknown): Map<number, Row> {
  if (!object(input) || input.schemaVersion !== 1 || !nonempty(input.revision)
    || !nonempty(input.publishedAt) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.publishedAt) || !Number.isFinite(Date.parse(input.publishedAt)) || !Array.isArray(input.deployments)) {
    throw new SubgraphUnavailableError('invalid')
  }
  const rows = new Map<number, Row>()
  for (const entry of input.deployments) {
    if (!object(entry) || entry.family !== 'euler-simple' || entry.channel !== 'stable') continue
    const chainId = entry.chainId
    if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) continue
    if (rows.has(chainId)) {
      rows.set(chainId, 'invalid')
      continue
    }
    if (entry.status === 'retired') {
      rows.set(chainId, 'retired')
      continue
    }
    if (entry.status !== 'active' || !validEndpoint(entry.endpoint)
      || !nonempty(entry.deploymentId) || !nonempty(entry.sourceCommit) || !/^[a-fA-F0-9]{40}$/.test(entry.sourceCommit)
      || !nonempty(entry.version) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(entry.version)
      || !Number.isSafeInteger(entry.startBlock) || (entry.startBlock as number) < 0
      || (entry.interfacesCommit !== undefined && (!nonempty(entry.interfacesCommit) || !/^[a-fA-F0-9]{40}$/.test(entry.interfacesCommit)))
      || !Array.isArray(entry.capabilities) || !entry.capabilities.every(nonempty)) {
      rows.set(chainId, 'invalid')
      continue
    }
    rows.set(chainId, { endpoint: entry.endpoint, deploymentId: entry.deploymentId, capabilities: entry.capabilities })
  }
  return rows
}

/** Metadata only: freshness 60s, last successful snapshot usable for at most 5m. */
export function createSubgraphResolver({
  env = process.env,
  now = Date.now,
  fetchCatalog = async (url: string): Promise<unknown> => {
    const controller = new AbortController()
    try {
      return await withWallClock(async () => {
        const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
        if (!response.ok) throw new Error('Catalog HTTP failure')
        if (!response.body) throw new Error('Catalog response has no body')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let size = 0
        let text = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 1_000_000) {
              void reader.cancel().catch(() => {})
              throw new Error('Catalog exceeds size limit')
            }
            text += decoder.decode(value, { stream: true })
          }
          text += decoder.decode()
        }
        finally { reader.releaseLock() }
        return JSON.parse(text)
      }, 5_000, 'Subgraph catalog')
    }
    finally { controller.abort() }
  },
}: {
  env?: Record<string, string | undefined>
  now?: () => number
  fetchCatalog?: (url: string) => Promise<unknown>
} = {}) {
  let cached: { url: string, rows: Map<number, Row>, fetchedAt: number } | undefined
  let pending: { url: string, promise: Promise<Map<number, Row>> } | undefined
  let failed: { url: string, retryAt: number, reason: SubgraphUnavailableReason } | undefined
  const getRows = async (url: string) => {
    if (cached?.url === url && now() - cached.fetchedAt < 60_000) return cached.rows
    if (pending?.url === url) return pending.promise
    if (failed?.url === url && now() < failed.retryAt) {
      if (cached?.url === url && now() - cached.fetchedAt < 300_000) return cached.rows
      throw new SubgraphUnavailableError(failed.reason)
    }
    const promise = (async () => {
      try {
        const rows = parseSubgraphCatalog(await fetchCatalog(url))
        cached = { url, rows, fetchedAt: now() }
        failed = undefined
        return rows
      }
      catch (error) {
        const reason = error instanceof SubgraphUnavailableError ? error.reason : 'catalog-unavailable'
        failed = { url, retryAt: now() + 10_000, reason }
        if (cached?.url === url && now() - cached.fetchedAt < 300_000) return cached.rows
        throw new SubgraphUnavailableError(reason)
      }
      finally { pending = undefined }
    })()
    pending = { url, promise }
    return promise
  }
  return async (chainId: number): Promise<SubgraphSource> => {
    // An explicit disable also disables operator URLs. Empty values mean unset.
    if (env[`SUBGRAPH_DISABLED_${chainId}`]?.trim() === 'true') throw new SubgraphUnavailableError('disabled')
    const endpoint = env[`SUBGRAPH_URL_${chainId}`]?.trim() || env[`NUXT_PUBLIC_SUBGRAPH_URI_${chainId}`]?.trim()
    if (endpoint) return { endpoint, identity: createHash('sha256').update(endpoint).digest('hex') }
    const url = env.SUBGRAPH_CATALOG_URL?.trim()
    if (!url || env.SUBGRAPH_CATALOG_DISABLED?.trim() === 'true') throw new SubgraphUnavailableError('missing')
    const row = (await getRows(url)).get(chainId)
    if (!row) throw new SubgraphUnavailableError('missing')
    if (typeof row === 'string') throw new SubgraphUnavailableError(row)
    if (!requiredCapabilities.every(capability => row.capabilities.includes(capability))) throw new SubgraphUnavailableError('unsupported-capability')
    return {
      endpoint: row.endpoint,
      deploymentId: row.deploymentId,
      identity: createHash('sha256').update(JSON.stringify([url, row.endpoint, row.deploymentId])).digest('hex'),
    }
  }
}

export const resolveSubgraphSource = createSubgraphResolver()
