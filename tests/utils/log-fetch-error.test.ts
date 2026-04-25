import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
 *    wrapped as `ContractFunctionExecutionError → CallExecutionError → TimeoutError`.
 *  - The old `logConciseFetchError` only matched outer `err.message` substrings,
 *    didn't recognise viem's wording, and dumped the whole object to stderr —
 *    one log line per visual newline of `util.inspect` output.
 *  - We now walk the cause chain and emit ONE structured JSON line per error
 *    event with the chain id, kind, and a redacted host as JSON fields.
 *
 * Tests run under vitest's default `node` environment, so the shared logger
 * shim takes its Node branch and writes JSON to stdout. Each test captures
 * stdout to inspect the emitted lines.
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
  let cap: ReturnType<typeof captureStdout>

  beforeEach(() => {
    cap = captureStdout()
  })

  afterEach(() => {
    cap.restore()
  })

  it('emits exactly one log line for a wrapped TimeoutError', () => {
    logConciseFetchError('vault/fetchEarnVault', 8453, '0xabc', buildWrappedTimeout())
    expect(cap.lines()).toHaveLength(1)
  })

  it('records chainId as a JSON field at level=warn', () => {
    logConciseFetchError('vault/fetchEarnVault', 8453, '0xabc', buildWrappedTimeout())
    const line = cap.lines()[0]
    expect(line).toMatchObject({
      level: 'warn',
      ctx: 'vault/fetchEarnVault',
      chainId: 8453,
      kind: 'rpc-timeout',
      subject: '0xabc',
    })
  })

  it('never leaks abi, metaMessages, args, hex blobs, or the API-keyed RPC URL path', () => {
    logConciseFetchError('vault/fetchEarnVault', 8453, '0xabc', buildWrappedTimeout())
    const flat = cap.captured.join('')
    expect(flat).not.toContain('"abi"')
    expect(flat).not.toContain('metaMessages')
    expect(flat).not.toContain('"args"')
    expect(flat).not.toContain('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    // The Chainstack project ID (the API key) must never appear in logs.
    expect(flat).not.toContain('9f15ebed5cbdb72826d7d0604db4e64c')
    // The host alone is fine — that's the diagnostic value we want.
    expect(flat).toContain('base-mainnet.core.chainstack.com')
  })

  it('walks the cause chain — wrapped TimeoutError reads as kind=rpc-timeout, not unknown', () => {
    logConciseFetchError('vault/fetchEarnVault', 8453, '0xabc', buildWrappedTimeout())
    expect(cap.lines()[0].kind).toBe('rpc-timeout')
  })

  it('classifies an HTTP transport error at level=warn', () => {
    logConciseFetchError(
      'vault/fetchEarnVault',
      1,
      '0xabc',
      new HttpRequestError({ body: { method: 'eth_call' }, status: 503, url: 'https://rpc.example' }),
    )
    const line = cap.lines()[0]
    expect(line).toMatchObject({ level: 'warn', kind: 'rpc-http', chainId: 1 })
  })

  it('classifies a contract revert at level=warn (lens called against non-vault)', () => {
    const reverted = new ContractFunctionRevertedError({ abi: [], data: '0x', functionName: 'foo' })
    logConciseFetchError('vault/fetchIndividual', 42161, '0xabc', reverted)
    const line = cap.lines()[0]
    expect(line).toMatchObject({ level: 'warn', kind: 'contract-revert' })
  })

  it('logs at error severity for a genuinely unexpected exception', () => {
    logConciseFetchError('vault/fetchEarnVault', 8453, '0xabc', new TypeError('Cannot read properties of undefined (reading "foo")'))
    const line = cap.lines()[0]
    expect(line.level).toBe('error')
    // Even on the error path, the err field is summarised — no abi/metaMessages.
    expect(JSON.stringify(line)).not.toContain('"abi"')
  })
})
