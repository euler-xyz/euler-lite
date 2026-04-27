import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { isAbortError, logWarn, catchToFallback } from '~/utils/errorHandling'

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

describe('isAbortError', () => {
  it('returns true for DOMException AbortError', () => {
    const err = new DOMException('aborted', 'AbortError')
    expect(isAbortError(err)).toBe(true)
  })

  it('returns true for object with name AbortError', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true)
  })

  it('returns true for object with name CanceledError (Axios)', () => {
    expect(isAbortError({ name: 'CanceledError' })).toBe(true)
  })

  it('returns false for regular Error', () => {
    expect(isAbortError(new Error('test'))).toBe(false)
  })

  it('returns false for null', () => {
    expect(isAbortError(null)).toBe(false)
  })

  it('returns false for string', () => {
    expect(isAbortError('AbortError')).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isAbortError(undefined)).toBe(false)
  })

  it('returns false for non-object types', () => {
    expect(isAbortError(42)).toBe(false)
    expect(isAbortError(true)).toBe(false)
  })
})

describe('logWarn — client-side helper that routes through the shared logger', () => {
  let cap: ReturnType<typeof captureStdout>

  beforeEach(() => {
    cap = captureStdout()
  })

  afterEach(() => {
    cap.restore()
  })

  it('emits at level=warn by default with the ctx field set', () => {
    logWarn('test', 'message')
    expect(cap.lines()[0]).toMatchObject({ level: 'warn', ctx: 'test', msg: 'message' })
  })

  it('emits at level=error when severity is error', () => {
    logWarn('test', 'message', { severity: 'error' })
    expect(cap.lines()[0]).toMatchObject({ level: 'error', ctx: 'test', msg: 'message' })
  })

  it('does nothing when severity is silent', () => {
    logWarn('test', 'message', { severity: 'silent' })
    expect(cap.captured).toHaveLength(0)
  })

  it('attaches additional data as a structured field', () => {
    logWarn('ctx', 'err', { data: { extra: true } })
    expect(cap.lines()[0]).toMatchObject({ ctx: 'ctx', data: { extra: true }, msg: 'err' })
  })

  it('passes Error objects through summarisation (no abi/metaMessages)', async () => {
    const { TimeoutError } = await import('viem')
    const err = new TimeoutError({ body: { method: 'eth_call' }, url: 'https://rpc.example' })
    logWarn('vault/x', err)
    const flat = cap.captured.join('')
    expect(flat).toContain('rpc-timeout')
    expect(flat).not.toContain('"abi"')
  })
})

describe('catchToFallback', () => {
  it('returns function result on success', async () => {
    const result = await catchToFallback(async () => 42, 0)
    expect(result).toBe(42)
  })

  it('returns fallback on error', async () => {
    const thrower = async () => {
      throw new Error('fail')
    }
    const result = await catchToFallback(thrower, 99)
    expect(result).toBe(99)
  })

  it('logs error when logContext provided', async () => {
    const cap = captureStdout()
    try {
      const thrower = async () => {
        throw new Error('fail')
      }
      await catchToFallback(thrower, 99, 'test/ctx')
    }
    finally {
      cap.restore()
    }
    expect(cap.captured.join('')).toContain('test/ctx')
  })
})
