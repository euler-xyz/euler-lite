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
const MAX_PARAMS_BYTES = 256 * 1024
const MAX_CALLDATA_BYTES = 256 * 1024
const MAX_EXPLICIT_GAS = 50_000_000n
const MAX_STATE_OVERRIDE_ACCOUNTS = 128
const MAX_STATE_OVERRIDE_SLOTS = 2_048
const MAX_STATE_OVERRIDE_CODE_BYTES = 64 * 1024
const MAX_FEE_HISTORY_BLOCKS = 128n
const MAX_REWARD_PERCENTILES = 20
const MAX_LOG_BLOCK_RANGE = 10_000n
const MAX_LOG_ADDRESSES = 20
const MAX_LOG_TOPIC_POSITIONS = 4
const MAX_LOG_TOPIC_OR_VALUES = 20

const CALLDATA_COST_CHUNK_BYTES = 16 * 1024
const GAS_COST_CHUNK = 5_000_000n
const STATE_OVERRIDE_SLOT_COST_CHUNK = 16
const STATE_OVERRIDE_CODE_COST_CHUNK_BYTES = 16 * 1024
const LOG_RANGE_COST_CHUNK = 1_000n
const FEE_HISTORY_COST_CHUNK = 16n
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

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidParams(statusMessage: string, statusCode = 400): never {
  throw createError({ statusCode, statusMessage })
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  }
  catch {
    return invalidParams('Invalid RPC params')
  }
}

function hexDataByteLength(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    return invalidParams(`Invalid ${label}`)
  }
  return (value.length - 2) / 2
}

function parseHexQuantity(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value) || value.length > 66) {
    return invalidParams(`Invalid ${label}`)
  }
  return BigInt(value)
}

function steppedModifier(value: number, chunk: number): number {
  return Math.max(0, Math.ceil(value / chunk) - 1)
}

function steppedBigIntModifier(value: bigint, chunk: bigint): number {
  if (value <= chunk) return 0
  return Number((value + chunk - 1n) / chunk - 1n)
}

function assessStateOverride(value: unknown): number {
  if (!isJsonObject(value)) return invalidParams('Invalid RPC state override')

  const accounts = Object.values(value)
  if (accounts.length > MAX_STATE_OVERRIDE_ACCOUNTS) {
    return invalidParams(`RPC state override exceeds ${MAX_STATE_OVERRIDE_ACCOUNTS} accounts`)
  }

  let slotCount = 0
  let codeBytes = 0

  for (const account of accounts) {
    if (!isJsonObject(account)) return invalidParams('Invalid RPC state override account')

    for (const key of ['state', 'stateDiff'] as const) {
      const mapping = account[key]
      if (mapping === undefined) continue
      if (!isJsonObject(mapping)) return invalidParams(`Invalid RPC state override ${key}`)
      slotCount += Object.keys(mapping).length
      if (slotCount > MAX_STATE_OVERRIDE_SLOTS) {
        return invalidParams(`RPC state override exceeds ${MAX_STATE_OVERRIDE_SLOTS} storage slots`)
      }
    }

    if (account.code !== undefined) {
      codeBytes += hexDataByteLength(account.code, 'RPC state override code')
      if (codeBytes > MAX_STATE_OVERRIDE_CODE_BYTES) {
        return invalidParams(`RPC state override code exceeds ${MAX_STATE_OVERRIDE_CODE_BYTES} bytes`)
      }
    }
  }

  return 5
    + accounts.length
    + Math.ceil(slotCount / STATE_OVERRIDE_SLOT_COST_CHUNK)
    + Math.ceil(codeBytes / STATE_OVERRIDE_CODE_COST_CHUNK_BYTES)
}

function assessTransactionParams(params: unknown): number {
  if (!Array.isArray(params)) return 0
  const transaction = params[0]
  if (!isJsonObject(transaction)) return 0

  let calldataBytes = 0
  for (const key of ['data', 'input'] as const) {
    if (transaction[key] === undefined) continue
    calldataBytes += hexDataByteLength(transaction[key], 'RPC calldata')
  }
  if (calldataBytes > MAX_CALLDATA_BYTES) {
    return invalidParams(`RPC calldata exceeds ${MAX_CALLDATA_BYTES} bytes`, 413)
  }

  let cost = steppedModifier(calldataBytes, CALLDATA_COST_CHUNK_BYTES)
  if (transaction.gas !== undefined) {
    const gas = parseHexQuantity(transaction.gas, 'RPC gas limit')
    if (gas > MAX_EXPLICIT_GAS) {
      return invalidParams(`RPC gas limit exceeds ${MAX_EXPLICIT_GAS}`)
    }
    cost += steppedBigIntModifier(gas, GAS_COST_CHUNK)
  }

  const stateOverride = params[2]
  if (stateOverride !== undefined && stateOverride !== null) {
    cost += assessStateOverride(stateOverride)
  }

  return cost
}

function validateLogAddress(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function validateLogTopic(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

function assessLogFilter(params: unknown): number {
  if (!Array.isArray(params) || !isJsonObject(params[0])) {
    return invalidParams('Invalid eth_getLogs filter')
  }
  const filter = params[0]
  const hasBlockHash = filter.blockHash !== undefined
  const hasFromBlock = filter.fromBlock !== undefined
  const hasToBlock = filter.toBlock !== undefined

  let range = 0n
  if (hasBlockHash) {
    if (!validateLogTopic(filter.blockHash) || hasFromBlock || hasToBlock) {
      return invalidParams('eth_getLogs requires blockHash or an explicit block range')
    }
  }
  else {
    if (!hasFromBlock || !hasToBlock) {
      return invalidParams('eth_getLogs requires blockHash or an explicit block range')
    }
    if (filter.fromBlock === 'latest' || filter.toBlock === 'latest') {
      if (filter.fromBlock !== 'latest' || filter.toBlock !== 'latest') {
        return invalidParams('Invalid eth_getLogs block range')
      }
      range = 1n
    }
    else {
      const fromBlock = parseHexQuantity(filter.fromBlock, 'eth_getLogs fromBlock')
      const toBlock = parseHexQuantity(filter.toBlock, 'eth_getLogs toBlock')
      if (toBlock < fromBlock) return invalidParams('Invalid eth_getLogs block range')
      range = toBlock - fromBlock + 1n
    }
    if (range > MAX_LOG_BLOCK_RANGE) {
      return invalidParams(`eth_getLogs block range exceeds ${MAX_LOG_BLOCK_RANGE}`)
    }
  }

  let hasRestrictiveFilter = false
  if (filter.address !== undefined) {
    const addresses = Array.isArray(filter.address) ? filter.address : [filter.address]
    if (addresses.length === 0 || addresses.length > MAX_LOG_ADDRESSES || !addresses.every(validateLogAddress)) {
      return invalidParams(`Invalid eth_getLogs address filter (maximum ${MAX_LOG_ADDRESSES})`)
    }
    hasRestrictiveFilter = true
  }

  if (filter.topics !== undefined) {
    if (!Array.isArray(filter.topics) || filter.topics.length > MAX_LOG_TOPIC_POSITIONS) {
      return invalidParams(`Invalid eth_getLogs topics filter (maximum ${MAX_LOG_TOPIC_POSITIONS} positions)`)
    }

    for (const topic of filter.topics) {
      if (topic === null) continue
      if (Array.isArray(topic)) {
        if (topic.length === 0 || topic.length > MAX_LOG_TOPIC_OR_VALUES || !topic.every(validateLogTopic)) {
          return invalidParams('Invalid eth_getLogs topic values')
        }
      }
      else if (!validateLogTopic(topic)) {
        return invalidParams('Invalid eth_getLogs topic')
      }
      hasRestrictiveFilter = true
    }
  }

  if (!hasRestrictiveFilter) {
    return invalidParams('eth_getLogs requires an address or topic filter')
  }

  return 5 + steppedBigIntModifier(range, LOG_RANGE_COST_CHUNK)
}

function assessFeeHistory(params: unknown): number {
  if (!Array.isArray(params)) return invalidParams('Invalid eth_feeHistory params')
  const blockCount = parseHexQuantity(params[0], 'eth_feeHistory block count')
  if (blockCount === 0n || blockCount > MAX_FEE_HISTORY_BLOCKS) {
    return invalidParams(`eth_feeHistory block count must be between 1 and ${MAX_FEE_HISTORY_BLOCKS}`)
  }

  const percentiles = params[2]
  if (percentiles !== undefined && percentiles !== null) {
    if (!Array.isArray(percentiles) || percentiles.length > MAX_REWARD_PERCENTILES) {
      return invalidParams(`Invalid eth_feeHistory reward percentiles (maximum ${MAX_REWARD_PERCENTILES})`)
    }
    let previous = -1
    for (const percentile of percentiles) {
      if (typeof percentile !== 'number' || !Number.isFinite(percentile) || percentile < 0 || percentile > 100 || percentile <= previous) {
        return invalidParams('eth_feeHistory reward percentiles must be sorted unique numbers from 0 to 100')
      }
      previous = percentile
    }
  }

  return 2 + steppedBigIntModifier(blockCount, FEE_HISTORY_COST_CHUNK)
}

function assessRpcRequestCost(request: JsonRpcRequest): number {
  if (jsonByteLength(request.params) > MAX_PARAMS_BYTES) {
    return invalidParams(`RPC params exceed ${MAX_PARAMS_BYTES} bytes`, 413)
  }

  switch (request.method) {
    case 'eth_call':
      return 2 + assessTransactionParams(request.params)
    case 'eth_estimateGas':
    case 'eth_createAccessList':
      return 10 + assessTransactionParams(request.params)
    case 'eth_getLogs':
      return assessLogFilter(request.params)
    case 'eth_feeHistory':
      return assessFeeHistory(request.params)
    case 'eth_getBlockByNumber':
      return Array.isArray(request.params) && request.params[1] === true ? 5 : 1
    default:
      return 1
  }
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
  let requestCost = 0

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
      requestCost += assessRpcRequestCost(req)
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
    requestCost = assessRpcRequestCost(body)
  }

  rateLimiter.consume(event, requestCost)

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
