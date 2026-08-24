import { isHash, type Hash } from 'viem'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'
import type { FinalizedRequestSet, SafeCall, SafeTransportEnvelope, ReviewedExecution } from '../domain/reviewed-execution'
import { AttemptRevertedError, DispatchFailedError, DispatchStatusUnknownError, ProvenOffchainCancellationError, ProvenPreDispatchCancellationError } from '../coordinator/errors'
import type { ExecutionTransportAdapter, DispatchCallbacks, DispatchResult } from './types'

export interface SafeCallsStatus {
  executionHash: Hash
  receiptStatus: 'success' | 'reverted'
  atomic: boolean
}

export interface SafeAdapterClient {
  assertAtomicCapability(envelope: SafeTransportEnvelope): Promise<void>
  sendCalls(envelope: SafeTransportEnvelope): Promise<string>
  waitForExecution(callsId: Hash): Promise<SafeCallsStatus>
}

const isUserRejected = (error: unknown) => {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? Number(error.code) : undefined
  const message = 'message' in error && typeof error.message === 'string' ? error.message.toLowerCase() : ''
  return code === 4001 || code === 5000 || message.includes('user rejected') || message.includes('user denied')
}

export class SafeExecutionAdapter implements ExecutionTransportAdapter {
  readonly transport = 'safe' as const

  constructor(private readonly client: SafeAdapterClient) {}

  async dispatch(execution: ReviewedExecution, artifact: FinalizedRequestSet, callbacks: DispatchCallbacks): Promise<DispatchResult> {
    if (artifact.transport !== 'safe') throw new Error('Safe adapter received an EOA artifact')
    const calls = artifact.requests as readonly SafeCall[]
    const envelope = artifact.safeTransport
    if (!envelope) throw new Error('Safe adapter received no finalized transport envelope')
    const sealedEnvelope = execution.requestSet.safeTransport
    if (!sealedEnvelope) throw new Error('Reviewed execution contains no Safe transport envelope')
    const withoutCalls = ({ calls: _calls, ...value }: SafeTransportEnvelope) => value
    if (canonicalDigest('safe-transport-envelope-v1', toCanonicalValue(withoutCalls(envelope)))
      !== canonicalDigest('safe-transport-envelope-v1', toCanonicalValue(withoutCalls(sealedEnvelope)))) {
      throw new Error('Safe transport envelope fields changed after review')
    }
    if (envelope.calls.length !== calls.length || envelope.calls.some((call, index) => {
      const request = calls[index]
      return !request || call.to !== request.to || call.data !== request.data || call.value !== request.value
    })) throw new Error('Safe transport envelope differs from the finalized reviewed calls')
    await callbacks.assertWalletBinding()
    await this.client.assertAtomicCapability(envelope)
    await callbacks.beforeDispatch(0)

    let callsId: string
    try {
      callsId = await this.client.sendCalls(envelope)
    }
    catch (error) {
      if (isUserRejected(error)) throw new ProvenPreDispatchCancellationError()
      throw new DispatchStatusUnknownError()
    }
    if (!isHash(callsId)) throw new DispatchStatusUnknownError('Safe returned no valid calls ID')
    await callbacks.recordExternalId(0, 'calls-id', callsId)

    await callbacks.markConfirming(0)
    try {
      const execution = await this.client.waitForExecution(callsId)
      await callbacks.recordExternalId(0, 'execution-hash', execution.executionHash)
      if (execution.atomic !== true) throw new DispatchFailedError('Safe call batch was not confirmed atomic')
      if (execution.receiptStatus === 'reverted') throw new AttemptRevertedError('Safe execution reverted')
      await callbacks.afterConfirmed(0)
      return { transactionHashes: [execution.executionHash], callsId, executionHash: execution.executionHash, atomic: true }
    }
    catch (error) {
      if (error instanceof AttemptRevertedError || error instanceof DispatchFailedError) throw error
      if (error instanceof Error && error.message === 'Safe transaction was cancelled') {
        throw new ProvenOffchainCancellationError(error.message)
      }
      if (error instanceof Error && error.message === 'Safe transaction failed') {
        throw new DispatchFailedError(error.message)
      }
      if (error instanceof Error && error.message === 'Safe call batch was not atomic') {
        throw new DispatchFailedError(error.message)
      }
      throw new DispatchStatusUnknownError('Safe proposal status is unknown. Check your Safe for the latest status.')
    }
  }
}
