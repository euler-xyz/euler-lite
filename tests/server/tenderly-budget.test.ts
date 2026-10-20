import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reserveTenderlyCapacity } from '~/server/utils/tenderly-budget'
import { resolveTenderlyConfig } from '~/server/utils/tenderly'

vi.mock('h3', async original => ({
  ...await original<typeof import('h3')>(),
  readBody: async (event: { body: unknown }) => event.body,
}))
vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn() } }))

const json = (result: unknown) => new Response(JSON.stringify({ result }))
const env = {
  TENDERLY_ACCESS_KEY: 'synthetic-key',
  TENDERLY_ACCOUNT_SLUG: 'test-account',
  TENDERLY_PROJECT_SLUG: 'test-project',
  TENDERLY_BUDGET_REDIS_REST_URL: 'https://budget.example.test',
  TENDERLY_BUDGET_REDIS_REST_TOKEN: 'synthetic-budget-token',
  TENDERLY_DAILY_SIMULATION_LIMIT: '2',
  TENDERLY_MAX_CONCURRENT_SIMULATIONS: '1',
}
const payload = {
  chainId: 1,
  from: `0x${'1'.repeat(40)}`,
  to: `0x${'2'.repeat(40)}`,
  data: '0x12345678',
  value: '123',
  stateOverrides: [{ address: `0x${'3'.repeat(40)}`, stateDiff: [{ slot: '0x00', value: '0x01' }] }],
}
const event = (ip = '203.0.113.1', body = payload) => ({
  body,
  node: { req: { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } } },
}) as unknown as H3Event

beforeEach(() => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  vi.stubEnv('DOPPLER_ENVIRONMENT', 'dev')
  vi.stubEnv('EDGE_PROVIDER', 'none')
  vi.stubEnv('EDGE_ORIGIN_SECRET', '')
  vi.stubEnv('DISABLE_RATE_LIMIT', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Tenderly capacity configuration', () => {
  it.each([
    ['TENDERLY_BUDGET_REDIS_REST_URL', ''],
    ['TENDERLY_BUDGET_REDIS_REST_URL', 'http://budget.example.test'],
    ['TENDERLY_BUDGET_REDIS_REST_URL', 'https://user:secret@budget.example.test'],
    ['TENDERLY_BUDGET_REDIS_REST_URL', 'https://budget.example.test/?token=secret'],
    ['TENDERLY_BUDGET_REDIS_REST_TOKEN', ''],
    ['TENDERLY_DAILY_SIMULATION_LIMIT', '0'],
    ['TENDERLY_DAILY_SIMULATION_LIMIT', 'NaN'],
    ['TENDERLY_DAILY_SIMULATION_LIMIT', '9007199254740992'],
    ['TENDERLY_MAX_CONCURRENT_SIMULATIONS', '-1'],
    ['TENDERLY_MAX_CONCURRENT_SIMULATIONS', '1.5'],
  ])('disables simulation for invalid %s=%s', async (key, value) => {
    vi.stubEnv(key, value)
    expect(resolveTenderlyConfig()).toBeUndefined()
    const { default: status } = await import('~/server/api/internal/tenderly/status.get')
    expect(status(event())).toEqual({ enabled: false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { default: handler } = await import('~/server/api/internal/tenderly/simulate.post')
    await expect(handler(event())).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('shared capacity boundary', () => {
  it('rejects invalid payloads before reserving paid capacity', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { default: handler } = await import('~/server/api/internal/tenderly/simulate.post')
    await expect(handler(event('203.0.113.1', { ...payload, data: 'invalid' })))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the same project keys across modules and ignores IP and rate-limit bypasses', async () => {
    const requests: (string | number)[][] = []
    let consumed = 0
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === env.TENDERLY_BUDGET_REDIS_REST_URL) {
        const command = JSON.parse(init.body as string) as (string | number)[]
        requests.push(command)
        if (command[0] === 'EVAL') return json(++consumed <= 2 ? 1 : -1)
        return json(1)
      }
      if (url.endsWith('/simulate')) return new Response(JSON.stringify({ simulation: { id: 'synthetic-id', status: false } }))
      return new Response('{}')
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DISABLE_RATE_LIMIT', 'true')
    const firstReplica = (await import('~/server/api/internal/tenderly/simulate.post')).default
    vi.resetModules()
    const secondReplica = (await import('~/server/api/internal/tenderly/simulate.post')).default
    await expect(firstReplica(event())).resolves.toEqual({
      url: 'https://tdly.co/shared/simulation/synthetic-id', errorMessage: 'The simulated transaction reverted.',
    })
    await secondReplica(event('203.0.113.2'))
    await expect(firstReplica(event('203.0.113.3'))).rejects.toMatchObject({ statusCode: 429 })
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('https://api.tenderly.co'))).toHaveLength(4)
    const reservations = requests.filter(command => command[0] === 'EVAL')
    expect(reservations[0].slice(2, 7)).toEqual(reservations[1].slice(2, 7))
    expect(reservations[0][7]).not.toEqual(reservations[1][7])
    const paidRequest = fetchMock.mock.calls.find(([url]) => url.endsWith('/simulate'))!
    expect(paidRequest[1].redirect).toBe('error')
    expect(JSON.parse(paidRequest[1].body as string)).toMatchObject({
      from: payload.from, to: payload.to, input: payload.data, value: payload.value,
      state_objects: { [payload.stateOverrides[0].address]: { storage: { '0x00': '0x01' } } },
    })
    expect(requests.filter(command => command[0] === 'ZREM').map(command => command[2]))
      .toEqual(reservations.slice(0, 2).map(command => command[7]))
  })

  it('does not reach Tenderly when concurrent capacity is exhausted', async () => {
    const fetchMock = vi.fn(async () => json(-2))
    vi.stubGlobal('fetch', fetchMock)
    const { default: handler } = await import('~/server/api/internal/tenderly/simulate.post')
    await expect(handler(event())).rejects.toMatchObject({ statusCode: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    () => new Response('{}', { status: 500 }),
    () => new Response(JSON.stringify({ error: 'ERR unavailable' })),
    () => json('1'),
    () => new Response('x'.repeat(4097)),
    () => Promise.reject(new Error('network failure')),
  ])('fails closed on unavailable or untrusted budget responses', async (response) => {
    const fetchMock = vi.fn(response)
    vi.stubGlobal('fetch', fetchMock)
    const { default: handler } = await import('~/server/api/internal/tenderly/simulate.post')
    await expect(handler(event())).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(env.TENDERLY_BUDGET_REDIS_REST_URL, expect.objectContaining({
      redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer synthetic-budget-token' }),
    }))
  })

  it('bounds budget response body reads by the total deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    }))))
    const reservation = reserveTenderlyCapacity(resolveTenderlyConfig()!)
    const assertion = expect(reservation).rejects.toMatchObject({ statusCode: 503 })
    await vi.advanceTimersByTimeAsync(3000)
    await assertion
  })

  it('holds the lease across simulate and share and releases it on upstream failure', async () => {
    const commands: (string | number)[][] = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url === env.TENDERLY_BUDGET_REDIS_REST_URL) {
        commands.push(JSON.parse(init.body as string))
        return json(1)
      }
      expect(commands).toHaveLength(1)
      if (url.endsWith('/simulate')) return new Response(JSON.stringify({ simulation: { id: 'synthetic-id' } }))
      throw new Error('share failed')
    })
    vi.stubGlobal('fetch', fetchMock)
    const { default: handler } = await import('~/server/api/internal/tenderly/simulate.post')
    await expect(handler(event())).rejects.toMatchObject({ statusCode: 502 })
    expect(commands[1]).toEqual(['ZREM', commands[0][4], commands[0][7]])
    expect(commands[0][8]).toBeGreaterThan(30_000 + 2 * 3000)
    expect(commands.some(command => command[0] === 'DECR')).toBe(false)
  })

  it('does not refund attempts or throw when lease release fails', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const command = JSON.parse(init.body as string) as (string | number)[]
      if (command[0] === 'ZREM') throw new Error('store unavailable')
      return json(1)
    })
    vi.stubGlobal('fetch', fetchMock)
    const release = await reserveTenderlyCapacity(resolveTenderlyConfig()!)
    await expect(release()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
