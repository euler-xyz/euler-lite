import { decodeFunctionData, parseAbi, toFunctionSelector } from 'viem'

const batchAbi = parseAbi(['function batch((address targetContract,address onBehalfOfAccount,uint256 value,bytes data)[] items) payable'])
const batchSelector = toFunctionSelector(batchAbi[0])
const approvalSelectors = new Set([
  toFunctionSelector('approve(address,uint256)'),
  toFunctionSelector('approve(address,address,uint160,uint48)'),
  toFunctionSelector('setApprovalForAll(address,bool)'),
])

function executionCalls(tx) {
  const selector = tx.data?.slice(0, 10)
  if (!selector || selector.length !== 10 || approvalSelectors.has(selector)) return []
  if (selector === batchSelector) {
    const { args } = decodeFunctionData({ abi: batchAbi, data: tx.data })
    return args[0].flatMap(item => executionCalls({ to: item.targetContract, data: item.data }))
  }
  return [{ to: tx.to, selector }]
}

/** Coverage requires a mined execution call; an approval alone is insufficient. */
export function assertExecutionEvidence(walletRequests, scenario) {
  if (!scenario.covers?.length) return []
  const started = Date.parse(scenario.startedAt)
  const finished = Date.parse(scenario.finishedAt)
  const calls = walletRequests.flatMap((record) => {
    const time = Date.parse(record.recordedAt)
    if (record.method !== 'eth_sendTransaction' || record.status !== 'success'
      || record.receipt?.status !== '0x1' || !(time >= started && time <= finished)) return []
    return executionCalls(record.params?.[0] ?? {}).map(call => ({ ...call, hash: record.result }))
  })
  if (!calls.length) throw new Error('No successful execution call was recorded; approvals do not establish transaction coverage')
  if (scenario.requireAtomicExecution && new Set(calls.map(call => call.hash)).size !== 1) {
    throw new Error('Expected one atomic execution transaction')
  }
  for (const required of scenario.requiredCalls ?? []) {
    const selector = toFunctionSelector(required.signature)
    const matches = calls.filter(call => call.to?.toLowerCase() === required.target.toLowerCase() && call.selector === selector)
    if (matches.length < (required.count ?? 1)) {
      throw new Error(`No successful ${required.signature} call to ${required.target} was recorded`)
    }
  }
  return calls
}
