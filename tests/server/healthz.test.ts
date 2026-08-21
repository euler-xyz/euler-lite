/**
 * Liveness-probe contract tests.
 *
 * The container healthcheck must stay independent of edge configuration:
 * /healthz lives outside /api/ (exempt from the geo-gate, rate limiting,
 * and internal-request authentication) and the Dockerfile probe must not
 * send edge or internal headers — enabling EDGE_ORIGIN_SECRET once marked
 * a healthy container unhealthy because the probe authenticated with the
 * legacy loopback sentinel.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

const noStore = vi.fn()
vi.mock('~/server/utils/cache-headers', () => ({
  forceNoStoreCacheHeaders: (...args: unknown[]) => noStore(...args),
}))

const handler = (await import('~/server/routes/healthz.get')).default

describe('GET /healthz', () => {
  it('reports liveness with no dependencies and never caches', () => {
    const event = {} as H3Event
    expect((handler as (e: H3Event) => unknown)(event)).toEqual({ status: 'ok' })
    expect(noStore).toHaveBeenCalledWith(event)
  })
})

describe('Dockerfile healthcheck', () => {
  const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8')
  const healthcheckIndex = dockerfile.indexOf('HEALTHCHECK')
  // The CMD is on the continuation line right after the HEALTHCHECK options.
  const probe = dockerfile.slice(healthcheckIndex).split('\n').slice(0, 2).join('\n')

  it('probes /healthz, not a gated /api/ route', () => {
    expect(healthcheckIndex).toBeGreaterThanOrEqual(0)
    expect(probe).toContain('/healthz')
    expect(probe).not.toContain('/api/')
  })

  it('sends no edge or internal-auth headers (the probe must not depend on or leak them)', () => {
    expect(probe).not.toContain('cf-connecting-ip')
    expect(probe).not.toContain('x-edge')
    expect(probe).not.toContain('EDGE_ORIGIN_SECRET')
  })
})
