import { getAddress, isHash, type Hash } from 'viem'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'
import type { FinalizedRequestSet, SafeCall, ReviewedExecution } from '../domain/reviewed-execution'
import { AttemptRevertedError, DispatchStatusUnknownError, ProvenOffchainCancellationError, ProvenPreDispatchCancellationError } from '../coordinator/errors'
import type { ExecutionTransportAdapter, DispatchCallbacks, DispatchResult } from './types'

export interface SafeCallsStatus {
  status: number
  executionHash?: Hash
}

export interface SafeAdapterClient {
  sendCalls(calls: readonly SafeCall[]): Promise<string>
  getProposedCalls(callsId: string): Promise<readonly { to: `0x${string}`, data: `0x${string}`, value: bigint }[]>
  waitForCallsStatus(callsId: string): Promise<SafeCallsStatus>
  getExecutionReceipt(hash: Hash): Promise<{ status: 'success' | 'reverted' } | undefined>
}

export const safeCallVectorDigest = (calls: readonly Pick<SafeCall, 'to' | 'data' | 'value'>[]): Hash =>
  canonicalDigest('safe-call-vector-v1', toCanonicalValue(calls.map(call => ({
    to: getAddress(call.to), data: call.data.toLowerCase(), value: call.value,
  }))))

const isUserRejected = (error: unknown) => {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? Number(error.code) : undefined
  return code === 4001 || code === 5000
}

export class SafeExecutionAdapter implements ExecutionTransportAdapter {
  readonly transport = 'safe' as const

  constructor(private readonly client: SafeAdapterClient) {}

  async dispatch(_execution: ReviewedExecution, artifact: FinalizedRequestSet, callbacks: DispatchCallbacks): Promise<DispatchResult> {
    if (artifact.transport !== 'safe') throw new Error('Safe adapter received an EOA artifact')
    const calls = artifact.requests as readonly SafeCall[]
    await callbacks.assertWalletBinding()
    await callbacks.assertReservation()
    await callbacks.beforeDispatch(0, { callVectorDigest: safeCallVectorDigest(calls) })

    let callsId: string
    try {
      callsId = await this.client.sendCalls(calls)
    }
    catch (error) {
      if (isUserRejected(error)) throw new ProvenPreDispatchCancellationError()
      throw new DispatchStatusUnknownError()
    }
    if (!callsId) throw new DispatchStatusUnknownError('Safe returned no calls ID')
    await callbacks.recordExternalId('calls-id', callsId)

    const proposed = await this.client.getProposedCalls(callsId).catch(() => undefined)
    if (!proposed || safeCallVectorDigest(proposed.map((call, index) => ({ ...calls[index]!, ...call }))) !== safeCallVectorDigest(calls)) {
      throw new DispatchStatusUnknownError('Safe proposal cannot be matched to the reviewed call vector')
    }
    await callbacks.markConfirming(0)
    const status = await this.client.waitForCallsStatus(callsId).catch(() => undefined)
    if (!status) throw new DispatchStatusUnknownError('Safe proposal status is unavailable')
    if (status.executionHash) await callbacks.recordExternalId('execution-hash', status.executionHash)
    if (status.status === 400) throw new ProvenOffchainCancellationError('Safe proved that the proposal was cancelled off-chain')
    if (status.status === 200 && status.executionHash) {
      const receipt = await this.client.getExecutionReceipt(status.executionHash).catch(() => undefined)
      if (!receipt) throw new DispatchStatusUnknownError('Safe execution receipt is unavailable')
      if (receipt.status === 'reverted') throw new AttemptRevertedError('Safe execution reverted')
      await callbacks.afterConfirmed(0)
      return { transactionHashes: [status.executionHash], executionHash: status.executionHash }
    }
    if ((status.status === 500 || status.status === 600) && status.executionHash && isHash(status.executionHash)) {
      const receipt = await this.client.getExecutionReceipt(status.executionHash).catch(() => undefined)
      if (receipt?.status === 'reverted') throw new AttemptRevertedError('Safe execution reverted')
      if (receipt?.status === 'success') {
        await callbacks.afterConfirmed(0)
        return { transactionHashes: [status.executionHash], executionHash: status.executionHash }
      }
    }
    throw new DispatchStatusUnknownError('Safe proposal requires reconciliation')
  }
}
