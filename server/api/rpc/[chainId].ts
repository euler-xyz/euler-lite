import { createError, getMethod, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { logger } from '~/server/utils/logger'
import { urlHost } from '~/server/utils/observability'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveRpcUrl } from '~/server/utils/rpc'
import { isAbortError } from '~/utils/errorHandling'

const ALLOWED_METHODS = new Set([
  'eth_call',
  'eth_estimateGas',
  // SDK state-override derivation uses createAccessList to find touched
  // storage slots (approval/balance overrides for simulate + estimate).
  'eth_createAccessList',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getLogs',
  'eth_chainId',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getTransactionCount',
  'net_version',
])

const MAX_BATCH_SIZE = 100
const UPSTREAM_TIMEOUT_MS = 30_000

const rateLimiter = createRateLimiter({
  max: 10_000,
  windowMs: 60_000,
  label: 'rpc',
})

interface JsonRpcRequest {
  jsonrpc?: string
  method?: string
  params?: unknown
  id?: unknown
}

// Validates a JSON-RPC 2.0 request object. Requires `id` to be present,
// which means JSON-RPC 2.0 *notifications* (requests without `id`) are
// intentionally rejected — the proxy only handles request/response patterns.
function validateRpcRequest(req: unknown): req is JsonRpcRequest {
  if (typeof req !== 'object' || req === null) return false
  const r = req as Record<string, unknown>
  if (r.jsonrpc !== '2.0') return false
  if (!('id' in r) || (typeof r.id !== 'number' && typeof r.id !== 'string' && r.id !== null)) return false
  if (!('method' in r)) return false
  return true
}

function validateMethod(method: unknown): method is string {
  return typeof method === 'string' && ALLOWED_METHODS.has(method)
}

function rpcMethods(body: unknown): string[] {
  const requests = Array.isArray(body) ? body : [body]
  return [...new Set(requests
    .map(req => typeof req === 'object' && req !== null ? (req as JsonRpcRequest).method : undefined)
    .filter((method): method is string => typeof method === 'string'))].sort()
}

export default defineEventHandler(async (event) => {
  const chainIdRaw = event.context.params?.chainId
  const chainId = Number(chainIdRaw)
  const httpMethod = getMethod(event)

  if (!Number.isInteger(chainId) || chainId <= 0) {
    logger.warn({ ctx: 'rpc-proxy', chainIdRaw, reason: 'invalid-chain-id' }, 'request rejected')
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  if (httpMethod !== 'POST') {
    logger.warn({ ctx: 'rpc-proxy', chainId, reason: 'invalid-http-method', httpMethod }, 'request rejected')
    throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  }

  const rpcUrl = resolveRpcUrl(chainId)
  if (!rpcUrl) {
    logger.warn({ ctx: 'rpc-proxy', chainId, reason: 'rpc-not-configured' }, 'request rejected')
    throw createError({ statusCode: 404, statusMessage: 'RPC not configured' })
  }

  const body = await readBody(event)

  if (body === null || body === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Missing request body' })
  }

  const isBatch = Array.isArray(body)

  if (isBatch) {
    if (body.length === 0) {
      logger.warn({ ctx: 'rpc-proxy', chainId, reason: 'empty-batch' }, 'request rejected')
      throw createError({ statusCode: 400, statusMessage: 'Empty batch request' })
    }
    if (body.length > MAX_BATCH_SIZE) {
      logger.warn({ ctx: 'rpc-proxy', chainId, reason: 'oversize-batch', batchSize: body.length }, 'request rejected')
      throw createError({ statusCode: 400, statusMessage: `Batch size exceeds maximum of ${MAX_BATCH_SIZE}` })
    }
    for (const req of body) {
      if (!validateRpcRequest(req) || !validateMethod(req.method)) {
        logger.warn(
          { ctx: 'rpc-proxy', chainId, reason: 'method-not-allowed', jsonRpcMethod: (req as JsonRpcRequest)?.method ?? 'unknown' },
          'request rejected',
        )
        throw createError({ statusCode: 403, statusMessage: `Method not allowed: ${(req as JsonRpcRequest)?.method ?? 'unknown'}` })
      }
    }
  }
  else {
    if (!validateRpcRequest(body) || !validateMethod(body.method)) {
      logger.warn(
        { ctx: 'rpc-proxy', chainId, reason: 'method-not-allowed', jsonRpcMethod: body?.method ?? 'unknown' },
        'request rejected',
      )
      throw createError({ statusCode: 403, statusMessage: `Method not allowed: ${body?.method ?? 'unknown'}` })
    }
  }

  rateLimiter.consume(event)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  const startedAt = Date.now()
  const methods = rpcMethods(body)
  const batchSize = isBatch ? body.length : 1
  const upstreamHost = urlHost(rpcUrl)

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    })

    setResponseStatus(event, response.status)
    setResponseHeader(event, 'content-type', response.headers.get('content-type') || 'application/json')

    const text = await response.text()
    if (!response.ok) {
      logger.warn(
        {
          ctx: 'rpc-proxy',
          chainId,
          methods,
          batchSize,
          status: response.status,
          durationMs: Date.now() - startedAt,
          upstreamHost,
        },
        'upstream returned non-ok status',
      )
    }
    return text
  }
  catch (error: unknown) {
    if (isAbortError(error)) {
      logger.warn(
        { ctx: 'rpc-proxy', chainId, methods, batchSize, durationMs: Date.now() - startedAt, upstreamHost, timeout: true },
        'upstream timeout',
      )
      throw createError({ statusCode: 504, statusMessage: 'Upstream RPC timeout' })
    }
    logger.warn(
      { ctx: 'rpc-proxy', chainId, methods, batchSize, durationMs: Date.now() - startedAt, upstreamHost, err: error },
      'upstream fetch failed',
    )
    throw createError({ statusCode: 502, statusMessage: 'Upstream RPC error' })
  }
  finally {
    clearTimeout(timeout)
  }
})
