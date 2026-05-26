import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PublicClient } from 'viem'
import { batchLensCalls } from '~/utils/multicall'

const clientCall = vi.fn()

const provider = { call: clientCall } as unknown as PublicClient

const abi = [{
  type: 'function',
  name: 'foo',
  inputs: [],
  outputs: [{ type: 'uint256' }],
  stateMutability: 'view',
}] as const

const calls = [
  { functionName: 'foo', args: [] },
  { functionName: 'foo', args: [] },
]

describe('batchLensCalls', () => {
  beforeEach(() => {
    clientCall.mockReset()
  })

  it('treats non-Error provider throwables as transport failures to avoid retry amplification', async () => {
    clientCall.mockRejectedValue({ message: 'fetch failed' })

    const results = await batchLensCalls(
      provider,
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
      abi,
      calls,
    )

    expect(results).toEqual([
      { success: false, result: null, transportError: true },
      { success: false, result: null, transportError: true },
    ])
  })
})
