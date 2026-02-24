import { createError, getMethod, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveRpcUrl } from '~/server/utils/rpc'
import { isAbortError } from '~/utils/errorHandling'

const ALLOWED_METHODS = new Set([
  'eth_call',
  'eth_estimateGas',
  'eth_sendRawTransaction',
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
  max: 200,
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

export default defineEventHandler(async (event) => {
  const chainIdRaw = event.context.params?.chainId
  const chainId = Number(chainIdRaw)

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  if (getMethod(event) !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  }

  const rpcUrl = resolveRpcUrl(chainId)
  if (!rpcUrl) {
    throw createError({ statusCode: 404, statusMessage: 'RPC not configured' })
  }

  const body = await readBody(event)

  if (body === null || body === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Missing request body' })
  }

  const isBatch = Array.isArray(body)

  if (isBatch) {
    if (body.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Empty batch request' })
    }
    if (body.length > MAX_BATCH_SIZE) {
      throw createError({ statusCode: 400, statusMessage: `Batch size exceeds maximum of ${MAX_BATCH_SIZE}` })
    }
    for (const req of body) {
      if (!validateRpcRequest(req) || !validateMethod(req.method)) {
        throw createError({ statusCode: 403, statusMessage: `Method not allowed: ${(req as JsonRpcRequest)?.method ?? 'unknown'}` })
      }
    }
  }
  else {
    if (!validateRpcRequest(body) || !validateMethod(body.method)) {
      throw createError({ statusCode: 403, statusMessage: `Method not allowed: ${body?.method ?? 'unknown'}` })
    }
  }

  const cost = isBatch ? body.length : 1
  rateLimiter.consume(event, cost)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    })

    setResponseStatus(event, response.status)
    setResponseHeader(event, 'content-type', response.headers.get('content-type') || 'application/json')

    return await response.text()
  }
  catch (error: unknown) {
    if (isAbortError(error)) {
      throw createError({ statusCode: 504, statusMessage: 'Upstream RPC timeout' })
    }
    throw createError({ statusCode: 502, statusMessage: 'Upstream RPC error' })
  }
  finally {
    clearTimeout(timeout)
  }
})
