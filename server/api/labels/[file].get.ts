import { createError, getQuery, getRouterParam } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logWarn } from '~/server/utils/log'

const TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 300_000

/** The set of label files this proxy serves. Also consumed by warm-cache. */
export const LABEL_FILES = ['products.json', 'entities.json', 'earn-vaults.json', 'points.json'] as const

export type LabelFile = typeof LABEL_FILES[number]

// All label files are optional: any chain may legitimately ship without a given
// file (new chains, test deployments, etc.). Missing or failing upstream fetches
// resolve to a type-appropriate empty payload so clients degrade to "no data"
// uniformly rather than splitting into a required/optional matrix.
const EMPTY_SHAPES: Record<LabelFile, unknown> = {
  'products.json': {},
  'entities.json': {},
  'earn-vaults.json': [],
  'points.json': [],
}

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'labels',
})

const cache = createTtlCache<unknown>({ ttlMs: CACHE_TTL_MS })
/**
 * Collapses concurrent cache-miss callers (e.g. warm-cache firing at the
 * same moment as real client requests) onto a single upstream fetch per
 * `chainId:file` key.
 */
const inFlight = new Map<string, Promise<unknown>>()

/** Fields whose values are rendered as HTML via autoLink() — check for markdown link injection. */
const LINK_TEXT_KEYS = new Set(['description', 'deprecationReason', 'deprecateReason', 'portfolioNotice'])
/** Fields whose values are bound directly to :href in Vue templates. */
const URL_KEYS = new Set(['url'])

/**
 * Detects the markdown-link href-injection pattern: [text](https://..."....)
 * A double-quote inside the URL portion closes the href attribute, allowing
 * additional HTML attributes (e.g. style=) to be injected via HTML parser
 * error-recovery. Bare double-quotes in the link text are harmless.
 */
const MARKDOWN_LINK_INJECTION_RE = /\[[^\]]*\]\(https?:\/\/[^)]*"[^)]*\)/

function isSafeHttpUrl(value: string): boolean {
  if (!value) return true
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

function validateNode(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => validateNode(item, `${path}[${i}]`))
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') {
        if (URL_KEYS.has(key) && !isSafeHttpUrl(value)) {
          throw new Error(`Unsafe URL in ${path}.${key}: protocol must be http or https`)
        }
        if (LINK_TEXT_KEYS.has(key) && MARKDOWN_LINK_INJECTION_RE.test(value)) {
          throw new Error(`Injection pattern detected in ${path}.${key}`)
        }
      }
      else if (value !== null && typeof value === 'object') {
        validateNode(value, `${path}.${key}`)
      }
    }
  }
}

function getUpstreamUrl(chainId: number, file: string): string {
  const baseUrl = (process.env.NUXT_PUBLIC_CONFIG_LABELS_BASE_URL || '').trim().replace(/\/+$/, '')
  if (baseUrl) {
    return `${baseUrl}/${chainId}/${file}`
  }

  const repo = process.env.NUXT_PUBLIC_CONFIG_LABELS_REPO || 'euler-xyz/euler-labels'
  const branch = process.env.NUXT_PUBLIC_CONFIG_LABELS_REPO_BRANCH || 'master'
  return `https://raw.githubusercontent.com/${repo}/refs/heads/${branch}/${chainId}/${file}`
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const file = getRouterParam(event, 'file')
  if (!file || !Object.hasOwn(EMPTY_SHAPES, file)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid file' })
  }

  const query = getQuery(event)
  const chainId = Number(query.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  const key = `${chainId}:${file}`

  const cached = cache.get(key)
  if (cached) return cached

  const existing = inFlight.get(key)
  if (existing) return existing

  const fallback = () => {
    const stale = cache.getStale(key)
    if (stale) return stale
    const empty = EMPTY_SHAPES[file as LabelFile]
    cache.set(key, empty)
    return empty
  }

  const promise = (async () => {
    try {
      const resp = await fetchWithTimeout(getUpstreamUrl(chainId, file), TIMEOUT_MS)
      if (!resp.ok) {
        // 404 is the expected signal for "file not published on this chain".
        // Other non-2xx statuses (403/5xx from CDNs, etc.) are logged once so
        // genuine upstream outages stay visible, then degraded the same way.
        if (resp.status !== 404) {
          logWarn('labels', `${file} upstream returned ${resp.status} for chain ${chainId}; treating as absent`)
        }
        return fallback()
      }

      const data: unknown = await resp.json()
      validateNode(data, file)
      cache.set(key, data)
      return data
    }
    catch (err) {
      logWarn('labels', `Failed to fetch ${file} for chain ${chainId}:`, err instanceof Error ? err.message : err)
      return fallback()
    }
  })().finally(() => { inFlight.delete(key) })

  inFlight.set(key, promise)
  return promise
})
