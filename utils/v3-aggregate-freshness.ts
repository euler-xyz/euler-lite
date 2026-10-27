const MINUTE = 60_000

/** euler-data-v3 recomputes bad debt and open interest every 15 minutes (its `src/lib/env.ts` defaults). */
export const V3_AGGREGATE_RECOMPUTE_MS = 15 * MINUTE

export interface V3AggregateCopy {
  refreshedAt: string | null
  readAt: number
}

/** A copy is due for a re-read once V3's next recompute after `refreshedAt` is; without that time, one recompute after it was read. */
export const isV3AggregateRereadDue = (copy: V3AggregateCopy, now = Date.now()): boolean => {
  const refreshedAt = copy.refreshedAt ? Date.parse(copy.refreshedAt) : Number.NaN
  const base = Number.isFinite(refreshedAt) ? refreshedAt : copy.readAt
  return now >= base + V3_AGGREGATE_RECOMPUTE_MS
}

export const readV3RefreshedAt = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null
  const refreshedAt = (body as { meta?: { refreshedAt?: unknown } }).meta?.refreshedAt
  return typeof refreshedAt === 'string' ? refreshedAt : null
}
