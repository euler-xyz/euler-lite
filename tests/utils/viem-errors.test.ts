import { describe, it, expect } from 'vitest'
import {
  BaseError,
  TimeoutError,
  HttpRequestError,
  ContractFunctionExecutionError,
  CallExecutionError,
  ContractFunctionRevertedError,
  RpcRequestError,
  LimitExceededRpcError,
  ResourceUnavailableRpcError,
  InternalRpcError,
} from 'viem'
import { classifyViemError, isTransportError, summarizeViemError } from '~/utils/viem-errors'

describe('classifyViemError', () => {
  it('classifies a bare TimeoutError', () => {
    const err = new TimeoutError({
      body: { method: 'eth_call' },
      url: 'https://rpc.example/abc',
    })
    const out = classifyViemError(err)
    expect(out.kind).toBe('rpc-timeout')
    expect(out.isTransport).toBe(true)
    expect(out.url).toBe('rpc.example')
    expect(out.shortMessage).toMatch(/took too long/i)
  })

  it('redacts the RPC URL to host only — never logs the API-keyed path or query', () => {
    // Chainstack-style API key as a path segment.
    const chainstack = new TimeoutError({
      body: { method: 'eth_call' },
      url: 'https://base-mainnet.core.chainstack.com/9f15ebed5cbdb72826d7d0604db4e64c',
    })
    expect(classifyViemError(chainstack).url).toBe('base-mainnet.core.chainstack.com')

    // Alchemy-style API key as a path segment after a v2 prefix.
    const alchemy = new TimeoutError({
      body: { method: 'eth_call' },
      url: 'https://eth-mainnet.g.alchemy.com/v2/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })
    expect(classifyViemError(alchemy).url).toBe('eth-mainnet.g.alchemy.com')

    // Query-string API key.
    const queryKey = new TimeoutError({
      body: { method: 'eth_call' },
      url: 'https://rpc.example.com/?apikey=secret-token-deadbeef',
    })
    expect(classifyViemError(queryKey).url).toBe('rpc.example.com')

    // userinfo (legacy basic auth) in the URL.
    const userinfo = new TimeoutError({
      body: { method: 'eth_call' },
      url: 'https://user:password@rpc.example.com/path',
    })
    const out = classifyViemError(userinfo)
    expect(out.url).toBe('rpc.example.com')
    expect(out.url).not.toContain('user')
    expect(out.url).not.toContain('password')

    // A genuinely unparseable URL is dropped rather than leaked.
    const broken = new TimeoutError({
      body: { method: 'eth_call' },
      url: 'not a url at all',
    })
    expect(classifyViemError(broken).url).toBeUndefined()
  })

  it('walks the cause chain to recognise a wrapped TimeoutError', () => {
    const inner = new TimeoutError({
      body: { method: 'eth_call' },
      url: 'https://rpc.example',
    })
    const middle = new CallExecutionError(inner, {
      account: undefined,
      data: '0xdeadbeef',
      to: '0x0000000000000000000000000000000000000000',
    })
    const outer = new ContractFunctionExecutionError(middle, {
      abi: [],
      args: ['0x0000000000000000000000000000000000000000'],
      contractAddress: '0x0BBf9eE761bFF1c4d64dB608781D5e3beFeed875',
      functionName: 'getVaultInfoFull',
    })
    const out = classifyViemError(outer)
    expect(out.kind).toBe('rpc-timeout')
    expect(out.isTransport).toBe(true)
    expect(out.functionName).toBe('getVaultInfoFull')
    expect(out.contractAddress).toBe('0x0BBf9eE761bFF1c4d64dB608781D5e3beFeed875')
    expect(out.causeName).toBe('TimeoutError')
  })

  it('classifies a HTTP transport error', () => {
    const err = new HttpRequestError({
      body: { method: 'eth_call' },
      status: 503,
      url: 'https://rpc.example',
    })
    const out = classifyViemError(err)
    expect(out.kind).toBe('rpc-http')
    expect(out.isTransport).toBe(true)
    expect(out.status).toBe(503)
  })

  it('classifies a contract revert', () => {
    const reverted = new ContractFunctionRevertedError({
      abi: [],
      data: '0x',
      functionName: 'foo',
    })
    const wrapped = new ContractFunctionExecutionError(reverted, {
      abi: [],
      args: [],
      contractAddress: '0x0000000000000000000000000000000000000001',
      functionName: 'foo',
    })
    expect(classifyViemError(reverted).kind).toBe('contract-revert')
    expect(classifyViemError(wrapped).kind).toBe('contract-revert')
    expect(isTransportError(wrapped)).toBe(false)
  })

  it('classifies a non-viem TypeError: fetch failed as rpc-unreachable', () => {
    const err = new TypeError('fetch failed')
    const out = classifyViemError(err)
    expect(out.kind).toBe('rpc-unreachable')
    expect(out.isTransport).toBe(true)
  })

  it('classifies a non-viem ENOTFOUND DNS error as rpc-unreachable', () => {
    const err = new Error('getaddrinfo ENOTFOUND rpc.example')
    expect(classifyViemError(err).kind).toBe('rpc-unreachable')
  })

  it('returns kind=unknown for a plain Error with no signals', () => {
    const out = classifyViemError(new Error('something else broke'))
    expect(out.kind).toBe('unknown')
    expect(out.isTransport).toBe(false)
  })

  it('handles non-Error throwables', () => {
    expect(classifyViemError('string error').kind).toBe('unknown')
    expect(classifyViemError(null).kind).toBe('unknown')
    expect(classifyViemError(42).kind).toBe('unknown')
  })

  it('terminates on a self-referential cause chain', () => {
    const err: Error & { cause?: unknown } = new Error('loop')
    err.cause = err
    expect(() => classifyViemError(err)).not.toThrow()
  })

  it('terminates on a mutual cause cycle', () => {
    const a: Error & { cause?: unknown } = new Error('a')
    const b: Error & { cause?: unknown } = new Error('b')
    a.cause = b
    b.cause = a
    expect(() => classifyViemError(a)).not.toThrow()
    expect(classifyViemError(a).kind).toBe('unknown')
  })

  it('classifies a viem LimitExceededRpcError as rate-limited', () => {
    const err = new LimitExceededRpcError(
      new RpcRequestError({
        body: { method: 'eth_call' },
        error: { code: -32005, message: 'too many requests' },
        url: 'https://rpc.example',
      }),
    )
    const out = classifyViemError(err)
    expect(out.kind).toBe('rpc-rate-limited')
    expect(out.isTransport).toBe(true)
  })

  it('classifies a viem ResourceUnavailableRpcError as resource-unavailable', () => {
    const err = new ResourceUnavailableRpcError(
      new RpcRequestError({
        body: { method: 'eth_call' },
        error: { code: -32002, message: 'resource unavailable' },
        url: 'https://rpc.example',
      }),
    )
    expect(classifyViemError(err).kind).toBe('rpc-resource-unavailable')
  })

  it('classifies a viem InternalRpcError as unreachable', () => {
    const err = new InternalRpcError(
      new RpcRequestError({
        body: { method: 'eth_call' },
        error: { code: -32603, message: 'internal' },
        url: 'https://rpc.example',
      }),
    )
    expect(classifyViemError(err).kind).toBe('rpc-unreachable')
  })

  it('classifies a bare RpcRequestError with code -32005 as rate-limited via the JSON-RPC code fallback', () => {
    // Chainstack and other providers sometimes return bare RpcRequestError
    // shapes whose name doesn't match a known viem subclass. The class-name
    // lookup misses, but the JSON-RPC code fallback should refine the kind.
    const err = new RpcRequestError({
      body: { method: 'eth_call' },
      error: { code: -32005, message: 'too many requests' },
      url: 'https://rpc.example',
    })
    const out = classifyViemError(err)
    // Generic RpcRequestError is classified only after the JSON-RPC code has
    // had a chance to refine the kind.
    expect(out.isTransport).toBe(true)
    expect(out.kind).toBe('rpc-rate-limited')
  })

  it('refines an unrecognised wrapper with code -32005 to rate-limited via code fallback', () => {
    // Synthesise an Error whose name is not in the table, but whose `code`
    // is recognisable. This is the class of upstream that previously read
    // as kind: 'unknown' and bypassed the batch-level transport dedup.
    class WeirdRpcError extends Error {
      code = -32005
      constructor() {
        super('upstream throttled')
        this.name = 'WeirdRpcError'
      }
    }
    const out = classifyViemError(new WeirdRpcError())
    expect(out.kind).toBe('rpc-rate-limited')
    expect(out.isTransport).toBe(true)
  })
})

describe('summarizeViemError', () => {
  it('strips abi, metaMessages, and args from a wrapped contract error', () => {
    const inner = new TimeoutError({ body: { method: 'eth_call' }, url: 'https://rpc.example' })
    const middle = new CallExecutionError(inner, {
      account: undefined,
      data: '0xdeadbeef',
      to: '0x0000000000000000000000000000000000000000',
    })
    const outer = new ContractFunctionExecutionError(middle, {
      abi: [{ type: 'function', name: 'getVaultInfoFull', inputs: [], outputs: [], stateMutability: 'view' }],
      args: ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
      contractAddress: '0x0BBf9eE761bFF1c4d64dB608781D5e3beFeed875',
      functionName: 'getVaultInfoFull',
    })
    const summary = summarizeViemError(outer)
    const json = JSON.stringify(summary)
    expect(json).not.toContain('abi')
    expect(json).not.toContain('metaMessages')
    expect(json).not.toContain('args')
    // Hex blobs from raw call data should not appear.
    expect(json).not.toContain('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  })
})

describe('isTransportError', () => {
  it.each([
    ['TimeoutError', new TimeoutError({ body: { method: 'eth_call' }, url: 'https://rpc.example' })],
    ['HttpRequestError', new HttpRequestError({ body: { method: 'eth_call' }, status: 500, url: 'https://rpc.example' })],
    ['fetch failed', new TypeError('fetch failed')],
    ['ECONNREFUSED', new Error('connect ECONNREFUSED 127.0.0.1:8545')],
  ])('flags %s as transport', (_, err) => {
    expect(isTransportError(err)).toBe(true)
  })

  it.each([
    ['ContractFunctionRevertedError', new ContractFunctionRevertedError({ abi: [], data: '0x', functionName: 'foo' })],
    ['plain Error', new Error('not a network problem')],
  ])('does not flag %s as transport', (_, err) => {
    expect(isTransportError(err)).toBe(false)
  })

  it('treats non-viem unknown throwables as non-transport (matching previous safer-to-suppress semantics is moved to multicall)', () => {
    // classifyViemError is the source of truth; the multicall layer keeps its own
    // conservative "non-viem ⇒ transport" heuristic separately so that already-
    // broken-endpoint signals stop further retries.
    expect(isTransportError({ random: 'object' })).toBe(false)
  })
})

describe('classifyViemError — kind matrix is exhaustive', () => {
  it('only emits known kinds', () => {
    const known = new Set([
      'rpc-timeout',
      'rpc-http',
      'rpc-rate-limited',
      'rpc-resource-unavailable',
      'rpc-socket-closed',
      'rpc-unreachable',
      'contract-revert',
      'unknown',
    ])
    for (const err of [
      new TimeoutError({ body: { method: 'eth_call' }, url: 'https://rpc.example' }),
      new HttpRequestError({ body: { method: 'eth_call' }, status: 500, url: 'https://rpc.example' }),
      new BaseError('some viem err'),
      new Error('plain'),
      'string',
      null,
    ]) {
      expect(known.has(classifyViemError(err).kind)).toBe(true)
    }
  })
})
