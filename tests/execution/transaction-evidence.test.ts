import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi } from 'viem'
import { assertExecutionEvidence } from './transaction-evidence.mjs'

const vault = '0x1000000000000000000000000000000000000001'
const account = '0x2000000000000000000000000000000000000002'
const abi = parseAbi([
  'function approve(address spender,uint256 amount)',
  'function withdraw(uint256 assets,address receiver,address owner)',
  'function redeem(uint256 shares,address receiver,address owner)',
  'function batch((address targetContract,address onBehalfOfAccount,uint256 value,bytes data)[] items) payable',
])
const scenario = {
  covers: ['redeem-and-swap'],
  startedAt: '2026-10-13T00:00:00Z',
  finishedAt: '2026-10-13T00:01:00Z',
  requiredCalls: [{ target: vault, signature: 'redeem(uint256,address,address)' }],
}
const record = (data: `0x${string}`, receiptStatus = '0x1', recordedAt = '2026-10-13T00:00:30Z') => ({
  method: 'eth_sendTransaction', status: 'success', result: '0x1234',
  recordedAt, receipt: { status: receiptStatus }, params: [{ to: vault, data }],
})
const redeem = encodeFunctionData({ abi, functionName: 'redeem', args: [1n, account, account] })

describe('fork transaction coverage evidence', () => {
  it('rejects an approval-only scenario', () => {
    const approve = encodeFunctionData({ abi, functionName: 'approve', args: [account, 1n] })
    expect(() => assertExecutionEvidence([record(approve)], scenario)).toThrow('approvals do not establish')
  })

  it('does not count reverted or other-scenario executions', () => {
    expect(() => assertExecutionEvidence([
      record(redeem, '0x0'), record(redeem, '0x1', '2026-10-12T23:59:00Z'),
    ], scenario)).toThrow('No successful execution call')
  })

  it('does not credit a partial withdrawal as redemption', () => {
    const withdraw = encodeFunctionData({ abi, functionName: 'withdraw', args: [1n, account, account] })
    expect(() => assertExecutionEvidence([record(withdraw)], scenario)).toThrow('No successful redeem')
  })

  it('requires the actual redeem call inside the successful EVC batch', () => {
    const data = encodeFunctionData({ abi, functionName: 'batch', args: [[{
      targetContract: vault, onBehalfOfAccount: account, value: 0n, data: redeem,
    }]] })
    expect(assertExecutionEvidence([record(data)], scenario)).toEqual([{
      to: vault, selector: redeem.slice(0, 10), hash: '0x1234',
    }])
  })

  it('requires both operations in one transaction for atomic batch coverage', () => {
    const batchScenario = { ...scenario, requireAtomicExecution: true, requiredCalls: [{ ...scenario.requiredCalls[0], count: 2 }] }
    expect(() => assertExecutionEvidence([record(redeem)], batchScenario)).toThrow('No successful redeem')
    expect(() => assertExecutionEvidence([record(redeem), { ...record(redeem), result: '0x5678' }], batchScenario)).toThrow('one atomic')
    const item = { targetContract: vault, onBehalfOfAccount: account, value: 0n, data: redeem } as const
    const data = encodeFunctionData({ abi, functionName: 'batch', args: [[item, item]] })
    expect(assertExecutionEvidence([record(data)], batchScenario)).toHaveLength(2)
  })
})
