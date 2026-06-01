import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimeoutError, ContractFunctionExecutionError, CallExecutionError } from 'viem'

/**
 * Vitest's default test environment is `node`, so the shim's `isNode` branch
 * fires here. Each test captures `process.stdout.write` to inspect the
 * emitted JSON line. The browser branch is exercised separately by setting
 * `globalThis.window` to a stub before importing the module.
 */
const captureStdout = () => {
  const captured: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString())
    return true
  }) as typeof process.stdout.write
  return {
    captured,
    restore: () => {
      process.stdout.write = orig
    },
    lines: () => captured.join('').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>),
  }
}

describe('shared logger — Node branch (JSON to stdout)', () => {
  let cap: ReturnType<typeof captureStdout>

  beforeEach(() => {
    cap = captureStdout()
  })

  afterEach(() => {
    cap.restore()
  })

  it('emits a single JSON line per call with the field shape pino uses', async () => {
    const { logger } = await import('~/utils/logger')
    logger.warn({ ctx: 'vault/test', chainId: 8453 }, 'hello')
    const lines = cap.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: 'warn',
      app: 'euler-lite',
      ctx: 'vault/test',
      chainId: 8453,
      msg: 'hello',
    })
    expect(typeof lines[0].time).toBe('number')
  })

  it('summarises any Error-typed field — not just `err` — so abi/metaMessages never leak', async () => {
    const { logger } = await import('~/utils/logger')
    const inner = new TimeoutError({ body: { method: 'eth_call' }, url: 'https://rpc.example' })
    const middle = new CallExecutionError(inner, { account: undefined, data: '0xdead', to: '0x0000000000000000000000000000000000000000' })
    const outer = new ContractFunctionExecutionError(middle, {
      abi: [{ type: 'function', name: 'foo', inputs: [], outputs: [], stateMutability: 'view' }],
      args: ['0xdeadbeef'],
      contractAddress: '0x0000000000000000000000000000000000000001',
      functionName: 'foo',
    })
    // Use a non-conventional key name to prove the summariser walks values, not key names.
    logger.warn({ ctx: 'vault/x', cause: outer }, 'fetch failed')
    const line = cap.lines()[0]
    const json = JSON.stringify(line)
    expect(json).not.toContain('"abi"')
    expect(json).not.toContain('metaMessages')
    expect(json).not.toContain('"args"')
    expect(json).toContain('rpc-timeout')
  })

  it('summarises nested Error fields so legacy logWarn data payloads stay safe', async () => {
    const { logger } = await import('~/utils/logger')
    const inner = new TimeoutError({ body: { method: 'eth_call' }, url: 'https://rpc.example' })
    const outer = new ContractFunctionExecutionError(inner, {
      abi: [{ type: 'function', name: 'foo', inputs: [], outputs: [], stateMutability: 'view' }],
      args: ['0xdeadbeef'],
      contractAddress: '0x0000000000000000000000000000000000000001',
      functionName: 'foo',
    })
    logger.warn({ ctx: 'wallets/batchFetch', data: { error: outer } }, 'failed')
    const line = cap.lines()[0]
    const json = JSON.stringify(line)
    expect(json).not.toContain('"abi"')
    expect(json).not.toContain('metaMessages')
    expect(json).not.toContain('0xdeadbeef')
    expect(json).toContain('rpc-timeout')
  })

  it('does not throw when structured fields contain bigint values or cycles', async () => {
    const { logger } = await import('~/utils/logger')
    const cyclic: { amount: bigint, self?: unknown } = { amount: 123n }
    cyclic.self = cyclic
    expect(() => logger.warn({ ctx: 'safe-json', cyclic }, 'ok')).not.toThrow()
    expect(cap.lines()[0]).toMatchObject({
      ctx: 'safe-json',
      cyclic: { amount: '123', self: '[Circular]' },
      msg: 'ok',
    })
  })

  it('projects non-plain objects to bounded scalar summaries for useful logs', async () => {
    const { logger } = await import('~/utils/logger')
    const response = new Response('nope', {
      status: 503,
      statusText: 'Service Unavailable',
    })

    logger.warn({ ctx: 'fetch/test', response }, 'upstream failed')

    expect(cap.lines()[0]).toMatchObject({
      ctx: 'fetch/test',
      response: {
        type: 'Response',
        status: 503,
        statusText: 'Service Unavailable',
      },
      msg: 'upstream failed',
    })
  })

  it('child() merges bindings into every emitted record', async () => {
    const { logger } = await import('~/utils/logger')
    const child = logger.child({ ctx: 'warm-cache', chainId: 1 })
    child.info({ batch: 'evk' }, 'ok')
    expect(cap.lines()[0]).toMatchObject({ level: 'info', ctx: 'warm-cache', chainId: 1, batch: 'evk', msg: 'ok' })
  })

  it('accepts a bare-string call (logger.warn(\'msg\'))', async () => {
    const { logger } = await import('~/utils/logger')
    logger.warn('hello')
    expect(cap.lines()[0]).toMatchObject({ level: 'warn', msg: 'hello' })
  })

  it('routes error level to level=error', async () => {
    const { logger } = await import('~/utils/logger')
    logger.error({ ctx: 'x' }, 'boom')
    expect(cap.lines()[0]).toMatchObject({ level: 'error' })
  })

  it('redacts RPC URL through the summariser (defence-in-depth)', async () => {
    const { logger } = await import('~/utils/logger')
    const err = new TimeoutError({
      body: { method: 'eth_call' },
      url: 'https://base-mainnet.core.chainstack.com/9f15ebed5cbdb72826d7d0604db4e64c',
    })
    logger.warn({ ctx: 'vault/x', err }, 'fail')
    const line = JSON.stringify(cap.lines()[0])
    expect(line).not.toContain('9f15ebed5cbdb72826d7d0604db4e64c')
    expect(line).toContain('base-mainnet.core.chainstack.com')
  })
})

describe('shared logger — browser branch (console)', () => {
  const consoleSpies: Record<string, ReturnType<typeof vi.spyOn>> = {}
  let originalWindow: unknown
  const setBrowserWindow = (
    options: { search?: string, verboseStorage?: string | null } = {},
  ) => {
    const { search = '', verboseStorage = null } = options
    ;(globalThis as { window?: unknown }).window = {
      location: { search },
      localStorage: {
        getItem: vi.fn((key: string) => key === 'euler_verbose' ? verboseStorage : null),
      },
    }
  }

  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
    setBrowserWindow()
    consoleSpies.warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleSpies.info = vi.spyOn(console, 'info').mockImplementation(() => {})
    consoleSpies.error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.resetModules()
  })

  afterEach(() => {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
    Object.values(consoleSpies).forEach(s => s.mockRestore())
  })

  it('suppresses warn/info by default but keeps error/fatal visible', async () => {
    const { logger } = await import('~/utils/logger')
    logger.warn({ ctx: 'vault/test', chainId: 8453 }, 'hello')
    logger.info({ ctx: 'vault/test', chainId: 8453 }, 'info')
    logger.error({ ctx: 'vault/test', chainId: 8453 }, 'boom')

    expect(consoleSpies.warn).not.toHaveBeenCalled()
    expect(consoleSpies.info).not.toHaveBeenCalled()
    expect(consoleSpies.error).toHaveBeenCalledTimes(1)
    const call = consoleSpies.error.mock.calls.at(-1)!
    expect(call[0]).toBe('[vault/test] (chainId=8453)')
    expect(call[1]).toBe('boom')
    expect(call[2]).toMatchObject({ ctx: 'vault/test', chainId: 8453 })
  })

  it('emits lower-level logs when opted in with ?verbose', async () => {
    setBrowserWindow({ search: '?verbose' })
    vi.resetModules()
    const { logger } = await import('~/utils/logger')
    logger.warn({ ctx: 'vault/test', chainId: 8453 }, 'hello')
    const call = consoleSpies.warn.mock.calls.at(-1)!
    expect(call[0]).toBe('[vault/test] (chainId=8453)')
    expect(call[1]).toBe('hello')
    expect(call[2]).toMatchObject({ ctx: 'vault/test', chainId: 8453 })
  })

  it('emits lower-level logs when opted in through localStorage', async () => {
    setBrowserWindow({ verboseStorage: '1' })
    vi.resetModules()
    const { logger } = await import('~/utils/logger')
    logger.warn({ ctx: 'vault/test', chainId: 8453 }, 'hello')
    expect(consoleSpies.warn).toHaveBeenCalledTimes(1)
  })
})

describe('server pino logger', () => {
  it('summarises errors via the err serializer (top-level)', async () => {
    vi.resetModules()
    const inner = new TimeoutError({ body: { method: 'eth_call' }, url: 'https://rpc.example' })
    const outer = new ContractFunctionExecutionError(inner, {
      abi: [{ type: 'function', name: 'foo', inputs: [], outputs: [], stateMutability: 'view' }],
      args: ['0xdeadbeef'],
      contractAddress: '0x0000000000000000000000000000000000000001',
      functionName: 'foo',
    })
    const cap = captureStdout()
    try {
      const { logger } = await import('~/server/utils/logger')
      logger.warn({ ctx: 'vault/x', err: outer }, 'fetch failed')
    }
    finally {
      cap.restore()
    }
    const flat = cap.captured.join('')
    expect(flat).not.toContain('"abi"')
    expect(flat).not.toContain('metaMessages')
    expect(flat).not.toContain('0xdeadbeef')
    expect(flat).toContain('rpc-timeout')
  })

  it('regression: pino serializers do not walk nested error fields, so callers must summarise at the call site if they need to nest', async () => {
    vi.resetModules()
    const { pino } = await import('pino')
    const { summarizeViemError } = await import('~/utils/viem-errors')
    const captured: string[] = []
    const stream = {
      write: (s: string) => {
        captured.push(s)
        return true
      },
    }
    // Mirror the real serializer config from server/utils/logger.ts.
    const log = pino({
      base: { app: 'euler-lite' },
      formatters: { level: (label: string) => ({ level: label }) },
      serializers: { err: summarizeViemError, error: summarizeViemError },
    }, stream as unknown as NodeJS.WritableStream)

    const inner = new TimeoutError({ body: { method: 'eth_call' }, url: 'https://rpc.example' })
    const outer = new ContractFunctionExecutionError(inner, {
      abi: [{ type: 'function', name: 'foo', inputs: [], outputs: [], stateMutability: 'view' }],
      args: ['0xdeadbeef'],
      contractAddress: '0x0000000000000000000000000000000000000001',
      functionName: 'foo',
    })

    log.warn({ ctx: 'top', err: outer }, 'top-level')
    log.warn({ ctx: 'nested', wrapper: { err: summarizeViemError(outer) } }, 'nested')

    const lines = captured.join('').split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    for (const line of lines) {
      expect(line).not.toContain('"abi"')
      expect(line).not.toContain('metaMessages')
      expect(line).not.toContain('0xdeadbeef')
    }
  })
})
