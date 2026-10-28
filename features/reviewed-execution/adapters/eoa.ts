import { getAddress, isHash, type Hash } from 'viem'
import {
  MaterializedTransactionRevertedError,
  type ExecuteMaterializedOptions,
  type FinalizedMaterializedExecution,
  type MaterializedExecutionResult,
} from '@eulerxyz/euler-v2-sdk'
import type { EoaRequest, FinalizedRequestSet, ReviewedExecution } from '../domain/reviewed-execution'
import { AttemptRevertedError, DispatchStatusUnknownError, ProvenPreDispatchCancellationError } from '../coordinator/errors'
import type { ExecutionTransportAdapter, DispatchCallbacks, DispatchOptions, DispatchResult } from './types'

export interface EoaAdapterClient {
  sendTransaction(request: EoaRequest): Promise<Hash>
}

export type EoaMaterializedExecutor = (
  execution: FinalizedMaterializedExecution,
  options: ExecuteMaterializedOptions,
) => Promise<MaterializedExecutionResult>

const isUserRejected = (error: unknown) => {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? Number(error.code) : undefined
  const message = 'message' in error && typeof error.message === 'string' ? error.message.toLowerCase() : ''
  return code === 4001 || code === 5000 || message.includes('user rejected') || message.includes('user denied')
}

const sameRequest = (left: Pick<EoaRequest, 'chainId' | 'from' | 'to' | 'data' | 'value'>, right: EoaRequest) =>
  left.chainId === right.chainId
  && getAddress(left.from) === getAddress(right.from)
  && getAddress(left.to) === getAddress(right.to)
  && left.data.toLowerCase() === right.data.toLowerCase()
  && left.value === right.value

export class EoaExecutionAdapter implements ExecutionTransportAdapter {
  readonly transport = 'eoa' as const

  constructor(
    private readonly client: EoaAdapterClient,
    private readonly executeMaterialized: EoaMaterializedExecutor,
    private readonly evcAddress: `0x${string}`,
  ) {}

  async dispatch(execution: ReviewedExecution, artifact: FinalizedRequestSet, callbacks: DispatchCallbacks, options: DispatchOptions = {}): Promise<DispatchResult> {
    if (artifact.transport !== 'eoa') throw new Error('EOA adapter received a Safe artifact')
    const requests = artifact.requests as readonly EoaRequest[]
    const requestOffset = options.requestOffset ?? 0
    if (options.requestIndexes && options.requestOffset !== undefined) {
      throw new Error('EOA dispatch cannot combine a request offset with explicit request indexes')
    }
    const requestIndexes = options.requestIndexes ?? requests.map((_request, index) => requestOffset + index)
    if (requestIndexes.length !== requests.length || new Set(requestIndexes).size !== requestIndexes.length) {
      throw new Error('EOA dispatch request indexes are incomplete or duplicated')
    }
    for (const [localIndex, request] of requests.entries()) {
      const reviewedRequest = execution.requestSet.requests[requestIndexes[localIndex]!]
      if (!reviewedRequest || !('requestId' in reviewedRequest) || reviewedRequest.requestId !== request.requestId) {
        throw new Error('EOA dispatch subset does not match the reviewed request vector')
      }
    }
    const evcAddress = getAddress(this.evcAddress)
    const sdkRequests = requests.map((request, requestIndex) => ({
      requestIndex,
      sourcePlanItemIndex: requestIndexes[requestIndex]!,
      kind: getAddress(request.to) === evcAddress ? 'evcBatch' as const : 'contractCall' as const,
      chainId: request.chainId,
      from: getAddress(request.from),
      to: getAddress(request.to),
      data: request.data,
      value: request.value,
    }))
    const finalized: FinalizedMaterializedExecution = Object.freeze({
      __materialized: true,
      __finalized: true,
      chainId: execution.requestSet.wallet.chainId,
      from: getAddress(execution.requestSet.wallet.account),
      evcAddress,
      requests: Object.freeze(sdkRequests),
      signatureSlots: Object.freeze([]),
      signatureValues: Object.freeze([]),
      safeCalls: Object.freeze(sdkRequests.map(({ to, data, value }) => Object.freeze({ to, data, value }))),
    })
    try {
      const result = await this.executeMaterialized(finalized, {
        onFinalized: async (execution) => {
          if (execution !== finalized) throw new Error('SDK replaced the finalized execution vector')
        },
        onBeforeStep: async (sdkRequest, stepIndex) => {
          const request = requests[stepIndex]
          if (!request || !sameRequest(sdkRequest, request)) {
            throw new Error('SDK dispatch request does not match the finalized reviewed execution')
          }
          await callbacks.assertWalletBinding()
          await callbacks.beforeDispatch(requestIndexes[stepIndex]!)
        },
        sendTransaction: async (sdkRequest) => {
          const request = requests[sdkRequest.requestIndex]
          if (!request || !sameRequest(sdkRequest, request)) {
            throw new Error('SDK wallet request does not match the finalized reviewed execution')
          }
          try {
            return await this.client.sendTransaction(request)
          }
          catch (error) {
            if (isUserRejected(error)) throw new ProvenPreDispatchCancellationError()
            throw new DispatchStatusUnknownError()
          }
        },
        onTransactionHash: async (_sdkRequest, stepIndex, hash) => {
          if (!isHash(hash)) throw new DispatchStatusUnknownError('Wallet returned no valid transaction hash')
          await callbacks.recordExternalId(requestIndexes[stepIndex]!, 'transaction-hash', hash)
          await callbacks.markConfirming(requestIndexes[stepIndex]!)
        },
        onAfterStep: async (_request, stepIndex, hash, receipt) => {
          if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
            throw new DispatchStatusUnknownError('Receipt belongs to another transaction')
          }
          await callbacks.afterConfirmed(requestIndexes[stepIndex]!)
        },
      })
      const lastReceipt = result.receipts[result.receipts.length - 1]
      return {
        transactionHashes: result.hashes,
        ...(lastReceipt ? { confirmedBlockNumber: lastReceipt.blockNumber } : {}),
      }
    }
    catch (error) {
      if (error instanceof MaterializedTransactionRevertedError) throw new AttemptRevertedError()
      throw error
    }
  }
}
