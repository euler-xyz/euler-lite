import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchPublicGeoPolicies, validatePublicGeoPolicies, type PublicGeoPolicy, type PublicLabelsRequest } from '@eulerxyz/euler-v2-sdk/public-labels'
import { logger } from './logger'
import { withWallClock } from './fetchWithTimeout'

interface GeoSnapshot { fetchedAt: number, policies: PublicGeoPolicy[] }

/** A source-specific disk checkpoint survives process restarts; mount the directory for redeploys. */
export const createGeoPolicySource = (source: string, directory: string) => {
  const file = join(directory, `${createHash('sha256').update(source).digest('hex')}.json`)
  let lastGood: GeoSnapshot | undefined
  let pending: Promise<GeoSnapshot> | undefined
  let diskLoaded = false

  const refresh = async (request: PublicLabelsRequest): Promise<GeoSnapshot> => {
    if (!diskLoaded) {
      diskLoaded = true
      try {
        const saved = JSON.parse(await readFile(file, 'utf8')) as GeoSnapshot
        if (!Number.isFinite(saved.fetchedAt) || saved.fetchedAt <= 0 || saved.fetchedAt > Date.now()) throw new Error('Invalid geo checkpoint timestamp')
        lastGood = { fetchedAt: saved.fetchedAt, policies: validatePublicGeoPolicies(saved.policies) }
      }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ ctx: 'geo-policy-source', err }, 'geo checkpoint unavailable')
      }
    }
    try {
      const policies = await withWallClock(() => fetchPublicGeoPolicies(request), 10_000, 'geo-policies')
      const snapshot = { policies, fetchedAt: Date.now() }
      // A failed checkpoint write must not cause use of older, less restrictive live rules.
      lastGood = snapshot
      try {
        await mkdir(directory, { recursive: true })
        const temporary = `${file}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 })
        await rename(temporary, file)
      }
      catch (err) {
        logger.warn({ ctx: 'geo-policy-source', err }, 'geo checkpoint write failed; restart persistence unavailable')
      }
      return snapshot
    }
    catch (err) {
      if (!lastGood) throw err
      logger.warn({ ctx: 'geo-policy-source', ageMs: Date.now() - lastGood.fetchedAt, fetchedAt: lastGood.fetchedAt, err }, 'using last-known-good geo policies')
      return lastGood
    }
  }
  return (request: PublicLabelsRequest): Promise<GeoSnapshot> => {
    if (pending) return pending
    // Freshness is bounded; stale use is permitted only after a failed refresh.
    if (lastGood && Date.now() - lastGood.fetchedAt < 300_000) return Promise.resolve(lastGood)
    pending = refresh(request).finally(() => {
      pending = undefined
    })
    return pending
  }
}
