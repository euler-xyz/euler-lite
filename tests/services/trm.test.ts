import { afterEach, describe, expect, it, vi } from 'vitest'
import { screenAddress } from '~/services/trm'

const originalFetch = globalThis.fetch

describe('screenAddress', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('allows only an explicit non-suspicious response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ addressIsSuspicious: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof globalThis.fetch

    await expect(screenAddress('0x1111111111111111111111111111111111111111')).resolves.toBe(false)
  })

  it('fails closed on non-2xx API responses', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ statusCode: 451, statusMessage: 'Unavailable For Legal Reasons' }), {
        status: 451,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof globalThis.fetch

    await expect(screenAddress('0x1111111111111111111111111111111111111111')).resolves.toBe(true)
  })

  it('fails closed when the response does not explicitly allow the address', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof globalThis.fetch

    await expect(screenAddress('0x1111111111111111111111111111111111111111')).resolves.toBe(true)
  })
})
