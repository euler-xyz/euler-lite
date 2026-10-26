import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTextWithBudget } from '~/server/utils/fetch-text-with-budget'
import { createProxyCache, createProxyInFlight, forwardProxied } from '~/server/utils/external-proxy'

vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn() } }))
const budget = { maxBytes: 8, timeoutMs: 100 }
const fetchText = (options = budget) => fetchTextWithBudget('https://upstream.example/graphql', { method: 'POST' }, options)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('bounded upstream GraphQL responses', () => {
  it('preserves split UTF-8 at the exact byte limit', async () => {
    const encoded = new TextEncoder().encode('éééé')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.slice(0, 3))
        controller.enqueue(encoded.slice(3))
        controller.close()
      },
    }))))
    expect((await fetchText()).text).toBe('éééé')
  })

  it.each([200, 500])('cancels oversized chunked responses, status %s', async (status) => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(9)) },
      cancel,
    }), { status })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(fetchText()).rejects.toThrow('too large')
    expect(cancel).toHaveBeenCalled()
  })

  it('rejects declared oversized bodies before reading them', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '9' } })))
    await expect(fetchText()).rejects.toThrow('too large')
    expect(cancel).toHaveBeenCalled()
  })

  it('enforces its deadline after headers arrive and cancels a stalled body', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      signal = init.signal
      return new Response(new ReadableStream({ cancel }))
    }))
    const pending = expect(fetchText()).rejects.toThrow('deadline')
    await vi.advanceTimersByTimeAsync(101)
    await pending
    expect(signal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('enforces the deadline before headers arrive', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const pending = expect(fetchText()).rejects.toThrow('deadline')
    await vi.advanceTimersByTimeAsync(101)
    await pending
  })

  it('clears its timer when the body fails', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('broken body')) },
    }))))
    await expect(fetchText()).rejects.toThrow('broken body')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps GraphQL errors, bypass freshness, and in-flight dedup through the shared proxy', async () => {
    const text = '{"errors":[{"message":"upstream validation"}]}'
    const fetch = vi.fn(async () => new Response(text))
    vi.stubGlobal('fetch', fetch)
    const cache = createProxyCache(1000)
    const set = vi.spyOn(cache, 'set')
    const args = { cache, inFlight: createProxyInFlight(), method: 'POST', target: 'https://upstream.example', headers: {}, body: '{}', ctx: 'test', bypassCache: true, responseBudget: { maxBytes: 100, timeoutMs: 100 } }
    const results = await Promise.all([forwardProxied(args), forwardProxied(args)])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(results).toEqual([expect.objectContaining({ body: text, cacheState: 'bypass' }), expect.objectContaining({ body: text, cacheState: 'bypass' })])
    expect(set).not.toHaveBeenCalled()
    await forwardProxied(args)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache an oversized upstream response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('123456789')))
    const cache = createProxyCache(1000)
    const set = vi.spyOn(cache, 'set')
    await expect(forwardProxied({ cache, inFlight: createProxyInFlight(), method: 'POST', target: 'https://upstream.example', headers: {}, ctx: 'test', responseBudget: budget })).rejects.toThrow('too large')
    expect(set).not.toHaveBeenCalled()
  })
})
