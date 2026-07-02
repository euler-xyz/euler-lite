import { createError, getRequestURL } from 'h3'
import { logger } from '~/server/utils/logger'
import { safePathTemplate } from '~/server/utils/observability'

// 1 MB for RPC, 2 MB for Tenderly
const CLIENT_ERROR_LIMIT = 12 * 1024
const RPC_LIMIT = 1 * 1024 * 1024
const TENDERLY_LIMIT = 2 * 1024 * 1024
const DEFAULT_LIMIT = 1 * 1024 * 1024

function getLimit(pathname: string): number {
  if (pathname === '/api/client-error') return CLIENT_ERROR_LIMIT
  if (pathname.startsWith('/api/tenderly/')) return TENDERLY_LIMIT
  if (pathname.startsWith('/api/rpc/')) return RPC_LIMIT
  return DEFAULT_LIMIT
}

export default defineEventHandler((event) => {
  const method = event.node.req.method
  if (!method || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return
  }

  const url = getRequestURL(event)
  if (!url.pathname.startsWith('/api/')) {
    return
  }

  const contentLength = event.node.req.headers['content-length']
  if (!contentLength) {
    logger.warn({ ctx: 'body-limit', method, pathTemplate: safePathTemplate(url.pathname), reason: 'missing-content-length' }, 'request rejected')
    throw createError({ statusCode: 411, statusMessage: 'Length Required' })
  }

  const length = parseInt(contentLength, 10)
  if (!Number.isInteger(length) || length < 0) {
    logger.warn({ ctx: 'body-limit', method, pathTemplate: safePathTemplate(url.pathname), reason: 'invalid-content-length' }, 'request rejected')
    throw createError({ statusCode: 400, statusMessage: 'Invalid Content-Length' })
  }

  const limit = getLimit(url.pathname)
  if (length > limit) {
    logger.warn(
      { ctx: 'body-limit', method, pathTemplate: safePathTemplate(url.pathname), contentLength: length, limit, reason: 'payload-too-large' },
      'request rejected',
    )
    throw createError({
      statusCode: 413,
      statusMessage: 'Payload Too Large',
    })
  }
})
