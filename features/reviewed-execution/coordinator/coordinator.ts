import { getAddress, type Hash, type Hex } from 'viem'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'
import type { ReviewedExecution, EoaRequest, FinalizedRequestSet, SafeCall, SignatureSlot, WalletBinding } from '../domain/reviewed-execution'
import { assertReviewedExecutionIntegrity } from '../domain/seal'
import type { RefreshedPythValue } from '../materialization/pyth-refresh'
import type { DispatchCallbacks, ExecutionTransportAdapter, DispatchResult } from '../adapters/types'
import {
  AttemptRevertedError,
  DispatchFailedError,
  DispatchStatusUnknownError,
  ProvenOffchainCancellationError,
  ProvenPreDispatchCancellationError,
  ReviewedExecutionExpiredError,
  SignatureStatusUnknownError,
} from './errors'

export interface CollectedExecutionSignature {
  slotId: Hash
  signature: Hex
}

export interface CoordinatorDependencies {
  adapters: Readonly<Record<'eoa' | 'safe', ExecutionTransportAdapter>>
  readWalletBinding(): Promise<WalletBinding>
  revalidatePolicy(execution: ReviewedExecution): Promise<void>
  collectSignature(slot: SignatureSlot): Promise<Hex>
  refreshPyth(execution: ReviewedExecution): Promise<readonly RefreshedPythValue[]>
  finalize(
    execution: ReviewedExecution,
    signatures: readonly CollectedExecutionSignature[],
    pythValues: readonly RefreshedPythValue[],
  ): FinalizedRequestSet
  now?: () => number
}

export interface ReviewAcceptance {
  reviewId: Hash
  reviewDigest: Hash
}

export type SubmissionStatus = 'submitted' | 'rejected' | 'failed' | 'unknown'
export type SubmissionPhaseStatus = SubmissionStatus | 'not-submitted'

export interface SubmissionPhaseResult {
  status: SubmissionPhaseStatus
  requestIndexes: readonly number[]
  identifiers: readonly string[]
  message?: string
}

export interface MigrationSubmissionResult {
  submission: SubmissionPhaseResult
  revocation?: SubmissionPhaseResult
  authorizationMayRemain: boolean
  warning?: string
}

export interface SubmissionResult {
  status: SubmissionStatus
  transport: 'eoa' | 'safe'
  /** True only when the wallet conclusively cancelled without leaving confirmed on-chain state. */
  canRetry?: true
  dispatch?: DispatchResult
  message?: string
  migration?: MigrationSubmissionResult
}

export class SubmissionOutcomeError extends Error {
  constructor(readonly result: SubmissionResult) {
    super(submissionResultMessage(result))
    this.name = 'SubmissionOutcomeError'
  }
}

const activeReviewIds = new Set<Hash>()

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unknown transaction error'

const isUserRejected = (error: unknown) => {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? Number(error.code) : undefined
  const message = 'message' in error && typeof error.message === 'string' ? error.message.toLowerCase() : ''
  return code === 4001 || code === 5000 || message.includes('user rejected') || message.includes('user denied')
}

const statusForError = (error: unknown, crossedWalletBoundary: boolean): SubmissionStatus => {
  if (error instanceof ProvenPreDispatchCancellationError || error instanceof ProvenOffchainCancellationError || isUserRejected(error)) return 'rejected'
  if (error instanceof AttemptRevertedError || error instanceof DispatchFailedError) return 'failed'
  if (error instanceof DispatchStatusUnknownError || error instanceof SignatureStatusUnknownError || crossedWalletBoundary) return 'unknown'
  return 'failed'
}

const defaultStatusMessage = (status: SubmissionStatus) => {
  if (status === 'rejected') return 'The wallet request was rejected.'
  if (status === 'unknown') return 'Transaction status is unknown. Check your wallet or block explorer for the latest status.'
  if (status === 'failed') return 'Transaction submission failed.'
  return 'Transaction submitted.'
}

export const submissionResultMessage = (result: SubmissionResult) =>
  result.migration?.warning ?? result.message ?? defaultStatusMessage(result.status)

export const walletBindingDigest = (binding: WalletBinding): Hash => canonicalDigest('wallet-binding-v1', toCanonicalValue({
  ...binding,
  account: getAddress(binding.account),
  subAccounts: binding.subAccounts.map(value => getAddress(value)),
  ...(binding.safeAddress ? { safeAddress: getAddress(binding.safeAddress) } : {}),
}))

export const assertExactWalletBinding = (expected: WalletBinding, actual: WalletBinding) => {
  if (walletBindingDigest(expected) !== walletBindingDigest(actual)) {
    throw new Error('Wallet connection, session, classification, chain, account, or approval mode changed after review')
  }
}

const requestIdentifier = (
  requestIndex: number,
  externalIds: ReadonlyMap<number, readonly { kind: string, value: string }[]>,
) => externalIds.get(requestIndex)?.map(item => item.value) ?? []

const requestIdOf = (request: EoaRequest | SafeCall) => 'requestId' in request ? request.requestId : request.callId

const mergeDispatchResults = (first: DispatchResult | undefined, second: DispatchResult): DispatchResult => ({
  transactionHashes: [...(first?.transactionHashes ?? []), ...second.transactionHashes],
  ...(second.callsId ?? first?.callsId ? { callsId: second.callsId ?? first?.callsId } : {}),
  ...(second.executionHash ?? first?.executionHash ? { executionHash: second.executionHash ?? first?.executionHash } : {}),
  ...(second.atomic ?? first?.atomic ? { atomic: true } : {}),
})

interface CleanupFailure {
  status: SubmissionStatus
  message: string
}

const migrationAuthorizationFor = (execution: ReviewedExecution, effectId: Hash) => {
  const effect = execution.requestSet.effects.find(node => node.effectId === effectId)?.effect
  return effect?.kind === 'migration-authorization' ? effect : undefined
}

const migrationAuthorizationIdsFor = (
  execution: ReviewedExecution,
  request: EoaRequest | SafeCall,
  action: 'grant' | 'revoke',
) => request.effectIds.flatMap((effectId) => {
  const effect = migrationAuthorizationFor(execution, effectId)
  return effect?.action === action ? [effect.authorizationId] : []
})

const abortCleanupIndexesFor = (
  execution: ReviewedExecution,
  confirmedSteps: ReadonlySet<number>,
) => {
  const requests = execution.requestSet.requests
  const confirmedAuthorizationIds = new Set<Hash>()
  requests.forEach((request, index) => {
    if (!confirmedSteps.has(index)) return
    migrationAuthorizationIdsFor(execution, request, 'grant').forEach(id => confirmedAuthorizationIds.add(id))
  })
  return requests.flatMap((request, index) => request.phase === 'cleanup'
    && !confirmedSteps.has(index)
    && migrationAuthorizationIdsFor(execution, request, 'revoke').some(id => confirmedAuthorizationIds.has(id))
    ? [index]
    : [])
}

const migrationResultFor = ({
  execution,
  artifact,
  status,
  message,
  confirmedSteps,
  activeStepIndex,
  externalIds,
  cleanupFailure,
  compensationIndexes,
}: {
  execution: ReviewedExecution
  artifact?: FinalizedRequestSet
  status: SubmissionStatus
  message: string
  confirmedSteps: ReadonlySet<number>
  activeStepIndex?: number
  externalIds: ReadonlyMap<number, readonly { kind: string, value: string }[]>
  cleanupFailure?: CleanupFailure
  compensationIndexes: readonly number[]
}): MigrationSubmissionResult | undefined => {
  const hasMigration = execution.intents.some(intent => intent.kind === 'migration')
    || execution.requestSet.effects.some(node => node.effect.kind === 'migration-authorization')
  if (!hasMigration) return undefined
  const requests = artifact?.requests ?? execution.requestSet.requests
  const coreIndexes = requests.flatMap((request, index) => request.phase === 'core' ? [index] : [])
  const revocationIndexes = requests.flatMap((request, index) => request.phase === 'cleanup' ? [index] : [])
  const reportedRevocationIndexes = compensationIndexes.length ? compensationIndexes : revocationIndexes
  const successfulCore = coreIndexes.length > 0 && coreIndexes.every(index => confirmedSteps.has(index))
  const successfulRevocation = reportedRevocationIndexes.length > 0 && reportedRevocationIndexes.every(index => confirmedSteps.has(index))
  const safeHandedOff = execution.requestSet.transport === 'safe'
    && [...externalIds.values()].some(items => items.some(item => item.kind === 'calls-id'))
  const requestConfirmed = (index: number) => confirmedSteps.has(index) || (safeHandedOff && status === 'submitted')
  const activePhase = activeStepIndex === undefined ? undefined : requests[activeStepIndex]?.phase
  const identifiersFor = (indexes: readonly number[]) => indexes.flatMap(index => requestIdentifier(index, externalIds))

  const submissionStatus: SubmissionPhaseStatus = successfulCore || (safeHandedOff && status === 'submitted')
    ? 'submitted'
    : activePhase === 'core' || (execution.requestSet.transport === 'safe' && status !== 'submitted')
      ? status
      : 'not-submitted'
  const revocationStatus: SubmissionPhaseStatus | undefined = !reportedRevocationIndexes.length
    ? undefined
    : successfulRevocation
      ? 'submitted'
      : safeHandedOff
        ? status
        : cleanupFailure
          ? cleanupFailure.status
          : activePhase === 'cleanup'
            ? status
            : 'not-submitted'

  const grantAuthorizationIds = new Set(requests.flatMap(request => migrationAuthorizationIdsFor(execution, request, 'grant')))
  const revokeAuthorizationIds = new Set(requests.flatMap(request => migrationAuthorizationIdsFor(execution, request, 'revoke')))
  const confirmedGrantAuthorizationIds = new Set(requests.flatMap((request, index) => requestConfirmed(index)
    ? migrationAuthorizationIdsFor(execution, request, 'grant')
    : []))
  const confirmedRevokeAuthorizationIds = new Set(requests.flatMap((request, index) => requestConfirmed(index)
    ? migrationAuthorizationIdsFor(execution, request, 'revoke')
    : []))
  // A reviewed revocation without a reviewed grant means preparation observed
  // an authorization that was already active before this operation.
  const unrevokedPreexistingAuthorization = [...revokeAuthorizationIds].some(id =>
    !grantAuthorizationIds.has(id) && !confirmedRevokeAuthorizationIds.has(id))
  const unrevokedConfirmedGrant = [...confirmedGrantAuthorizationIds].some(id => !confirmedRevokeAuthorizationIds.has(id))
  const activeRequest = activeStepIndex === undefined ? undefined : requests[activeStepIndex]
  const unknownGrantHandoff = status === 'unknown'
    && !!activeRequest
    && migrationAuthorizationIdsFor(execution, activeRequest, 'grant').length > 0
  const authorizationMayRemain = unrevokedConfirmedGrant || unrevokedPreexistingAuthorization || unknownGrantHandoff

  let warning: string | undefined
  if (authorizationMayRemain && successfulCore && revocationStatus && revocationStatus !== 'submitted') {
    warning = `Migration submitted, but authorization revocation ${revocationStatus === 'not-submitted' ? 'was not submitted' : `status is ${revocationStatus}`}. Authorization may remain active.`
  }
  else if (authorizationMayRemain) {
    warning = `${submissionStatus === 'unknown' ? 'Migration status is unknown' : 'Migration was not submitted'}. Authorization may remain active.`
  }

  return {
    submission: {
      status: submissionStatus,
      requestIndexes: coreIndexes,
      identifiers: identifiersFor(coreIndexes),
      ...(submissionStatus === 'submitted' ? {} : { message }),
    },
    ...(revocationStatus === undefined
      ? {}
      : {
          revocation: {
            status: revocationStatus,
            requestIndexes: reportedRevocationIndexes,
            identifiers: identifiersFor(reportedRevocationIndexes),
            ...(revocationStatus === 'submitted' ? {} : { message: cleanupFailure?.message ?? message }),
          },
        }),
    authorizationMayRemain,
    ...(warning ? { warning } : {}),
  }
}

export class ReviewedExecutionCoordinator {
  constructor(private readonly dependencySource: CoordinatorDependencies | (() => Promise<CoordinatorDependencies>)) {}

  execute(execution: ReviewedExecution, acceptance: ReviewAcceptance): Promise<SubmissionResult> {
    const transport = execution.requestSet.transport
    if (activeReviewIds.has(execution.reviewId)) {
      return Promise.resolve({ status: 'failed', transport, message: 'This reviewed transaction is already being submitted.' })
    }
    // Synchronous and process-local: the first caller owns this reviewed
    // execution before even its wallet-specific runtime can yield.
    activeReviewIds.add(execution.reviewId)
    return this.executeActive(execution, acceptance).finally(() => {
      activeReviewIds.delete(execution.reviewId)
    })
  }

  private async executeActive(execution: ReviewedExecution, acceptance: ReviewAcceptance): Promise<SubmissionResult> {
    const transport = execution.requestSet.transport
    let artifact: FinalizedRequestSet | undefined
    let activeStepIndex: number | undefined
    let compensationStepIndex: number | undefined
    let compensating = false
    let cleanupFailure: CleanupFailure | undefined
    let compensationIndexes: readonly number[] = []
    let dependencies: CoordinatorDependencies | undefined
    let adapter: ExecutionTransportAdapter | undefined
    let callbacks: DispatchCallbacks | undefined
    let dispatch: DispatchResult | undefined
    let refreshedPythValues: readonly RefreshedPythValue[] = []
    const confirmedSteps = new Set<number>()
    const externalIds = new Map<number, { kind: string, value: string }[]>()
    const buildResult = (status: SubmissionStatus, error?: unknown, dispatch?: DispatchResult): SubmissionResult => {
      const message = error ? errorMessage(error) : defaultStatusMessage(status)
      const migration = migrationResultFor({ execution, artifact, status, message, confirmedSteps, activeStepIndex, externalIds, cleanupFailure, compensationIndexes })
      const effectiveStatus = migration?.submission.status === 'submitted' ? 'submitted' : status
      const canRetry = effectiveStatus === 'rejected'
        && confirmedSteps.size === 0
        && (error instanceof ProvenOffchainCancellationError
          || (error instanceof ProvenPreDispatchCancellationError && externalIds.size === 0))
      return {
        status: effectiveStatus,
        transport,
        ...(canRetry ? { canRetry: true as const } : {}),
        ...(dispatch ? { dispatch } : {}),
        ...(effectiveStatus === 'submitted' && !migration?.warning ? {} : { message }),
        ...(migration ? { migration } : {}),
      }
    }

    try {
      dependencies = typeof this.dependencySource === 'function'
        ? await this.dependencySource()
        : this.dependencySource
      if (dependencies.adapters.eoa.transport !== 'eoa' || dependencies.adapters.safe.transport !== 'safe') {
        throw new Error('Execution adapters are registered under the wrong transport')
      }
      const now = dependencies.now ?? Date.now
      assertReviewedExecutionIntegrity(execution)
      if (acceptance.reviewId !== execution.reviewId || acceptance.reviewDigest !== execution.reviewDigest) {
        throw new Error('Review acceptance does not match the reviewed execution')
      }

      const assertExplicitDeadlines = () => {
        const nowSeconds = Math.floor(now() / 1000)
        if (execution.requestSet.constraints.some(constraint => constraint.kind === 'deadline' && constraint.timestamp <= nowSeconds)) {
          throw new ReviewedExecutionExpiredError('A reviewed operation expired')
        }
        if (execution.requestSet.signatureSlots.some(slot => slot.validUntil !== undefined && slot.validUntil <= nowSeconds)) {
          throw new ReviewedExecutionExpiredError('A reviewed signature request expired')
        }
      }
      const assertWallet = async () => {
        const actual = await dependencies.readWalletBinding()
        assertExactWalletBinding(execution.requestSet.wallet, actual)
      }
      const assertPolicyAndWallet = async () => {
        assertExplicitDeadlines()
        await assertWallet()
        await dependencies.revalidatePolicy(execution)
        await assertWallet()
        assertExplicitDeadlines()
      }
      const assertCleanupPolicyAndWallet = async () => {
        await assertWallet()
        await dependencies!.revalidatePolicy(execution)
        await assertWallet()
      }
      const assertRefreshedPythFreshness = (stepIndex: number) => {
        const request = execution.requestSet.requests[stepIndex]
        if (!request) throw new Error('Pyth freshness check points to a missing reviewed request')
        const slots = transport === 'safe'
          ? execution.requestSet.pythRefreshSlots
          : execution.requestSet.pythRefreshSlots.filter(slot => slot.insertionPoint.requestId === requestIdOf(request))
        if (!slots.length) return
        const valuesBySlot = new Map(refreshedPythValues.map(value => [value.slotId, value]))
        const nowSeconds = Math.floor(now() / 1000)
        for (const slot of slots) {
          const value = valuesBySlot.get(slot.slotId)
          if (!value || value.publishTimes.length !== slot.requiredFeedIds.length || !value.publishTimes.length) {
            throw new Error('Refreshed Pyth publish-time evidence is incomplete before wallet handoff')
          }
          for (const publishTime of value.publishTimes) {
            if (!Number.isSafeInteger(publishTime) || publishTime > nowSeconds) {
              throw new Error('Refreshed Pyth publish time is invalid before wallet handoff')
            }
            if (nowSeconds - publishTime > slot.freshnessPolicy.maximumAgeSeconds) {
              throw new Error('Refreshed Pyth payload expired before wallet handoff')
            }
            if (slot.freshnessPolicy.minimumPublishTime !== undefined && publishTime < slot.freshnessPolicy.minimumPublishTime) {
              throw new Error('Refreshed Pyth payload predates the reviewed freshness floor')
            }
          }
        }
      }

      await assertPolicyAndWallet()
      const signatures: CollectedExecutionSignature[] = []
      for (const slot of execution.requestSet.signatureSlots) {
        await assertPolicyAndWallet()
        let signature: Hex
        try {
          signature = await dependencies.collectSignature(slot)
        }
        catch (error) {
          if (isUserRejected(error)) throw new ProvenPreDispatchCancellationError('Signature request was rejected')
          throw new SignatureStatusUnknownError(errorMessage(error))
        }
        await assertWallet()
        signatures.push({ slotId: slot.slotId, signature })
      }

      adapter = dependencies.adapters[transport]
      callbacks = {
        assertWalletBinding: assertWallet,
        beforeDispatch: async (stepIndex) => {
          if (compensating) {
            compensationStepIndex = stepIndex
            await assertCleanupPolicyAndWallet()
            return
          }
          activeStepIndex = stepIndex
          await assertPolicyAndWallet()
          assertRefreshedPythFreshness(stepIndex)
        },
        recordExternalId: async (stepIndex, kind, value) => {
          const items = externalIds.get(stepIndex) ?? []
          items.push({ kind, value })
          externalIds.set(stepIndex, items)
        },
        markConfirming: async (stepIndex) => {
          if (compensating) compensationStepIndex = stepIndex
          else activeStepIndex = stepIndex
        },
        afterConfirmed: async (stepIndex) => {
          confirmedSteps.add(stepIndex)
        },
      }

      let pythRequestIndex = 0
      if (transport === 'eoa' && execution.requestSet.pythRefreshSlots.length) {
        const pythRequestIds = new Set(execution.requestSet.pythRefreshSlots.map(slot => slot.insertionPoint.requestId))
        if (pythRequestIds.size !== 1) throw new Error('EOA execution contains more than one Pyth-bearing request')
        pythRequestIndex = execution.requestSet.requests.findIndex(request => pythRequestIds.has(requestIdOf(request)))
        if (pythRequestIndex < 0) throw new Error('Pyth refresh slot points to a missing EOA request')
        const prefixIds = new Set(execution.requestSet.requests.slice(0, pythRequestIndex).map(requestIdOf))
        if (execution.requestSet.signatureSlots.some(slot => slot.insertionPoints.some(point => prefixIds.has(point.requestId)))) {
          throw new Error('A dynamic signature slot precedes the Pyth execution boundary')
        }
        if (pythRequestIndex > 0) {
          const prefixArtifact: FinalizedRequestSet = {
            __finalizedRequestSet: true,
            reviewId: execution.reviewId,
            requestDigest: execution.requestDigest,
            transport: 'eoa',
            requests: execution.requestSet.requests.slice(0, pythRequestIndex),
            signatureValues: [],
            pythValues: [],
          }
          dispatch = await adapter.dispatch(execution, prefixArtifact, callbacks)
        }
      }

      const isJitEoaPyth = transport === 'eoa' && execution.requestSet.pythRefreshSlots.length > 0
      if (isJitEoaPyth) activeStepIndex = pythRequestIndex
      await assertPolicyAndWallet()
      refreshedPythValues = await dependencies.refreshPyth(execution)
      await assertPolicyAndWallet()
      artifact = dependencies.finalize(execution, signatures, refreshedPythValues)
      if (artifact.reviewId !== execution.reviewId || artifact.requestDigest !== execution.requestDigest || artifact.transport !== transport) {
        throw new Error('Finalized artifact does not match the reviewed execution')
      }
      await assertPolicyAndWallet()

      const dispatchArtifact = transport === 'eoa' && pythRequestIndex > 0
        ? { ...artifact, requests: artifact.requests.slice(pythRequestIndex) }
        : artifact
      const finalizedDispatch = await adapter.dispatch(execution, dispatchArtifact, callbacks, {
        requestOffset: pythRequestIndex,
      })
      dispatch = mergeDispatchResults(dispatch, finalizedDispatch)
      return buildResult('submitted', undefined, dispatch)
    }
    catch (error) {
      const crossedWalletBoundary = activeStepIndex !== undefined
        && !confirmedSteps.has(activeStepIndex)
        && (externalIds.get(activeStepIndex)?.length ?? 0) > 0
      const primaryStatus = statusForError(error, crossedWalletBoundary)
      const primaryActiveStepIndex = activeStepIndex
      const activePhase = activeStepIndex === undefined ? undefined : execution.requestSet.requests[activeStepIndex]?.phase
      compensationIndexes = transport === 'eoa' && primaryStatus !== 'unknown' && activePhase !== 'cleanup'
        ? abortCleanupIndexesFor(execution, confirmedSteps)
        : []

      if (compensationIndexes.length && adapter?.transport === 'eoa' && callbacks) {
        const requests = (artifact?.requests ?? execution.requestSet.requests) as readonly EoaRequest[]
        const cleanupArtifact: FinalizedRequestSet = {
          __finalizedRequestSet: true,
          reviewId: execution.reviewId,
          requestDigest: execution.requestDigest,
          transport: 'eoa',
          requests: compensationIndexes.map((index) => {
            const request = requests[index]
            if (!request || request.phase !== 'cleanup') throw new Error('Reviewed migration cleanup request is missing')
            return request
          }),
          signatureValues: artifact?.signatureValues ?? [],
          pythValues: artifact?.pythValues ?? [],
        }
        compensating = true
        try {
          const cleanupDispatch = await adapter.dispatch(execution, cleanupArtifact, callbacks, { requestIndexes: compensationIndexes })
          dispatch = mergeDispatchResults(dispatch, cleanupDispatch)
        }
        catch (cleanupError) {
          const cleanupCrossedWalletBoundary = compensationStepIndex !== undefined
            && !confirmedSteps.has(compensationStepIndex)
            && (externalIds.get(compensationStepIndex)?.length ?? 0) > 0
          cleanupFailure = {
            status: statusForError(cleanupError, cleanupCrossedWalletBoundary),
            message: errorMessage(cleanupError),
          }
        }
        finally {
          compensating = false
          activeStepIndex = primaryActiveStepIndex
        }
      }
      return buildResult(primaryStatus, error, dispatch)
    }
  }
}
