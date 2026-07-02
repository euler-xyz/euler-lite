import type { H3Event } from 'h3'
import { forceNoStoreCacheHeaders } from '~/server/utils/cache-headers'

export function forceNoStoreForErrorResponse(event: H3Event): void {
  const statusCode = event.node.res.statusCode
  if (statusCode < 400) return

  forceNoStoreCacheHeaders(event)
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (_error, context) => {
    if (context.event) {
      forceNoStoreCacheHeaders(context.event)
    }
  })
  nitroApp.hooks.hook('beforeResponse', (event) => {
    forceNoStoreForErrorResponse(event)
  })
})
