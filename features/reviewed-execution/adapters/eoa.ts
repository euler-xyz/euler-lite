import { getAddress, isHash, type Hash, type Hex } from 'viem'
import {
  MaterializedTransactionRevertedError,
  type ExecuteMaterializedOptions,
  type FinalizedMaterializedExecution,
  type MaterializedExecutionResult,
} from '@eulerxyz/euler-v2-sdk'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'
import type { EoaRequest, FinalizedRequestSet, ReviewedExecution } from '../domain/reviewed-execution'
import { AttemptRevertedError, DispatchStatusUnknownError, ProvenPreDispatchCancellationError } from '../coordinator/errors'
import type { ExecutionTransportAdapter, DispatchCallbacks, DispatchResult } from './types'

export interface EoaSubmittedTransaction {
  hash: Hash
  from: `0x${string}`
  to: `0x${string}` | null
  input: Hex
  value: bigint
  chainId?: number
  nonce: number
}

export interface EoaReceipt {
  transactionHash: Hash
  status: 'success' | 'reverted'
}

export interface EoaAdapterClient {
  getBlockNumber(): Promise<bigint>
  getTransactionCount(account: `0x${string}`, blockTag: 'pending'): Promise<number>
  sendTransaction(request: EoaRequest): Promise<Hash>
  getTransaction(hash: Hash): Promise<EoaSubmittedTransaction>
  waitForTransactionReceipt(hash: Hash): Promise<EoaReceipt>
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

export const eoaRequestSemanticDigest = (request: Pick<EoaRequest, 'chainId' | 'from' | 'to' | 'data' | 'value'>): Hash =>
  canonicalDigest('eoa-request-semantics-v1', toCanonicalValue({
    chainId: request.chainId,
    from: getAddress(request.from),
    to: getAddress(request.to),
    data: request.data.toLowerCase(),
    value: request.value,
  }))

const submittedSemanticDigest = (transaction: EoaSubmittedTransaction, fallbackChainId: number): Hash => {
  if (!transaction.to) throw new Error('Submitted transaction unexpectedly creates a contract')
  return eoaRequestSemanticDigest({
    chainId: transaction.chainId ?? fallbackChainId,
    from: getAddress(transaction.from),
    to: getAddress(transaction.to),
    data: transaction.input,
    value: transaction.value,
  })
}

export class EoaExecutionAdapter implements ExecutionTransportAdapter {
  readonly transport = 'eoa' as const

  constructor(
    private readonly client: EoaAdapterClient,
    private readonly executeMaterialized: EoaMaterializedExecutor,
    private readonly evcAddress: `0x${string}`,
  ) {}

  async dispatch(execution: ReviewedExecution, artifact: FinalizedRequestSet, callbacks: DispatchCallbacks): Promise<DispatchResult> {
    if (artifact.transport !== 'eoa') throw new Error('EOA adapter received a Safe artifact')
    const requests = artifact.requests as readonly EoaRequest[]
    const evcAddress = getAddress(this.evcAddress)
    const sdkRequests = requests.map((request, requestIndex) => ({
      requestIndex,
      sourcePlanItemIndex: requestIndex,
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
    const dispatchMetadata = new Map<number, { expectedNonce: number, request: EoaRequest }>()

    try {
      const result = await this.executeMaterialized(finalized, {
        onFinalized: async (execution) => {
          if (execution !== finalized) throw new Error('SDK replaced the finalized execution vector')
          await callbacks.assertReservation()
        },
        onBeforeStep: async (sdkRequest, stepIndex) => {
          const request = requests[stepIndex]
          if (!request || eoaRequestSemanticDigest(sdkRequest) !== eoaRequestSemanticDigest(request)) {
            throw new Error('SDK dispatch request does not match the finalized reviewed execution')
          }
          await callbacks.assertWalletBinding()
          await callbacks.assertReservation()
          const [startBlock, expectedNonce] = await Promise.all([
            this.client.getBlockNumber(),
            this.client.getTransactionCount(request.from, 'pending'),
          ])
          await callbacks.assertWalletBinding()
          dispatchMetadata.set(stepIndex, { expectedNonce, request })
          await callbacks.beforeDispatch(stepIndex, { startBlock, expectedNonce, requestDigest: eoaRequestSemanticDigest(request) })
        },
        sendTransaction: async (sdkRequest) => {
          const request = requests[sdkRequest.requestIndex]
          if (!request || eoaRequestSemanticDigest(sdkRequest) !== eoaRequestSemanticDigest(request)) {
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
          await callbacks.recordExternalId('transaction-hash', hash)
          const metadata = dispatchMetadata.get(stepIndex)
          if (!metadata) throw new DispatchStatusUnknownError('Dispatch metadata is unavailable')
          const submitted = await this.client.getTransaction(hash).catch(() => undefined)
          if (!submitted) throw new DispatchStatusUnknownError('Submitted transaction cannot yet be verified')
          if (submitted.nonce !== metadata.expectedNonce
            || submittedSemanticDigest(submitted, metadata.request.chainId) !== eoaRequestSemanticDigest(metadata.request)) {
            throw new DispatchStatusUnknownError('Submitted transaction does not match the reviewed request')
          }
          await callbacks.assertWalletBinding()
          await callbacks.markConfirming(stepIndex)
        },
        onAfterStep: async (_request, stepIndex, hash, receipt) => {
          if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
            throw new DispatchStatusUnknownError('Receipt belongs to another transaction')
          }
          await callbacks.afterConfirmed(stepIndex)
        },
      })
      return { transactionHashes: result.hashes }
    }
    catch (error) {
      if (error instanceof MaterializedTransactionRevertedError) throw new AttemptRevertedError()
      throw error
    }
  }
}
