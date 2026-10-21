import { createHash, randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { describe, expect, it, vi } from 'vitest'
import { reserveTenderlyCapacity } from '~/server/utils/tenderly-budget'
import type { TenderlyConfig } from '~/server/utils/tenderly'

// External requests require this explicit opt-in even when credentials exist.
const enabled = process.env.RUN_UPSTASH_TENDERLY_ACCEPTANCE === '1'
if (enabled && (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN)) {
  throw new Error('Upstash acceptance requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN')
}

function testConfig(): TenderlyConfig {
  let url: URL
  try {
    url = new URL(process.env.UPSTASH_REDIS_REST_URL!)
  }
  catch {
    throw new Error('Upstash acceptance requires a valid HTTPS Upstash origin')
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.upstash.io')
    || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Upstash acceptance requires an HTTPS Upstash origin without credentials, port, path, query or fragment')
  }
  return {
    accessKey: 'unused-no-tenderly-requests',
    accountSlug: `pr966-acceptance-${randomUUID()}`,
    projectSlug: randomUUID(),
    budget: { url: url.origin, token: process.env.UPSTASH_REDIS_REST_TOKEN!, dailyLimit: 2, maxConcurrent: 1 },
  }
}

/** Delete only this invocation's two randomly scoped keys; never scan or flush the store. */
async function removeTestKeys(config: TenderlyConfig): Promise<void> {
  const scope = createHash('sha256').update(JSON.stringify([config.accountSlug, config.projectSlug])).digest('hex')
  try {
    const response = await fetch(config.budget.url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Authorization': `Bearer ${config.budget.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify(['DEL', `tenderly:{${scope}}:daily`, `tenderly:{${scope}}:leases`]),
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('Cleanup rejected')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 4096) throw new Error('Cleanup response too large')
        chunks.push(value)
      }
    }
    finally {
      await reader.cancel().catch(() => {})
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || !('result' in data) || 'error' in data
      || typeof data.result !== 'number' || !Number.isInteger(data.result) || data.result < 0 || data.result > 2) {
      throw new Error('Cleanup result invalid')
    }
  }
  catch {
    // Do not propagate fetch exceptions containing the endpoint or token.
    throw new Error('Upstash acceptance cleanup failed; isolated test keys expire within 48 hours')
  }
}

describe.skipIf(!enabled)('Tenderly acceptance against real Upstash', () => {
  it('executes the production reservation and release protocol without a fetch mock', async () => {
    expect(vi.isMockFunction(fetch)).toBe(false)
    const config = testConfig()
    const releases: (() => Promise<void>)[] = []
    const event = () => ({ node: { res: { setHeader: vi.fn() } } }) as unknown as H3Event
    const firstEvents = [event(), event()]
    try {
      const attempts = await Promise.allSettled(firstEvents.map(value => reserveTenderlyCapacity(config, value)))
      for (const attempt of attempts) {
        if (attempt.status === 'fulfilled') releases.push(attempt.value)
      }
      expect(releases).toHaveLength(1)
      const busyIndex = attempts.findIndex(attempt => attempt.status === 'rejected')
      const busy = attempts[busyIndex] as PromiseRejectedResult
      expect(busy.reason).toMatchObject({ statusCode: 429, statusMessage: 'Tenderly simulations busy; try again shortly' })
      const busyRetry = vi.mocked(firstEvents[busyIndex].node.res.setHeader).mock.calls[0][1]
      expect(busyRetry).toBeGreaterThan(0)
      expect(busyRetry).toBeLessThanOrEqual(45)

      await releases.shift()!()
      releases.push(await reserveTenderlyCapacity(config, event()))
      const exhaustedEvent = event()
      await expect(reserveTenderlyCapacity(config, exhaustedEvent)).rejects.toMatchObject({
        statusCode: 429, statusMessage: 'Tenderly daily capacity reached',
      })
      const dailyRetry = vi.mocked(exhaustedEvent.node.res.setHeader).mock.calls[0][1]
      expect(dailyRetry).toBeGreaterThan(0)
      expect(dailyRetry).toBeLessThanOrEqual(86400)
    }
    finally {
      await Promise.allSettled(releases.map(release => release()))
      await removeTestKeys(config)
    }
  }, 30_000)
})
