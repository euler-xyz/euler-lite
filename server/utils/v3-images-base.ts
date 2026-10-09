import { readResolvedV3ApiUrl } from '~/utils/api-url-env'
import { parsePublicImagesBaseUrl } from '~/utils/v3-images'
import { fetchWithTimeout } from './fetchWithTimeout'
import { logger } from './logger'
import { buildV3ProxyRequestHeaders } from './v3-proxy'

export const V3_IMAGES_REFRESH_MS = 60 * 60_000
export const V3_IMAGES_RETRY_MS = 5 * 60_000

export type V3ImagesBaseRead
  = | { status: 'ok', baseUrl: string }
    | { status: 'invalid' }
    | { status: 'unreachable' }

export async function readV3ImagesBaseUrl(env: NodeJS.ProcessEnv = process.env): Promise<V3ImagesBaseRead> {
  let response: Response
  try {
    response = await fetchWithTimeout(`${readResolvedV3ApiUrl(env)}/v3/images`, undefined, {
      headers: buildV3ProxyRequestHeaders('GET', env),
    })
  }
  catch {
    return { status: 'unreachable' }
  }
  if (response.status >= 500) return { status: 'unreachable' }
  if (!response.ok) return { status: 'invalid' }
  try {
    const body = await response.json() as { data?: { publicBaseUrl?: unknown } } | null
    const baseUrl = parsePublicImagesBaseUrl(body?.data?.publicBaseUrl)
    return baseUrl ? { status: 'ok', baseUrl } : { status: 'invalid' }
  }
  catch {
    return { status: 'invalid' }
  }
}

export interface V3ImagesBaseSource {
  get: () => string
  refresh: () => Promise<void>
  start: () => Promise<void>
  stop: () => void
}

// An unreachable V3 keeps the last good base so a short outage does not drop
// every logo.
export function createV3ImagesBaseSource(options: {
  read?: () => Promise<V3ImagesBaseRead>
  refreshMs?: number
  retryMs?: number
} = {}): V3ImagesBaseSource {
  const read = options.read ?? (() => readV3ImagesBaseUrl())
  const refreshMs = options.refreshMs ?? V3_IMAGES_REFRESH_MS
  const retryMs = options.retryMs ?? V3_IMAGES_RETRY_MS
  let baseUrl = ''
  let lastStatus: V3ImagesBaseRead['status'] | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const schedule = () => {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(() => {
      void refresh()
    }, baseUrl ? refreshMs : retryMs)
    timer.unref?.()
  }

  const refresh = async () => {
    const result = await read().catch((): V3ImagesBaseRead => ({ status: 'unreachable' }))
    if (result.status === 'ok') baseUrl = result.baseUrl
    if (result.status === 'invalid') baseUrl = ''
    if (result.status !== lastStatus && result.status !== 'ok') {
      logger.warn({ ctx: 'v3-images', reason: result.status, keptPrevious: Boolean(baseUrl) }, 'V3 images base unavailable')
    }
    lastStatus = result.status
    schedule()
  }

  return {
    get: () => baseUrl,
    refresh,
    start: refresh,
    stop: () => {
      stopped = true
      clearTimeout(timer)
    },
  }
}
