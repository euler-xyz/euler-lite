import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  reportStatus: vi.fn(),
  error: vi.fn(),
}))

vi.mock('~/server/utils/log', () => ({ reportStatus: mocks.reportStatus }))

vi.mock('~/server/utils/logger', () => ({ logger: { error: mocks.error } }))

const TEMPLATE = 'https://{chainId}-liquidations.example.test'
const LISTED = '0x692b9F0C2701699b7a352C9331DFAE6A6a163294'
const MINUTE = 60_000

const filterResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const blacklist = () => filterResponse({
  mode: 'Blacklist',
  items: [{ address: LISTED, reason: 'Operator note.' }],
})

/** Headers arrive, then the body stalls until the request is aborted, as undici does. */
const stalledBody = (_url: string, init: RequestInit) => new Response(new ReadableStream({
  start(controller) {
    init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
  },
}), { status: 200, headers: { 'content-type': 'application/json' } })

const load = async () => await import('~/server/utils/liquidation-coverage-source')

describe('readLiquidationBotApiConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is off when the variable is unset or empty', async () => {
    const { readLiquidationBotApiConfig } = await import('~/server/utils/liquidation-bot-api-url')
    vi.stubEnv('LIQUIDATION_BOT_API_URL', '')
    expect(readLiquidationBotApiConfig()).toEqual({ status: 'off' })
  })

  it.each([
    [` ${TEMPLATE}/ `, TEMPLATE],
    ['http://localhost:3001/{chainId}', 'http://localhost:3001/{chainId}'],
    ['http://127.0.0.1:3001/{chainId}', 'http://127.0.0.1:3001/{chainId}'],
    ['http://[::1]:3001/{chainId}', 'http://[::1]:3001/{chainId}'],
  ])('accepts %s', async (value, template) => {
    const { readLiquidationBotApiConfig } = await import('~/server/utils/liquidation-bot-api-url')
    vi.stubEnv('LIQUIDATION_BOT_API_URL', value)
    expect(readLiquidationBotApiConfig()).toEqual({ status: 'on', template })
  })

  it.each([
    ['no chain placeholder', 'https://liquidations.example.test'],
    ['plain HTTP to another host', 'http://{chainId}-liquidations.example.test'],
    ['plain HTTP to a host that only starts with localhost', 'http://localhost.evil.test/{chainId}'],
    ['credentials', 'https://user:pass@{chainId}-liquidations.example.test'],
    ['a query string', 'https://{chainId}-liquidations.example.test?key=1'],
    ['a fragment', 'https://{chainId}-liquidations.example.test#bot'],
    ['not a URL', '{chainId}'],
  ])('refuses a template with %s', async (_name, value) => {
    const { readLiquidationBotApiConfig } = await import('~/server/utils/liquidation-bot-api-url')
    vi.stubEnv('LIQUIDATION_BOT_API_URL', value)
    expect(readLiquidationBotApiConfig()).toMatchObject({ status: 'invalid' })
  })
})

describe('liquidation coverage source', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
    vi.stubEnv('LIQUIDATION_BOT_API_URL', TEMPLATE)
    mocks.fetch.mockReset().mockImplementation(async () => blacklist())
    vi.stubGlobal('fetch', mocks.fetch)
    mocks.reportStatus.mockReset()
    mocks.error.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('stays off, with no request, when the variable is unset', async () => {
    vi.stubEnv('LIQUIDATION_BOT_API_URL', '')
    const { getLiquidationCoverage, isLiquidationCoverageEnabled } = await load()

    await expect(getLiquidationCoverage(8453)).resolves.toEqual({ enabled: false })
    expect(isLiquidationCoverageEnabled()).toBe(false)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('stays off and logs once when the template is malformed', async () => {
    vi.stubEnv('LIQUIDATION_BOT_API_URL', 'https://liquidations.example.test')
    const { getLiquidationCoverage } = await load()

    await expect(getLiquidationCoverage(8453)).resolves.toEqual({ enabled: false })
    await expect(getLiquidationCoverage(1)).resolves.toEqual({ enabled: false })
    expect(mocks.error).toHaveBeenCalledTimes(1)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('asks the chain\'s bot and keeps the vaults it names, without reasons', async () => {
    const { getLiquidationCoverage } = await load()

    const coverage = await getLiquidationCoverage(8453)

    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://8453-liquidations.example.test/vault-filter',
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }),
    )
    expect(coverage).toEqual({
      enabled: true,
      chainId: 8453,
      state: 'answered',
      mode: 'blacklist',
      vaults: [LISTED.toLowerCase()],
      fetchedAt: Date.now(),
    })
    expect(JSON.stringify(coverage)).not.toContain('Operator note')
  })

  it('serves a fresh answer for five minutes without asking again', async () => {
    const { getLiquidationCoverage } = await load()
    await getLiquidationCoverage(8453)

    vi.advanceTimersByTime(4 * MINUTE)
    await getLiquidationCoverage(8453)

    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('serves an older answer at once and refreshes it in the background', async () => {
    const { getLiquidationCoverage } = await load()
    await getLiquidationCoverage(8453)
    const fetchedAt = Date.now()
    mocks.fetch.mockImplementation(() => new Promise(() => {}))

    vi.advanceTimersByTime(6 * MINUTE)

    await expect(getLiquidationCoverage(8453)).resolves.toMatchObject({ state: 'answered', fetchedAt })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the last answer for 30 minutes after it was fetched, then counts the chain as having no bot', async () => {
    const { getLiquidationCoverage } = await load()
    await getLiquidationCoverage(8453)
    mocks.fetch.mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))

    vi.advanceTimersByTime(29 * MINUTE)
    await expect(getLiquidationCoverage(8453)).resolves.toMatchObject({ state: 'answered' })

    vi.advanceTimersByTime(MINUTE)
    await expect(getLiquidationCoverage(8453)).resolves.toEqual({
      enabled: true,
      chainId: 8453,
      state: 'no-bot',
    })
    expect(mocks.reportStatus).toHaveBeenCalledWith(
      'liquidation-coverage',
      'chain=8453',
      expect.stringContaining('ECONNREFUSED'),
      expect.stringContaining('ECONNREFUSED'),
    )
  })

  it('answers no bot from the retry floor once the last answer expires, without asking again', async () => {
    const { getLiquidationCoverage } = await load()
    await getLiquidationCoverage(8453)
    mocks.fetch.mockRejectedValue(new Error('timeout'))
    vi.advanceTimersByTime(29 * MINUTE + 30_000)
    await getLiquidationCoverage(8453)
    await vi.runAllTicks()
    const calls = mocks.fetch.mock.calls.length

    vi.advanceTimersByTime(40_000)

    await expect(getLiquidationCoverage(8453)).resolves.toMatchObject({ state: 'no-bot' })
    expect(mocks.fetch).toHaveBeenCalledTimes(calls)
  })

  it.each([
    ['an error status', () => filterResponse({ error: 'not found' }, 404)],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a body that is not a filter', () => filterResponse({ mode: 'Everything', items: [] })],
  ])('counts a bot that never answered with %s as no bot at once', async (_name, response) => {
    mocks.fetch.mockImplementation(async () => response())
    const { getLiquidationCoverage } = await load()

    await expect(getLiquidationCoverage(239)).resolves.toEqual({
      enabled: true,
      chainId: 239,
      state: 'no-bot',
    })
  })

  it('gives up on a body that stalls after the headers within five seconds', async () => {
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => stalledBody(url, init))
    const { getLiquidationCoverage } = await load()

    const reading = getLiquidationCoverage(239)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(reading).resolves.toEqual({ enabled: true, chainId: 239, state: 'no-bot' })
  })

  it('logs a body that is not JSON without echoing it', async () => {
    mocks.fetch.mockImplementation(async () => new Response('<html>secret page', { status: 200 }))
    const { getLiquidationCoverage } = await load()

    await getLiquidationCoverage(239)

    expect(mocks.reportStatus).toHaveBeenCalledWith(
      'liquidation-coverage',
      'chain=239',
      'failed:vault-filter answer is not JSON',
      expect.any(String),
    )
  })

  it('asks a failing bot again at most once a minute', async () => {
    mocks.fetch.mockRejectedValue(new Error('timeout'))
    const { getLiquidationCoverage } = await load()
    await getLiquidationCoverage(239)

    vi.advanceTimersByTime(30_000)
    await getLiquidationCoverage(239)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_000)
    mocks.fetch.mockImplementation(async () => blacklist())
    await expect(getLiquidationCoverage(239)).resolves.toMatchObject({ state: 'answered' })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.reportStatus).toHaveBeenLastCalledWith('liquidation-coverage', 'chain=239', 'ok')
  })

  it('shares one request between concurrent readers', async () => {
    const { getLiquidationCoverage } = await load()

    await Promise.all([getLiquidationCoverage(1), getLiquidationCoverage(1)])

    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('refreshes on demand for the warm cycle, whatever the cache holds', async () => {
    const { getLiquidationCoverage, refreshLiquidationCoverage } = await load()
    await getLiquidationCoverage(1)

    await refreshLiquidationCoverage(1)

    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })
})
