import { resolvePublicLabelsVersion, type PublicEntityLabel } from '@eulerxyz/euler-v2-sdk/public-labels'
import { createTtlCache } from './cache'
import { withWallClock } from './fetchWithTimeout'
import { createInFlightDedup } from './in-flight'
import { readLabelsSource, readV3LabelsSelection } from './labels-base-url'
import { createPublicLabelsRequest, PublicLabelsRequestError } from './public-labels-source'
import { toCuratorProfileEntity, type CuratorProfileData } from '~/utils/curator-profile'
import { readResolvedV3ApiUrl } from '~/utils/api-url-env'

const cache = createTtlCache<CuratorProfileData>({ ttlMs: 5 * 60_000, maxEntries: 128 })
const inFlight = createInFlightDedup<string, CuratorProfileData>()

export const getCuratorProfile = async (entityId: string): Promise<CuratorProfileData> => {
  if (readLabelsSource() === 'static') return { source: 'static', entity: null }

  const selection = readV3LabelsSelection()
  const key = JSON.stringify([readResolvedV3ApiUrl(), selection.labelSet, selection.version, entityId])
  const cached = cache.get(key)
  if (cached) return cached

  return inFlight.run(key, async () => {
    try {
      const result = await withWallClock(async (): Promise<CuratorProfileData> => {
        const request = createPublicLabelsRequest()
        const version = await resolvePublicLabelsVersion(request, selection.version, selection.labelSet)
        const path = `/labels/entities/${entityId}`
        try {
          const response = await request<PublicEntityLabel>(path, { labelSet: selection.labelSet, version })
          if (!response.data || response.data.id !== entityId) throw new Error('Curator profile identity mismatch')
          return { source: 'v3', entity: toCuratorProfileEntity(response.data) }
        }
        catch (error) {
          if (error instanceof PublicLabelsRequestError && error.statusCode === 404) {
            return { source: 'v3', entity: null }
          }
          throw error
        }
      }, 15_000, `curator profile entity=${entityId}`)
      cache.set(key, result)
      return result
    }
    catch (error) {
      const stale = cache.getStale(key)
      if (stale) return stale
      throw error
    }
  })
}
