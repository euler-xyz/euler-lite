import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TimeoutError,
  ContractFunctionExecutionError,
  CallExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
} from 'viem'
import { logConciseFetchError } from '~/entities/vault/log-fetch-error'

/**
 * Regression test for the 568-row BetterStack incident on 2026-04-25:
 *  - A single viem TimeoutError against base-mainnet's Chainstack RPC was
 *    wrapped as `ContractFunctionExecutionError → CallExecutionError → TimeoutError`
 *  - The old `logConciseFetchError` only matched outer `err.message` substrings,
 *    didn't recognise viem's wording, and dumped the whole object to stderr —
 *    one log line per visual newline of `util.inspect` output.
 *  - We now walk the cause chain and emit ONE structured log per error event
 *    with the chain id + chain name as JSON fields.
 */

const buildWrappedTimeout = () => {
  const inner = new TimeoutError({
    body: { method: 'eth_call' },
    url: 'https://base-mainnet.core.chainstack.com/9f15ebed5cbdb72826d7d0604db4e64c',
  })
  const middle = new CallExecutionError(inner, {
    account: undefined,
    data: '0xdeadbeef',
    to: '0x0BBf9eE761bFF1c4d64dB608781D5e3beFeed875',
  })
  return new ContractFunctionExecutionError(middle, {
    abi: [{ type: 'function', name: 'getVaultInfoFull', inputs: [], outputs: [], stateMutability: 'view' }],
    args: ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    contractAddress: '0x0BBf9eE761bFF1c4d64dB608781D5e3beFeed875',
    functionName: 'getVaultInfoFull',
  })
}

describe('logConciseFetchError — regression for 568-row BetterStack incident', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('emits exactly one warn (not error) for a wrapped TimeoutError', () => {
    logConciseFetchError('vault/fetchEarnVault', 8453, '0xabc', buildWrappedTimeout())
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('records chainId and chain name as JSON fields', () => {
    logConciseFetchError('vault/fetchEarnVault', 8453, '0xabc', buildWrappedTimeout())
    const fields = warnSpy.mock.calls[0][2] as Record<string, unknown>
    expect(fields).toMatchObject({
      ctx: 'vault/fetchEarnVault',
      chainId: 8453,
      chain: 'Base',
      kind: 'rpc-timeout',
      subject: '0xabc',
    })
  })

  it('never leaks abi, metaMessages, args, or hex blobs', () => {
    logConciseFetchError('vault/fetchEarnVault', 8453, '0xabc', buildWrappedTimeout())
    const json = JSON.stringify(warnSpy.mock.calls[0])
    expect(json).not.toContain('"abi"')
    expect(json).not.toContain('metaMessages')
    expect(json).not.toContain('"args"')
    expect(json).not.toContain('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  })

  it('walks the cause chain — wrapped TimeoutError reads as kind=rpc-timeout, not unknown', () => {
    logConciseFetchError('vault/fetchEarnVault', 8453, '0xabc', buildWrappedTimeout())
    const fields = warnSpy.mock.calls[0][2] as Record<string, unknown>
    expect(fields.kind).toBe('rpc-timeout')
  })

  it('classifies an HTTP transport error as warn (not error)', () => {
    logConciseFetchError(
      'vault/fetchEarnVault',
      1,
      '0xabc',
      new HttpRequestError({ body: { method: 'eth_call' }, status: 503, url: 'https://rpc.example' }),
    )
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
    const fields = warnSpy.mock.calls[0][2] as Record<string, unknown>
    expect(fields.kind).toBe('rpc-http')
    expect(fields.chain).toBe('Ethereum')
  })

  it('classifies a contract revert as warn (lens called against non-vault)', () => {
    const reverted = new ContractFunctionRevertedError({ abi: [], data: '0x', functionName: 'foo' })
    logConciseFetchError('vault/fetchIndividual', 42161, '0xabc', reverted)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const fields = warnSpy.mock.calls[0][2] as Record<string, unknown>
    expect(fields.kind).toBe('contract-revert')
  })

  it('logs at error severity for a genuinely unexpected exception', () => {
    logConciseFetchError('vault/fetchEarnVault', 8453, '0xabc', new TypeError('Cannot read properties of undefined (reading "foo")'))
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
    const fields = errorSpy.mock.calls[0][2] as Record<string, unknown>
    // Even on the error path, the err field is summarised — no abi/metaMessages.
    expect(JSON.stringify(fields)).not.toContain('"abi"')
  })
})
