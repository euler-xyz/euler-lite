export const LABELS_REFRESH_INTERVAL_MS = 5 * 60_000

export const LABELS_MAX_STALE_MS = 24 * 60 * 60_000

export const isLabelsSnapshotUsable = (sourceFetchedAt: number | undefined, now = Date.now()): boolean =>
  typeof sourceFetchedAt === 'number' && Number.isSafeInteger(sourceFetchedAt)
  && sourceFetchedAt > 0 && sourceFetchedAt <= now
  && now - sourceFetchedAt < LABELS_MAX_STALE_MS
