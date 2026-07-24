import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  fetchWithTimeout: vi.fn(),
  rateLimiterConfigs: [] as Array<{ max: number, windowMs: number, label: string }>,
  warn: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: (event: TestEvent) => event.method,
  getRequestURL: (event: TestEvent) => new URL(event.url),
  readRawBody: (event: TestEvent) => event.body,
  setResponseHeaders: (event: TestEvent, headers: Record<string, string>) => {
    event.context.responseHeaders = {
      ...event.context.responseHeaders,
      ...headers,
    }
  },
  setResponseHeader: (event: TestEvent, name: string, value: number | string) => {
    event.context.responseHeaders = {
      ...event.context.responseHeaders,
      [name]: String(value),
    }
  },
  setResponseStatus: (event: TestEvent, status: number, statusText?: string) => {
    event.context.status = status
    event.context.statusText = statusText
  },
}))

vi.mock('~/server/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: (config: { max: number, windowMs: number, label: string }) => {
    mocks.rateLimiterConfigs.push(config)
    return { consume: mocks.consume }
  },
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: mocks.warn },
}))

type TestEvent = H3Event & {
  method: string
  url: string
  body?: string
  context: {
    responseHeaders?: Record<string, string>
    status?: number
    statusText?: string
  }
}

const ACCOUNT = '0x0000000000000000000000000000000000000001'
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000002'
const VAULT = '0x0000000000000000000000000000000000000003'
const OTHER_VAULT = '0x0000000000000000000000000000000000000004'

const handler = (await import('~/server/api/internal/v3/[...path]')).default
const { resetV3ProxyBackoffsForTest } = await import('~/server/utils/v3-proxy-backoff')

const makeEvent = (method: string, url: string, body?: string): TestEvent => ({
  method,
  url,
  body,
  context: {},
  node: {
    req: {
      headers: {
        'cf-connecting-ip': '127.0.0.1',
      },
      socket: {},
    },
    res: {},
  },
} as unknown as TestEvent)

describe('/api/internal/v3 proxy route', () => {
  afterEach(() => {
    delete process.env.EULER_SDK_V3_API_KEY
    resetV3ProxyBackoffsForTest()
    vi.clearAllMocks()
  })

  it('uses the same app-server rate-limit budget as the RPC proxy', () => {
    expect(mocks.rateLimiterConfigs).toContainEqual({
      max: 10_000,
      windowMs: 60_000,
      label: 'v3-proxy',
    })
  })

  it('rate limits and forwards allowed POST requests with fixed server headers', async () => {
    process.env.EULER_SDK_V3_API_KEY = 'server-key'
    mocks.fetchWithTimeout.mockResolvedValueOnce(new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const requestBody = {
      chainId: 1,
      addresses: [ACCOUNT],
      include: ['collaterals'],
    }
    const event = makeEvent(
      'POST',
      'https://app.example/api/internal/v3/evk/vaults/batch',
      JSON.stringify(requestBody),
    )

    await expect(handler(event)).resolves.toBe('{"ok":true}')

    expect(mocks.consume).toHaveBeenCalledWith(event, 5)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
    const [, , init] = mocks.fetchWithTimeout.mock.calls[0]
    const headers = init.headers as Headers
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(requestBody))
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-api-key')).toBe('server-key')
  })

  it('rejects disallowed paths before consuming rate-limit budget', async () => {
    const event = makeEvent(
      'GET',
      `https://app.example/api/internal/v3/admin?chainId=1&account=${ACCOUNT}`,
    )

    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: 'V3 path not allowed',
    })
    expect(mocks.consume).not.toHaveBeenCalled()
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('backs off repeated requests after a retryable upstream response', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(new Response('{"error":true}', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'application/json' },
    }))
    const first = makeEvent('POST', 'https://app.example/api/internal/v3/resolve/vaults', '{"chainId":1,"addresses":[]}')
    const second = makeEvent('POST', 'https://app.example/api/internal/v3/resolve/vaults', '{"chainId":1,"addresses":[]}')

    await expect(handler(first)).resolves.toBe('{"error":true}')
    await expect(handler(second)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream cooling down',
    })

    expect(first.context.status).toBe(502)
    expect(first.context.responseHeaders?.['retry-after']).toBe('10')
    expect(second.context.responseHeaders?.['retry-after']).toBe('10')
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('keeps vault totals history cooldowns scoped to the requested range', async () => {
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(new Response('{"error":true}', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    const failedRange = makeEvent(
      'GET',
      `https://app.example/api/internal/v3/evk/vaults/1/${VAULT}/totals?resolution=1d&from=1775209911&to=1782985911`,
    )
    const otherRange = makeEvent(
      'GET',
      `https://app.example/api/internal/v3/evk/vaults/1/${VAULT}/totals?resolution=1d&from=1782380000&to=1782984800`,
    )
    const repeatedFailedRange = makeEvent(
      'GET',
      `https://app.example/api/internal/v3/evk/vaults/1/${VAULT}/totals?resolution=1d&from=1775209911&to=1782985911`,
    )

    await expect(handler(failedRange)).resolves.toBe('{"error":true}')
    await expect(handler(otherRange)).resolves.toBe('{"ok":true}')
    await expect(handler(repeatedFailedRange)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream cooling down',
    })

    expect(failedRange.context.status).toBe(502)
    expect(failedRange.context.responseHeaders?.['retry-after']).toBe('10')
    expect(repeatedFailedRange.context.responseHeaders?.['retry-after']).toBe('10')
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2)
  })

  it('keeps earn vault totals history cooldowns scoped to the requested range', async () => {
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(new Response('{"error":true}', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    const failedRange = makeEvent(
      'GET',
      `https://app.example/api/internal/v3/earn/vaults/1/${VAULT}/totals?resolution=1d&from=1775209911&to=1782985911`,
    )
    const otherRange = makeEvent(
      'GET',
      `https://app.example/api/internal/v3/earn/vaults/1/${VAULT}/totals?resolution=1d&from=1782380000&to=1782984800`,
    )
    const repeatedFailedRange = makeEvent(
      'GET',
      `https://app.example/api/internal/v3/earn/vaults/1/${VAULT}/totals?resolution=1d&from=1775209911&to=1782985911`,
    )

    await expect(handler(failedRange)).resolves.toBe('{"error":true}')
    await expect(handler(otherRange)).resolves.toBe('{"ok":true}')
    await expect(handler(repeatedFailedRange)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream cooling down',
    })

    expect(failedRange.context.status).toBe(502)
    expect(failedRange.context.responseHeaders?.['retry-after']).toBe('10')
    expect(repeatedFailedRange.context.responseHeaders?.['retry-after']).toBe('10')
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2)
  })

  it('keeps cooldown when an overlapping success returns after a retryable failure', async () => {
    let resolveRetryable: (response: Response) => void = () => {}
    let resolveSuccess: (response: Response) => void = () => {}
    mocks.fetchWithTimeout
      .mockReturnValueOnce(new Promise<Response>((resolve) => {
        resolveRetryable = resolve
      }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => {
        resolveSuccess = resolve
      }))

    const retryable = makeEvent('POST', 'https://app.example/api/internal/v3/resolve/vaults', '{"chainId":1,"addresses":[]}')
    const success = makeEvent('POST', 'https://app.example/api/internal/v3/resolve/vaults', '{"chainId":1,"addresses":[]}')

    const retryableResult = handler(retryable)
    const successResult = handler(success)

    await Promise.resolve()

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2)

    resolveRetryable(new Response('{"error":true}', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'application/json' },
    }))
    await expect(retryableResult).resolves.toBe('{"error":true}')

    resolveSuccess(new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(successResult).resolves.toBe('{"ok":true}')

    const blocked = makeEvent('POST', 'https://app.example/api/internal/v3/resolve/vaults', '{"chainId":1,"addresses":[]}')
    await expect(handler(blocked)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream cooling down',
    })

    expect(blocked.context.responseHeaders?.['retry-after']).toBe('10')
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2)
  })

  it('backs off after transport failures instead of surfacing a generic 500', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('timeout'))
    const first = makeEvent('GET', `https://app.example/api/internal/v3/accounts/${ACCOUNT}/positions?chainId=1`)
    const second = makeEvent('GET', `https://app.example/api/internal/v3/accounts/${ACCOUNT}/positions?chainId=1`)

    await expect(handler(first)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream unavailable',
    })
    await expect(handler(second)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream cooling down',
    })

    expect(first.context.responseHeaders?.['retry-after']).toBe('10')
    expect(second.context.responseHeaders?.['retry-after']).toBe('10')
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('sanitizes owner-scoped activity transport errors before logging', async () => {
    const cursor = 'private-opaque-cursor'
    const requestUrl = `https://app.example/api/internal/v3/activity/accounts/${ACCOUNT}/events?chainId=1&cursor=${cursor}`
    const cause = new TypeError(`Failed to fetch ${requestUrl}`)
    mocks.fetchWithTimeout.mockRejectedValueOnce(Object.assign(
      new Error(`Activity request failed for ${requestUrl}`),
      { code: 'UND_ERR_CONNECT_TIMEOUT', cause },
    ))

    await expect(handler(makeEvent('GET', requestUrl))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream unavailable',
    })

    const logRecord = mocks.warn.mock.calls.find(([, message]) => message === 'upstream fetch failed')?.[0]
    expect(logRecord).toMatchObject({
      ctx: 'v3-proxy',
      pathTemplate: '/v3/activity/accounts/:address/events',
      v3ActivityScope: 'account',
      v3ChainIds: '1',
      err: {
        name: 'Error',
        code: 'UND_ERR_CONNECT_TIMEOUT',
        causeName: 'TypeError',
      },
    })
    expect(JSON.stringify(logRecord)).not.toContain(ACCOUNT)
    expect(JSON.stringify(logRecord)).not.toContain(cursor)
  })

  it('classifies aborts as upstream timeouts without forwarding client-controlled error fields', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new DOMException('attacker-controlled text', 'AbortError'))
    const event = makeEvent('GET', `https://app.example/api/internal/v3/rewards/breakdown?chainId=1&account=${ACCOUNT}`)

    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream unavailable',
    })

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: 'v3-proxy',
        pathTemplate: '/v3/rewards/breakdown',
        reason: 'upstream-timeout',
      }),
      'upstream timed out',
    )
    const [fields] = mocks.warn.mock.calls[0]
    expect(fields).not.toHaveProperty('err')
    expect(JSON.stringify(fields)).not.toContain('attacker-controlled text')
  })

  it('shares cooldown across dynamic account position paths', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('timeout'))
    const first = makeEvent('GET', `https://app.example/api/internal/v3/accounts/${ACCOUNT}/positions?chainId=1`)
    const second = makeEvent('GET', `https://app.example/api/internal/v3/accounts/${OTHER_ACCOUNT}/positions?chainId=1`)

    await expect(handler(first)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream unavailable',
    })
    await expect(handler(second)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream cooling down',
    })

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('shares cooldown across dynamic earn vault detail paths', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(new Response('{"error":true}', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'application/json' },
    }))
    const first = makeEvent('GET', `https://app.example/api/internal/v3/earn/vaults/1/${VAULT}`)
    const second = makeEvent('GET', `https://app.example/api/internal/v3/earn/vaults/1/${OTHER_VAULT}`)

    await expect(handler(first)).resolves.toBe('{"error":true}')
    await expect(handler(second)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'V3 upstream cooling down',
    })

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
  })
})
