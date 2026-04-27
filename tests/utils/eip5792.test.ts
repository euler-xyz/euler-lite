import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, type Address } from 'viem'
import {
  extractCallsStatusHash,
  isUserRejectedRequestError,
  shouldUseAtomicCalls,
  supportsAtomicBatching,
  supportsPaymaster,
  toWalletCall,
} from '~/utils/eip5792'
import type { TxStep } from '~/entities/txPlan'

const abi = parseAbi(['function transfer(address to, uint256 amount)'])
const token = '0x0000000000000000000000000000000000000001' as Address
const recipient = '0x0000000000000000000000000000000000000002' as Address

const step = (value = 0n): TxStep => ({
  type: 'other',
  to: token,
  abi,
  functionName: 'transfer',
  args: [recipient, 123n],
  value,
})

describe('eip5792 helpers', () => {
  it('encodes TxStep values into wallet calls', () => {
    expect(toWalletCall(step())).toEqual({
      to: token,
      data: encodeFunctionData({
        abi,
        functionName: 'transfer',
        args: [recipient, 123n],
      }),
    })

    expect(toWalletCall(step(4n)).value).toBe(4n)
  })

  it('detects atomic support from direct and chain-keyed capabilities', () => {
    expect(supportsAtomicBatching({ atomic: { status: 'supported' } }, 8453)).toBe(true)
    expect(supportsAtomicBatching({ 8453: { atomic: { status: 'ready' } } }, 8453)).toBe(true)
    expect(supportsAtomicBatching({ 8453: { atomic: { status: 'unsupported' } } }, 8453)).toBe(false)
  })

  it('requires multiple steps before choosing atomic calls', () => {
    const capabilities = { atomic: { status: 'supported' } }

    expect(shouldUseAtomicCalls({ stepCount: 1, capabilities, chainId: 8453 })).toBe(false)
    expect(shouldUseAtomicCalls({ stepCount: 2, capabilities, chainId: 8453 })).toBe(true)
  })

  it('detects paymaster support without enabling paymaster execution', () => {
    expect(supportsPaymaster({ paymasterService: { supported: true } }, 8453)).toBe(true)
    expect(supportsPaymaster({ 8453: { paymasterService: { supported: true } } }, 8453)).toBe(true)
    expect(supportsPaymaster({ 8453: { paymasterService: { supported: false } } }, 8453)).toBe(false)
  })

  it('extracts a transaction hash from calls status receipts', () => {
    const hash = '0x1234567890abcdef'
    expect(extractCallsStatusHash({ receipts: [{ transactionHash: hash }] })).toBe(hash)
    expect(extractCallsStatusHash({ receipts: [] })).toBeUndefined()
  })

  it('detects user-rejected wallet errors through common shapes', () => {
    expect(isUserRejectedRequestError({ code: 4001 })).toBe(true)
    expect(isUserRejectedRequestError({ cause: { name: 'UserRejectedRequestError' } })).toBe(true)
    expect(isUserRejectedRequestError(new Error('User rejected the request.'))).toBe(true)
    expect(isUserRejectedRequestError(new Error('method not supported'))).toBe(false)
  })
})
