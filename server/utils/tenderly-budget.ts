import { createHash, randomUUID } from 'node:crypto'
import { createError } from 'h3'
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
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then return -2 end
local count = 0
if redis.call('HGET', KEYS[1], 'day') == day then
  count = tonumber(redis.call('HGET', KEYS[1], 'count') or '0')
end
if count >= tonumber(ARGV[1]) then return -1 end
redis.call('HSET', KEYS[1], 'day', day, 'count', count + 1)
redis.call('PEXPIRE', KEYS[1], 172800000)
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[4]), ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return 1
`

async function budgetCommand(config: TenderlyConfig, command: (string | number)[]): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BUDGET_TIMEOUT_MS)
  try {
    const response = await fetch(config.budget.url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Authorization': `Bearer ${config.budget.token}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(command),
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('Budget store rejected request')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) throw new Error('Budget response too large')
        chunks.push(value)
      }
    }
    finally {
      await reader.cancel().catch(() => {})
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { result?: unknown, error?: unknown }
    if (!data || data.error !== undefined || !Object.hasOwn(data, 'result')) {
      throw new Error('Invalid budget response')
    }
    return data.result
  }
  finally {
    clearTimeout(timeout)
  }
}

/** Reserve one paid simulation attempt, including failures, before any Tenderly call. */
export async function reserveTenderlyCapacity(config: TenderlyConfig): Promise<() => Promise<void>> {
  // Hash tags keep the two keys together on Redis Cluster. Credentials and
  // request payloads never enter keys; all replicas of one paid project agree.
  const scope = createHash('sha256').update(JSON.stringify([config.accountSlug, config.projectSlug])).digest('hex')
  const prefix = `tenderly:{${scope}}`
  const lease = randomUUID()
  let result: unknown
  try {
    result = await budgetCommand(config, [
      'EVAL', RESERVE_SCRIPT, 2, `${prefix}:daily`, `${prefix}:leases`,
      config.budget.dailyLimit, config.budget.maxConcurrent, lease, LEASE_MS,
    ])
    if (result !== 1 && result !== -1 && result !== -2) throw new Error('Invalid reservation result')
  }
  catch {
    // A reservation can succeed even if its response is lost. Never retry or
    // refund an ambiguous write; failing closed can leave capacity unused.
    logger.warn({ ctx: 'tenderly-budget' }, 'capacity store unavailable')
    throw createError({ statusCode: 503, statusMessage: 'Tenderly capacity unavailable' })
  }
  if (result !== 1) {
    throw createError({
      statusCode: 429,
      statusMessage: result === -1 ? 'Tenderly daily capacity reached' : 'Tenderly simulations busy; try again shortly',
    })
  }
  return async () => {
    try {
      // Only release this request's lease. Daily spend remains charged.
      await budgetCommand(config, ['ZREM', `${prefix}:leases`, lease])
    }
    catch {
      logger.warn({ ctx: 'tenderly-budget' }, 'capacity lease release failed; awaiting expiry')
    }
  }
}
