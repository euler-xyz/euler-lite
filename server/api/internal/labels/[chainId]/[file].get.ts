/**
 * Path-shape labels endpoint that mirrors the SDK's default URL template
 *
 *   `${eulerLabelsBaseUrl}/${chainId}/${file}.json`
 *
 * Point the SDK at `eulerLabelsBaseUrl: '/api/internal/labels'` and its built-in
 * fetcher hits this endpoint instead of `raw.githubusercontent.com`.
 *
 * `chainId` is either an integer or the literal string `all` (for the
 * cross-chain `all/assets.json` file the SDK's
 * `getEulerLabelsGlobalAssetsUrl` calls). Anything else 400s.
 *
 * Calls `refreshLabelFile` from the sibling query-shape endpoint, so both
 * paths share one in-memory TTL cache and one upstream-fetch pipeline.
 * Unlike the query-shape handler, this route does not short-circuit on a
 * fresh cache entry: every request force-refreshes (joining any in-flight
 * fetch for the same `scope:file`), and the shared cache is used for writes
 * and stale fallback only.
 */
import { createError, getRouterParam, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import {
  LABEL_FILES,
  refreshLabelFile,
  type LabelFile,
  type LabelScope,
} from '~/server/api/internal/labels/[file].get'

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'labels-by-path',
})

const isLabelFile = (file: string): file is LabelFile =>
  (LABEL_FILES as readonly string[]).includes(file)

const parseScope = (raw: string | undefined): LabelScope | undefined => {
  if (!raw) return undefined
  if (raw === 'all') return 'all'
  const n = Number(raw)
  if (Number.isInteger(n) && n > 0) return n
  return undefined
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const file = getRouterParam(event, 'file')
  if (!file || !isLabelFile(file)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid label file' })
  }

  const scope = parseScope(getRouterParam(event, 'chainId'))
  if (scope === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId (use an integer or "all")' })
  }

  // Pure pass-through: no chain/global union here. The SDK calls the
  // global file via a separate `getEulerLabelsGlobalAssetsUrl()` and
  // composes the result itself.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
  return await refreshLabelFile(scope, file)
})
