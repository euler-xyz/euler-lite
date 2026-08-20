import { getAddress, isHash, type Hash } from 'viem'
import type { AttemptRecord } from '../domain/attempt'
import type { SealedCeremony } from '../domain/ceremony'
import type { EoaRequest, SafeCall } from '../domain/template'
import type { CeremonyJournal } from '../persistence/journal'
import { eoaRequestSemanticDigest, type EoaReceipt, type EoaSubmittedTransaction } from '../adapters/eoa'
import { safeCallVectorDigest, type SafeCallsStatus } from '../adapters/safe'
import type { AttemptReconciler, ReconciliationResult } from './recovery'

export interface EoaReconciliationClient {
  getTransaction(hash: Hash): Promise<EoaSubmittedTransaction | undefined>
  getTransactionReceipt(hash: Hash): Promise<EoaReceipt | undefined>
  /** Bounded chain scan for the exact sender/nonce captured before dispatch. */
  findTransaction(input: { account: `0x${string}`, nonce: number, startBlock: bigint }): Promise<EoaSubmittedTransaction | undefined>
}

interface DispatchEvidence {
  stepIndex: number
  startBlock: bigint
  expectedNonce: number
  requestDigest: Hash
}

const dispatchEvidence = async (journal: CeremonyJournal, attemptId: string): Promise<DispatchEvidence[]> => {
  const events = await journal.listAttemptEvents(attemptId)
  return events.flatMap((event) => {
    if (event.to !== 'dispatching' || !event.detail || typeof event.detail !== 'object' || Array.isArray(event.detail)) return []
    const detail = event.detail as Record<string, unknown>
    if (typeof detail.stepIndex !== 'number' || typeof detail.startBlock !== 'bigint' || typeof detail.expectedNonce !== 'number' || typeof detail.requestDigest !== 'string') return []
    return [{ stepIndex: detail.stepIndex, startBlock: detail.startBlock, expectedNonce: detail.expectedNonce, requestDigest: detail.requestDigest as Hash }]
  })
}

const externalEvidence = async (journal: CeremonyJournal, attemptId: string) => {
  const events = await journal.listAttemptEvents(attemptId)
  return events.flatMap((event) => {
    if (event.to !== 'identified' || !event.detail || typeof event.detail !== 'object' || Array.isArray(event.detail)) return []
    const detail = event.detail as Record<string, unknown>
    if (!['transaction-hash', 'calls-id', 'execution-hash'].includes(detail.kind as string) || typeof detail.value !== 'string') return []
    return [{ kind: detail.kind as 'transaction-hash' | 'calls-id' | 'execution-hash', value: detail.value }]
  })
}

const submittedDigest = (transaction: EoaSubmittedTransaction, chainId: number) => {
  if (!transaction.to) throw new Error('Recovered transaction unexpectedly creates a contract')
  return eoaRequestSemanticDigest({
    chainId: transaction.chainId ?? chainId,
    from: getAddress(transaction.from),
    to: getAddress(transaction.to),
    data: transaction.input,
    value: transaction.value,
  })
}

export class EoaAttemptReconciler implements AttemptReconciler {
  constructor(private readonly journal: CeremonyJournal, private readonly client: EoaReconciliationClient) {}

  async reconcile(ceremony: SealedCeremony, attempt: AttemptRecord): Promise<ReconciliationResult> {
    if (ceremony.template.transport !== 'eoa') throw new Error('EOA reconciler received a Safe ceremony')
    const requests = ceremony.template.requests as readonly EoaRequest[]
    const artifacts = await externalEvidence(this.journal, attempt.attemptId)
    const knownHashes = artifacts.filter(artifact => artifact.kind === 'transaction-hash').map(artifact => artifact.value).filter(isHash)
    const dispatches = (await dispatchEvidence(this.journal, attempt.attemptId)).sort((left, right) => left.stepIndex - right.stepIndex)
    const recovered: Hash[] = []
    let confirmedPrerequisite = false

    for (const [requestIndex, request] of requests.entries()) {
      const evidence = dispatches[requestIndex]
      let transaction: EoaSubmittedTransaction | undefined
      const knownHash = knownHashes[requestIndex]
      if (knownHash) transaction = await this.client.getTransaction(knownHash)
      else if (evidence) transaction = await this.client.findTransaction({ account: request.from, nonce: evidence.expectedNonce, startBlock: evidence.startBlock })
      if (!transaction) {
        return { state: 'recovery-required', externalIds: recovered.map(value => ({ kind: 'transaction-hash' as const, value })), detail: `Request ${requestIndex + 1} remains ambiguous` }
      }
      if (transaction.nonce !== evidence?.expectedNonce || submittedDigest(transaction, request.chainId) !== eoaRequestSemanticDigest(request)) {
        return { state: 'recovery-required', externalIds: recovered.map(value => ({ kind: 'transaction-hash' as const, value })), detail: `Recovered request ${requestIndex + 1} does not match the reviewed artifact` }
      }
      recovered.push(transaction.hash)
      const receipt = await this.client.getTransactionReceipt(transaction.hash)
      if (!receipt || receipt.transactionHash.toLowerCase() !== transaction.hash.toLowerCase()) {
        return { state: 'recovery-required', externalIds: recovered.map(value => ({ kind: 'transaction-hash' as const, value })), detail: `Request ${requestIndex + 1} has no conclusive receipt` }
      }
      if (receipt.status === 'reverted') {
        return {
          state: confirmedPrerequisite ? 'cleanup-required' : 'reverted',
          externalIds: recovered.map(value => ({ kind: 'transaction-hash' as const, value })),
        }
      }
      if (request.phase === 'prerequisite') confirmedPrerequisite = true
    }
    return { state: 'succeeded', externalIds: recovered.map(value => ({ kind: 'transaction-hash' as const, value })) }
  }
}

export interface SafeReconciliationClient {
  getProposedCalls(callsId: string): Promise<readonly { to: `0x${string}`, data: `0x${string}`, value: bigint }[] | undefined>
  getCallsStatus(callsId: string): Promise<SafeCallsStatus | undefined>
  getExecutionReceipt(hash: Hash): Promise<{ status: 'success' | 'reverted' } | undefined>
}

export class SafeAttemptReconciler implements AttemptReconciler {
  constructor(private readonly journal: CeremonyJournal, private readonly client: SafeReconciliationClient) {}

  async reconcile(ceremony: SealedCeremony, attempt: AttemptRecord): Promise<ReconciliationResult> {
    if (ceremony.template.transport !== 'safe') throw new Error('Safe reconciler received an EOA ceremony')
    const calls = ceremony.template.requests as readonly SafeCall[]
    const artifacts = await externalEvidence(this.journal, attempt.attemptId)
    const callsId = [...artifacts].reverse().find(artifact => artifact.kind === 'calls-id')?.value
    if (!callsId) return { state: 'recovery-required', detail: 'The Safe calls ID is still unknown' }
    const proposed = await this.client.getProposedCalls(callsId)
    if (!proposed || safeCallVectorDigest(proposed) !== safeCallVectorDigest(calls)) {
      return { state: 'recovery-required', detail: 'The Safe proposal does not match the reviewed call vector' }
    }
    const status = await this.client.getCallsStatus(callsId)
    if (!status) return { state: 'recovery-required', detail: 'The Safe proposal status is unavailable' }
    const externalIds = [
      { kind: 'calls-id' as const, value: callsId },
      ...(status.executionHash ? [{ kind: 'execution-hash' as const, value: status.executionHash }] : []),
    ]
    if (status.status === 400) return { state: 'cancelled-proven', externalIds }
    if (!status.executionHash || !isHash(status.executionHash)) return { state: 'recovery-required', externalIds, detail: 'The Safe execution hash is unavailable' }
    const receipt = await this.client.getExecutionReceipt(status.executionHash)
    if (!receipt) return { state: 'recovery-required', externalIds, detail: 'The Safe execution receipt is unavailable' }
    return { state: receipt.status === 'success' ? 'succeeded' : 'reverted', externalIds }
  }
}
