import { createError, getQuery, getRouterParam, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createInFlightDedup } from '~/server/utils/in-flight'
import { resolveLabelsFileUrl } from '~/server/utils/labels-base-url'
import { reportStatus } from '~/server/utils/log'

const CACHE_TTL_MS = 300_000

/** The set of label files this proxy serves. Also consumed by warm-cache. */
export const LABEL_FILES = ['products.json', 'entities.json', 'earn-vaults.json', 'points.json', 'assets.json'] as const

export type LabelFile = typeof LABEL_FILES[number]

/** Scope for a label fetch: a chain ID for per-chain files, or 'all' for cross-chain rules. */
export type LabelScope = number | 'all'

// All label files are optional: any chain may legitimately ship without a given
// file (new chains, test deployments, etc.). Missing or failing upstream fetches
// resolve to a type-appropriate empty payload so clients degrade to "no data"
// uniformly rather than splitting into a required/optional matrix.
const EMPTY_SHAPES: Record<LabelFile, unknown> = {
  'products.json': {},
  'entities.json': {},
  'earn-vaults.json': [],
  'points.json': [],
  'assets.json': [],
}

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'labels',
})

const cache = createTtlCache<unknown>({ ttlMs: CACHE_TTL_MS })
const inFlight = createInFlightDedup<string, unknown>()

/** Fields whose values are rendered as HTML via autoLink() — check for markdown link injection. */
const LINK_TEXT_KEYS = new Set(['description', 'deprecationReason', 'deprecateReason', 'portfolioNotice'])
/** Fields whose values are bound directly to :href in Vue templates. */
const URL_KEYS = new Set(['url'])
/** Fields whose values must be compilable as regular expressions (assets.json pattern rules). */
const REGEX_KEYS = new Set(['symbolRegex', 'nameRegex'])
/** Cap regex length as a basic ReDoS sanity guard — labels are curated, not user-submitted. */
const MAX_REGEX_LEN = 512
/**
 * Fields whose values are concatenated into image URLs (`${CDN}/${logo}`
 * and `/entities/${logo}`). Must be a bare filename — no slashes, no `..`,
 * no scheme — so a curator slip can't point the browser off-origin or
 * traverse outside the intended asset directory.
 */
const LOGO_FILENAME_KEYS = new Set(['logo'])
const SAFE_LOGO_FILENAME_RE = /^[a-zA-Z0-9_-]+\.(svg|png|jpg|jpeg|webp|gif)$/i
/**
 * Defensive size caps. Labels are trusted but version-controlled; these
 * are there to prevent a mistake (or a compromise of the labels repo)
 * from ballooning a single proxy response into a client-side DoS.
 */
const MAX_STRING_LEN = 16_384
const MAX_ARRAY_LEN = 10_000

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

export function validateNode(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    if (node.length > MAX_ARRAY_LEN) {
      throw new Error(`Array too large at ${path}: ${node.length} exceeds ${MAX_ARRAY_LEN}`)
    }
    node.forEach((item, i) => validateNode(item, `${path}[${i}]`))
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') {
        if (value.length > MAX_STRING_LEN) {
          throw new Error(`String too long at ${path}.${key}: ${value.length} exceeds ${MAX_STRING_LEN}`)
        }
        if (URL_KEYS.has(key) && !isSafeHttpUrl(value)) {
          throw new Error(`Unsafe URL in ${path}.${key}: protocol must be http or https`)
        }
        if (LOGO_FILENAME_KEYS.has(key) && value !== '' && !SAFE_LOGO_FILENAME_RE.test(value)) {
          throw new Error(`Unsafe logo filename in ${path}.${key}: ${value}`)
        }
        if (LINK_TEXT_KEYS.has(key) && MARKDOWN_LINK_INJECTION_RE.test(value)) {
          throw new Error(`Injection pattern detected in ${path}.${key}`)
        }
        if (REGEX_KEYS.has(key)) {
          if (value.length > MAX_REGEX_LEN) {
            throw new Error(`Invalid regex in ${path}.${key}: pattern exceeds ${MAX_REGEX_LEN} chars`)
          }
          try {
            new RegExp(value)
          }
          catch {
            throw new Error(`Invalid regex in ${path}.${key}: ${value}`)
          }
        }
      }
      else if (value !== null && typeof value === 'object') {
        validateNode(value, `${path}.${key}`)
      }
    }
  }
}

function getUpstreamUrl(scope: LabelScope, file: string): string {
  return resolveLabelsFileUrl(scope, file)
}

/**
 * Forces an upstream fetch, bypassing the fresh-cache check. Used by the
 * warm-cache plugin so every cycle actually refreshes the entry instead
 * of cache-hitting a still-fresh value and letting it expire before the
 * next cycle. Collapses concurrent refresh calls per `scope:file` via
 * the in-flight map.
 *
 * `persist=true` writes the empty shape into the cache so subsequent
 * requests skip upstream entirely. Reserved for the absent-file cases
 * (404 and 403 — see below), where the file is legitimately not published
 * for this scope. For other failures (transient 5xx, network errors,
 * JSON parse, validation) return empty but DON'T persist — otherwise a
 * single upstream blip pins the empty allowlist for 5 minutes, making
 * every verified vault appear unverified.
 */
export function refreshLabelFile(scope: LabelScope, file: LabelFile): Promise<unknown> {
  const key = `${scope}:${file}`

  const fallback = (persist: boolean): unknown => {
    const stale = cache.getStale(key)
    if (stale) return stale
    const empty = EMPTY_SHAPES[file]
    if (persist) cache.set(key, empty)
    return empty
  }

  return inFlight.run(key, async (): Promise<unknown> => {
    const statusKey = `${file}:${scope}`
    try {
      const resp = await fetchWithTimeout(getUpstreamUrl(scope, file))
      if (!resp.ok) {
        // 404 and 403 are both expected signals for "file not published
        // at this scope". The labels CDN (S3+CloudFront origin without
        // ListBucket grant) returns 403 AccessDenied for missing keys
        // rather than 404, so we treat them identically: persist the
        // empty fallback and stay quiet on subsequent warm cycles.
        // Other non-2xx statuses (5xx etc.) are reported as transitions
        // so the first occurrence surfaces but repeats do not.
        if (resp.status === 404 || resp.status === 403) {
          reportStatus('labels', statusKey, `absent-${resp.status}`)
          return fallback(true)
        }
        reportStatus('labels', statusKey, `http-${resp.status}`,
          `${file} upstream returned ${resp.status} for scope ${scope}; treating as absent`)
        return fallback(false)
      }

      const data: unknown = await resp.json()
      validateNode(data, file)
      cache.set(key, data)
      reportStatus('labels', statusKey, 'ok')
      return data
    }
    catch (err) {
      reportStatus('labels', statusKey, 'fetch-error',
        `Failed to fetch ${file} for scope ${scope}: ${err instanceof Error ? err.message : err}`)
      return fallback(false)
    }
  })
}

// Read-through helper: cache hit → return synchronously; otherwise refresh.
// Used by the handler's assets.json union so each source can be served from
// its own cache entry without triggering two upstream fetches on a warm cache,
// and by the sibling path-shape handler so the SDK's default URL template gets
// the same TTL short-circuit instead of one upstream fetch per request.
export async function getOrRefresh(scope: LabelScope, file: LabelFile): Promise<unknown> {
  const hit = cache.get(`${scope}:${file}`)
  if (hit !== undefined) return hit
  return refreshLabelFile(scope, file)
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

  // Labels are curated external metadata — CDN can short-circuit polls
  // between warm cycles.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')

  // assets.json is unioned with the cross-chain `all/assets.json` so global
  // pattern rules (e.g. by issuer symbol) apply to every chain without the
  // client knowing about the separate source.
  if (file === 'assets.json') {
    const [chainData, globalData] = await Promise.all([
      getOrRefresh(chainId, 'assets.json'),
      getOrRefresh('all', 'assets.json'),
    ])
    const chainArr = Array.isArray(chainData) ? chainData : []
    const globalArr = Array.isArray(globalData) ? globalData : []
    return [...chainArr, ...globalArr]
  }

  return await getOrRefresh(chainId, file as LabelFile)
})
