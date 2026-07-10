import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpRequestError } from 'viem'

const mocks = vi.hoisted(() => ({
  getServerSdk: vi.fn(),
  sendRedirect: vi.fn(),
}))

vi.mock('h3', () => ({
  getRequestURL: (event: TestEvent) => new URL(event.url),
  sendRedirect: (...args: unknown[]) => mocks.sendRedirect(...args),
}))

vi.mock('~/server/utils/sdk-server', () => ({
  getServerSdk: (...args: unknown[]) => mocks.getServerSdk(...args),
}))

type TestEvent = {
  url: string
}

const captureStdout = () => {
  const captured: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString())
    return true
  }) as typeof process.stdout.write

  return {
    lines: () => captured
      .join('')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>),
    restore: () => {
      process.stdout.write = originalWrite
    },
  }
}

describe('ensure-vault middleware', () => {
  let stdout: ReturnType<typeof captureStdout> | undefined

  beforeEach(() => {
    vi.resetModules()
    mocks.getServerSdk.mockReset()
    mocks.sendRedirect.mockReset()
  })

  afterEach(() => {
    stdout?.restore()
    stdout = undefined
  })

  it('logs a safe RPC summary and keeps the vault route when validation fails', async () => {
    const rpcCredential = 'rpc-secret-credential'
    const queryCredential = 'query-secret-credential'
    const requestCalldata = `0x${'deadbeef'.repeat(16)}`
    const providerUrl = `https://rpc-user:rpc-password@rpc.example.com/provider/${rpcCredential}?apiKey=${queryCredential}`
    const error = new HttpRequestError({
      body: {
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ data: requestCalldata, to: '0x0000000000000000000000000000000000000001' }, 'latest'],
      },
      status: 503,
      url: providerUrl,
    })

    expect(error.url).toBe(providerUrl)
    expect(error.body).toMatchObject({ method: 'eth_call' })
    expect(error.metaMessages).toEqual(expect.arrayContaining([
      expect.stringContaining(requestCalldata),
    ]))

    mocks.getServerSdk.mockRejectedValueOnce(error)
    stdout = captureStdout()
    const handler = (await import('~/server/middleware/ensure-vault')).default as unknown as (
      event: TestEvent,
    ) => Promise<unknown>
    const event = {
      url: 'https://app.example/lend/0x0000000000000000000000000000000000000001?network=8453',
    }

    await expect(handler(event)).resolves.toBeUndefined()

    expect(mocks.getServerSdk).toHaveBeenCalledWith(8453)
    expect(mocks.sendRedirect).not.toHaveBeenCalled()
    const lines = stdout.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: 'warn',
      app: 'euler-lite',
      ctx: 'ensure-vault',
      chainId: 8453,
      msg: 'failed to validate vault route',
      err: {
        name: 'HttpRequestError',
        kind: 'rpc-http',
        shortMessage: 'HTTP request failed.',
        status: 503,
        url: 'rpc.example.com',
      },
    })

    const json = JSON.stringify(lines[0])
    expect(json).not.toContain(rpcCredential)
    expect(json).not.toContain(queryCredential)
    expect(json).not.toContain('rpc-user')
    expect(json).not.toContain('rpc-password')
    expect(json).not.toContain('/provider/')
    expect(json).not.toContain(requestCalldata)
    expect(json).not.toContain('eth_call')
    expect(json).not.toContain('metaMessages')
    expect(json).not.toContain('Request body')
  })
})
