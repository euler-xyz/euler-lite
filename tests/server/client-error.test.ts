import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

const mocks = vi.hoisted(() => ({ consume: vi.fn(), error: vi.fn(), warn: vi.fn() }))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: (event: { method?: string }) => event.method ?? 'POST',
  readBody: (event: { context?: { body?: unknown } }) => event.context?.body,
}))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: mocks.consume }) }))
vi.mock('~/server/utils/logger', () => ({ logger: { error: mocks.error, warn: mocks.warn } }))

const handler = (await import('~/server/api/internal/client-error.post')).default
const event = (body: unknown, headers: Record<string, string | undefined> = {}): H3Event => ({
  method: 'POST',
  context: { body },
  node: { req: { headers }, res: {} },
}) as unknown as H3Event

describe('POST /api/internal/client-error', () => {
  afterEach(() => vi.clearAllMocks())

  it('logs only allowlisted client payload fields', async () => {
    await expect(handler(event({
      source: 'client',
      event: 'tx_plan_build_failed',
      fingerprint: 'abc123',
      flow: 'lend_supply',
      rawWalletAddress: '0x0000000000000000000000000000000000000001',
    }))).resolves.toEqual({ ok: true })

    expect(mocks.consume).toHaveBeenCalledOnce()
    expect(mocks.error.mock.calls[0][0]).toMatchObject({
      ctx: 'client-error',
      source: 'client',
      event: 'tx_plan_build_failed',
      flow: 'lend_supply',
    })
    expect(mocks.error.mock.calls[0][0].fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(JSON.stringify(mocks.error.mock.calls[0][0])).not.toContain('rawWalletAddress')
  })

  it('rejects oversize and invalid payloads before error logging', async () => {
    await expect(handler(event(
      { source: 'client', event: 'client_invariant_missing', fingerprint: 'abc123' },
      { 'content-length': String(13 * 1024) },
    ))).rejects.toMatchObject({ statusCode: 413 })
    await expect(handler(event({ source: 'client', event: 'unknown', fingerprint: 'abc123' }))).rejects.toMatchObject({ statusCode: 400 })

    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ ctx: 'client-error', reason: 'payload-too-large' }), 'request rejected')
    expect(mocks.error).not.toHaveBeenCalled()
  })
})
