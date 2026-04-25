import { describe, it, expect, vi } from 'vitest'
import { isAbortError, logWarn, catchToFallback } from '~/utils/errorHandling'

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

describe('logWarn (legacy shim — delegates to structured logger)', () => {
  it('routes the default severity through console.warn with the [ctx] prefix', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logWarn('test', 'message')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('[test]')
    expect(spy.mock.calls[0][1]).toBe('message')
    spy.mockRestore()
  })

  it('routes severity:error through console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logWarn('test', 'message', { severity: 'error' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('[test]')
    spy.mockRestore()
  })

  it('does nothing when severity is silent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logWarn('test', 'message', { severity: 'silent' })
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('attaches additional data as a structured field', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logWarn('ctx', 'err', { data: { extra: true } })
    expect(spy).toHaveBeenCalledTimes(1)
    const fields = spy.mock.calls[0][2] as Record<string, unknown>
    expect(fields).toMatchObject({ ctx: 'ctx', data: { extra: true } })
    spy.mockRestore()
  })

  it('passes Error objects through summarisation (no abi/metaMessages)', async () => {
    const { TimeoutError } = await import('viem')
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = new TimeoutError({ body: { method: 'eth_call' }, url: 'https://rpc.example' })
    logWarn('vault/x', err)
    const fields = spy.mock.calls[0][2] as Record<string, unknown>
    expect(JSON.stringify(fields)).toContain('rpc-timeout')
    expect(JSON.stringify(fields)).not.toContain('"abi"')
    spy.mockRestore()
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
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const thrower = async () => {
      throw new Error('fail')
    }
    await catchToFallback(thrower, 99, 'test/ctx')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
