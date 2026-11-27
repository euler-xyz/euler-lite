import type { H3Event } from 'h3'

/**
 * Use h3's already-decoded route path, excluding the query.
 * getRequestURL preserves originalUrl; decoding or normalizing again can
 * disagree with the router.
 */
export function getRouterPathname(event: H3Event): string {
  const queryIndex = event.path.indexOf('?')
  return queryIndex === -1 ? event.path : event.path.slice(0, queryIndex)
}
