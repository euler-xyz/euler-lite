import { createHash, randomUUID } from 'node:crypto'
import { createError, setResponseHeader, type H3Event } from 'h3'
import type { TenderlyConfig } from '~/server/utils/tenderly'
import { logger } from '~/server/utils/logger'

export const TENDERLY_UPSTREAM_TIMEOUT_MS = 30_000
const BUDGET_TIMEOUT_MS = 3_000
// Covers reservation response latency, the entire simulate + share deadline,
// and release latency. Abandoned reservations recover without a local timer.
const LEASE_MS = 45_000
const MAX_RESPONSE_BYTES = 4_096

// Redis serializes this script across all app replicas. Its clock owns both
// the UTC day boundary and lease expiry; IPs and app restarts do not reset it.
const RESERVE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local day = tostring(math.floor(now / 86400000))
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local count = 0
if redis.call('HGET', KEYS[1], 'day') == day then
  count = tonumber(redis.call('HGET', KEYS[1], 'count') or '0')
end
if count >= tonumber(ARGV[1]) then
  return {-1, math.ceil(((tonumber(day) + 1) * 86400000 - now) / 1000)}
end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then
  local next = redis.call('ZRANGE', KEYS[2], -tonumber(ARGV[2]), -tonumber(ARGV[2]), 'WITHSCORES')
  return {-2, math.max(1, math.ceil((tonumber(next[2]) - now) / 1000))}
end
redis.call('HSET', KEYS[1], 'day', day, 'count', count + 1)
redis.call('PEXPIRE', KEYS[1], 172800000)
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[4]), ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return 1
`

type BudgetFailureReason = 'http-rejected' | 'missing-body' | 'response-too-large' | 'invalid-json'
  | 'store-error' | 'invalid-response' | 'invalid-reservation' | 'timeout' | 'request-failed'

// Only fixed categories enter logs: upstream messages, bodies and arbitrary error names can contain credentials.
class BudgetStoreError extends Error {
  constructor(readonly reason: BudgetFailureReason, readonly status?: number, readonly errorName = 'Error') {
    super(reason)
  }
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined
  return name && ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(name) ? name : 'UnknownError'
}

function failureFields(error: unknown) {
  return error instanceof BudgetStoreError
    ? { reason: error.reason, status: error.status, errorName: error.errorName }
    : { reason: 'request-failed', errorName: safeErrorName(error) }
}

async function budgetCommand(config: TenderlyConfig, command: string[]): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BUDGET_TIMEOUT_MS)
  let status: number | undefined
  try {
    const response = await fetch(config.budget.url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Authorization': `Bearer ${config.budget.token}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(command),
    })
    status = response.status
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new BudgetStoreError(response.ok ? 'missing-body' : 'http-rejected', status)
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) throw new BudgetStoreError('response-too-large', status)
        chunks.push(value)
      }
    }
    finally {
      await reader.cancel().catch(() => {})
    }
    let data: { result?: unknown, error?: unknown }
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }
    catch {
      throw new BudgetStoreError('invalid-json', status, 'SyntaxError')
    }
    if (!data || typeof data !== 'object' || data.error !== undefined || !Object.hasOwn(data, 'result')) {
      throw new BudgetStoreError(data?.error !== undefined ? 'store-error' : 'invalid-response', status)
    }
    return data.result
  }
  catch (error) {
    if (error instanceof BudgetStoreError) throw error
    throw new BudgetStoreError(controller.signal.aborted ? 'timeout' : 'request-failed', status, safeErrorName(error))
  }
  finally {
    clearTimeout(timeout)
  }
}

/** Reserve one paid simulation attempt, including failures, before any Tenderly call. */
export async function reserveTenderlyCapacity(config: TenderlyConfig, event: H3Event): Promise<() => Promise<void>> {
  // Hash tags keep the two keys together on Redis Cluster. Credentials and
  // request payloads never enter keys; all replicas of one paid project agree.
  const scope = createHash('sha256').update(JSON.stringify([config.accountSlug, config.projectSlug])).digest('hex')
  const prefix = `tenderly:{${scope}}`
  const lease = randomUUID()
  let result: unknown
  try {
    result = await budgetCommand(config, [
      'EVAL', RESERVE_SCRIPT, '2', `${prefix}:daily`, `${prefix}:leases`,
      String(config.budget.dailyLimit), String(config.budget.maxConcurrent), lease, String(LEASE_MS),
    ])
    if (result !== 1 && (!Array.isArray(result) || result.length !== 2
      || (result[0] !== -1 && result[0] !== -2)
      || !Number.isSafeInteger(result[1]) || result[1] < 1 || result[1] > (result[0] === -1 ? 86400 : LEASE_MS / 1000))) {
      throw new BudgetStoreError('invalid-reservation')
    }
  }
  catch (error) {
    // A reservation can succeed even if its response is lost. Never retry or
    // refund an ambiguous write; failing closed can leave capacity unused.
    logger.warn({ ctx: 'tenderly-budget', ...failureFields(error) }, 'capacity store unavailable')
    throw createError({ statusCode: 503, statusMessage: 'Tenderly capacity unavailable' })
  }
  if (result !== 1) {
    const [reason, retryAfter] = result as [number, number]
    setResponseHeader(event, 'Retry-After', retryAfter)
    throw createError({
      statusCode: 429,
      statusMessage: reason === -1 ? 'Tenderly daily capacity reached' : 'Tenderly simulations busy; try again shortly',
    })
  }
  return async () => {
    try {
      // Only release this request's lease. Daily spend remains charged.
      await budgetCommand(config, ['ZREM', `${prefix}:leases`, lease])
    }
    catch (error) {
      logger.warn({ ctx: 'tenderly-budget', ...failureFields(error) }, 'capacity lease release failed; awaiting expiry')
    }
  }
}
