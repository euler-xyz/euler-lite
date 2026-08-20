import { getAddress, type Hash, type Hex } from 'viem'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'
import type { AttemptRecord, AttemptState } from '../domain/attempt'
import type { SealedCeremony } from '../domain/ceremony'
import type { FinalizedArtifact, SignatureSlot, WalletBinding } from '../domain/template'
import { assertCeremonyIntegrity } from '../domain/seal'
import type { RefreshedPythValue } from '../materialization/pyth-refresh'
import type { CeremonyJournal, ReservationExpectation } from '../persistence/journal'
import { requestVectorDigest } from '../persistence/journal'
import { walletLaneKey, withWalletLaneLock } from '../persistence/locks'
import type { CeremonyTransportAdapter, DispatchCallbacks, DispatchResult } from '../adapters/types'
import {
  AttemptExpiredError,
  AttemptRevertedError,
  CleanupRequiredError,
  DispatchStatusUnknownError,
  ProvenOffchainCancellationError,
  ProvenPreDispatchCancellationError,
  SignatureStatusUnknownError,
} from './errors'
import type { CeremonyEmergencySwitch } from './emergency-switch'

export interface CollectedCeremonySignature {
  slotId: Hash
  signature: Hex
}

export interface CoordinatorDependencies {
  journal: CeremonyJournal
  emergencySwitch: CeremonyEmergencySwitch
  adapters: Readonly<Record<'eoa' | 'safe', CeremonyTransportAdapter>>
  readWalletBinding(): Promise<WalletBinding>
  revalidatePolicy(ceremony: SealedCeremony): Promise<void>
  collectSignature(slot: SignatureSlot): Promise<Hex>
  refreshPyth(ceremony: SealedCeremony): Promise<readonly RefreshedPythValue[]>
  finalize(
    ceremony: SealedCeremony,
    signatures: readonly CollectedCeremonySignature[],
    pythValues: readonly RefreshedPythValue[],
  ): Promise<FinalizedArtifact> | FinalizedArtifact
  now?: () => number
  createId?: (kind: 'attempt' | 'reservation') => string
  withLaneLock?: <T>(laneKey: string, work: () => Promise<T>) => Promise<T>
}

export interface CeremonyAcceptance {
  ceremonyId: Hash
  consentDigest: Hash
}

export interface CeremonyExecutionResult {
  attempt: AttemptRecord
  dispatch: DispatchResult
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unknown transaction error'

export const walletBindingDigest = (binding: WalletBinding): Hash => canonicalDigest('wallet-binding-v1', toCanonicalValue({
  ...binding,
  account: getAddress(binding.account),
  subAccounts: binding.subAccounts.map(getAddress),
  ...(binding.safeAddress ? { safeAddress: getAddress(binding.safeAddress) } : {}),
}))

export const assertExactWalletBinding = (expected: WalletBinding, actual: WalletBinding) => {
  if (walletBindingDigest(expected) !== walletBindingDigest(actual)) {
    throw new Error('Wallet connection, session, classification, chain, account, or approval mode changed after review')
  }
}

const defaultId = (kind: 'attempt' | 'reservation') => {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (!uuid) throw new Error('Secure random IDs are unavailable')
  return `${kind}:${uuid}`
}

const isAfterExternalBoundary = (attempt: AttemptRecord, ceremony?: SealedCeremony) =>
  attempt.state === 'signing'
  || (attempt.state === 'finalized' && Boolean(ceremony?.template.signatureSlots.length))
  || attempt.state === 'dispatching'
  || attempt.state === 'identified'
  || attempt.state === 'confirming'
  || attempt.externalIds.length > 0

export class TransactionCeremonyCoordinator {
  private readonly now: () => number
  private readonly createId: NonNullable<CoordinatorDependencies['createId']>
  private readonly withLaneLock: NonNullable<CoordinatorDependencies['withLaneLock']>

  constructor(private readonly dependencies: CoordinatorDependencies) {
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? defaultId
    this.withLaneLock = dependencies.withLaneLock ?? withWalletLaneLock
    if (dependencies.adapters.eoa.transport !== 'eoa' || dependencies.adapters.safe.transport !== 'safe') {
      throw new Error('Ceremony adapters are registered under the wrong transport')
    }
  }

  async execute(ceremony: SealedCeremony, acceptance: CeremonyAcceptance): Promise<CeremonyExecutionResult> {
    assertCeremonyIntegrity(ceremony)
    if (this.dependencies.emergencySwitch.isNewCeremonyDisabled()) {
      throw new Error(this.dependencies.emergencySwitch.reason() ?? 'New transaction ceremonies are disabled')
    }
    if (acceptance.ceremonyId !== ceremony.ceremonyId || acceptance.consentDigest !== ceremony.consentDigest) {
      throw new Error('Review acceptance does not match the sealed ceremony')
    }
    const laneKey = walletLaneKey(ceremony.template.wallet.account, ceremony.template.wallet.chainId)
    return this.withLaneLock(laneKey, async () => {
      // The switch governs only creation. Once reservation exists, recovery and
      // completion remain available even if the switch changes.
      if (this.dependencies.emergencySwitch.isNewCeremonyDisabled()) {
        throw new Error(this.dependencies.emergencySwitch.reason() ?? 'New transaction ceremonies are disabled')
      }
      await this.dependencies.journal.putCeremony(ceremony)
      const attemptId = this.createId('attempt')
      const reservationId = this.createId('reservation')
      const requestDigest = requestVectorDigest(ceremony)
      const attempt = await this.dependencies.journal.reserveAttempt({
        ceremony,
        attemptId,
        reservationId,
        laneKey,
        requestVectorDigest: requestDigest,
        now: this.now(),
      })
      return this.continueReserved(ceremony, attempt, requestDigest)
    })
  }

  async resume(attemptId: string): Promise<CeremonyExecutionResult> {
    const attempt = await this.dependencies.journal.getAttempt(attemptId)
    if (!attempt) throw new Error('Attempt is missing')
    const ceremony = await this.dependencies.journal.getCeremony(attempt.ceremonyId)
    if (!ceremony || ceremony.templateDigest !== attempt.templateDigest) throw new Error('Attempt ceremony is missing or corrupt')
    assertCeremonyIntegrity(ceremony)
    if (isAfterExternalBoundary(attempt, ceremony)) throw new Error('Attempts that reached a wallet prompt must be reconciled, never retried')
    if (!['reserved', 'revalidating', 'finalized'].includes(attempt.state)) throw new Error(`Attempt ${attempt.state} cannot be resumed`)
    return this.withLaneLock(attempt.laneKey, () => this.continueReserved(ceremony, attempt, requestVectorDigest(ceremony)))
  }

  private async continueReserved(ceremony: SealedCeremony, initialAttempt: AttemptRecord, requestDigest: Hash): Promise<CeremonyExecutionResult> {
    let attempt = initialAttempt
    const expectation = (): ReservationExpectation => ({
      attemptId: attempt.attemptId,
      reservationId: attempt.reservationId,
      ceremonyId: ceremony.ceremonyId,
      templateDigest: ceremony.templateDigest,
      account: ceremony.template.wallet.account,
      chainId: ceremony.template.wallet.chainId,
      laneKey: attempt.laneKey,
      requestVectorDigest: requestDigest,
      version: attempt.version,
      fence: attempt.fence,
    })
    const verify = async () => {
      attempt = await this.dependencies.journal.verifyReservation(expectation())
    }
    const assertFresh = () => {
      const expiresAt = ceremony.validity.expiresAt
      if (expiresAt !== undefined && expiresAt <= this.now()) throw new AttemptExpiredError()
    }
    const transition = async (to: AttemptState, options?: { stepIndex?: number, error?: string, detail?: Parameters<CeremonyJournal['transitionAttempt']>[0]['detail'] }) => {
      attempt = await this.dependencies.journal.transitionAttempt({
        expected: { attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence }, to, now: this.now(), ...options,
      })
    }
    const assertWallet = async () => {
      assertFresh()
      const actual = await this.dependencies.readWalletBinding()
      assertFresh()
      assertExactWalletBinding(ceremony.template.wallet, actual)
      await verify()
      assertFresh()
    }
    const assertPolicyAndWallet = async () => {
      await assertWallet()
      await this.dependencies.revalidatePolicy(ceremony)
      await assertWallet()
    }
    const recordExternal = async (kind: 'transaction-hash' | 'calls-id' | 'execution-hash', value: string) => {
      attempt = await this.dependencies.journal.recordExternalArtifact(
        { attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence }, { kind, value, observedAt: this.now() },
      )
    }
    await verify()
    try {
      return await this.runReserved({ ceremony, getAttempt: () => attempt, verify, transition, assertWallet, assertPolicyAndWallet, recordExternal })
    }
    catch (error) {
      const current = await this.dependencies.journal.getAttempt(attempt.attemptId)
      if (current) attempt = current
      const terminal = await this.classifyFailure(ceremony, attempt, error, transition)
      if (terminal === 'safely-rejected-before-dispatch' || terminal === 'reverted' || terminal === 'cancelled-proven' || terminal === 'expired') {
        await this.dependencies.journal.releaseLane({ attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence }, this.now())
      }
      throw error
    }
  }

  private async runReserved({
    ceremony,
    getAttempt,
    verify,
    transition,
    assertWallet,
    assertPolicyAndWallet,
    recordExternal,
  }: {
    ceremony: SealedCeremony
    getAttempt: () => AttemptRecord
    verify: () => Promise<void>
    transition: (to: AttemptState, options?: { stepIndex?: number, error?: string, detail?: Parameters<CeremonyJournal['transitionAttempt']>[0]['detail'] }) => Promise<void>
    assertWallet: () => Promise<void>
    assertPolicyAndWallet: () => Promise<void>
    recordExternal: (kind: 'transaction-hash' | 'calls-id' | 'execution-hash', value: string) => Promise<void>
  }): Promise<CeremonyExecutionResult> {
    const expiresAt = ceremony.validity.expiresAt
    if (expiresAt !== undefined && expiresAt <= this.now()) throw new AttemptExpiredError()
    await transition('revalidating')
    await assertPolicyAndWallet()

    const signatures: CollectedCeremonySignature[] = []
    for (const [slotIndex, slot] of ceremony.template.signatureSlots.entries()) {
      if (slot.validUntil !== undefined && slot.validUntil <= Math.floor(this.now() / 1000)) throw new AttemptExpiredError('A reviewed signature request expired')
      await transition('signing', { stepIndex: slotIndex, detail: { slotId: slot.slotId } })
      await assertPolicyAndWallet()
      let signature: Hex
      try {
        signature = await this.dependencies.collectSignature(slot)
      }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && (Number(error.code) === 4001 || Number(error.code) === 5000)) {
          throw new ProvenPreDispatchCancellationError('Signature request was rejected')
        }
        throw new SignatureStatusUnknownError(errorMessage(error))
      }
      await assertWallet()
      signatures.push({ slotId: slot.slotId, signature })
    }

    // Refresh is deliberately after durable reservation and as late as possible.
    await assertPolicyAndWallet()
    const pythValues = await this.dependencies.refreshPyth(ceremony)
    await assertPolicyAndWallet()
    const artifact = await this.dependencies.finalize(ceremony, signatures, pythValues)
    if (artifact.ceremonyId !== ceremony.ceremonyId || artifact.templateDigest !== ceremony.templateDigest || artifact.transport !== ceremony.template.transport) {
      throw new Error('Finalized artifact does not match the sealed ceremony')
    }
    await transition('finalized')
    await verify()

    const cleanupByRequestIndex = new Map<number, Hash[]>()
    const cleanupObligationIds: Hash[] = []
    for (const [requestIndex, request] of artifact.requests.entries()) {
      if (request.phase !== 'cleanup') continue
      const ids: Hash[] = []
      for (const effectId of request.effectIds) {
        const obligationId = canonicalDigest('cleanup-obligation-v1', toCanonicalValue({
          attemptId: getAttempt().attemptId,
          requestIndex,
          effectId,
          request,
        }))
        await this.dependencies.journal.putCleanupObligation(
          { attemptId: getAttempt().attemptId, version: getAttempt().version, fence: getAttempt().fence },
          {
            schemaVersion: 1,
            obligationId,
            attemptId: getAttempt().attemptId,
            effectId,
            status: 'pending',
            request: toCanonicalValue(request),
            createdAt: this.now(),
            updatedAt: this.now(),
          },
        )
        ids.push(obligationId)
        cleanupObligationIds.push(obligationId)
      }
      cleanupByRequestIndex.set(requestIndex, ids)
    }
    await verify()

    let confirmedPrerequisite = false
    const markCleanupCompleted = async (obligationId: Hash) => {
      const current = getAttempt()
      await this.dependencies.journal.updateCleanupObligation(
        { attemptId: current.attemptId, version: current.version, fence: current.fence },
        obligationId,
        'completed',
        this.now(),
      )
    }

    const callbacks: DispatchCallbacks = {
      getAttempt,
      assertReservation: verify,
      assertWalletBinding: assertWallet,
      beforeDispatch: async (stepIndex, detail) => {
        await assertPolicyAndWallet()
        const storedDetail = detail && typeof detail === 'object' && !Array.isArray(detail)
          ? { stepIndex, ...detail }
          : { stepIndex, ...(detail === undefined ? {} : { adapterDetail: detail }) }
        await transition('dispatching', { stepIndex, detail: storedDetail })
        await verify()
      },
      recordExternalId: async (kind, value) => {
        await recordExternal(kind, value)
      },
      markConfirming: async (stepIndex) => {
        await transition('confirming', { stepIndex })
      },
      afterConfirmed: async (stepIndex) => {
        const request = artifact.requests[stepIndex]
        if (!request) throw new Error('Adapter confirmed an unknown request')
        if (request.phase === 'prerequisite') confirmedPrerequisite = true
        for (const obligationId of cleanupByRequestIndex.get(stepIndex) ?? []) {
          await markCleanupCompleted(obligationId)
        }
      },
    }
    const adapter = this.dependencies.adapters[ceremony.template.transport]
    let dispatch: DispatchResult
    try {
      dispatch = await adapter.dispatch(ceremony, artifact, callbacks)
    }
    catch (error) {
      if (confirmedPrerequisite && !(error instanceof DispatchStatusUnknownError)) {
        throw new CleanupRequiredError(errorMessage(error))
      }
      throw error
    }
    // A Safe proposal confirms its whole call vector at once. Completing all
    // obligations here also covers transports that report only bundle-level
    // confirmation rather than individual cleanup call indexes.
    for (const obligationId of cleanupObligationIds) await markCleanupCompleted(obligationId)
    await transition('succeeded')
    const succeeded = getAttempt()
    await this.dependencies.journal.releaseLane({ attemptId: succeeded.attemptId, version: succeeded.version, fence: succeeded.fence }, this.now())
    return { attempt: succeeded, dispatch }
  }

  private async classifyFailure(
    ceremony: SealedCeremony,
    attempt: AttemptRecord,
    error: unknown,
    transition: (to: AttemptState, options?: { error?: string }) => Promise<void>,
  ): Promise<AttemptState> {
    let state: AttemptState
    if (error instanceof AttemptExpiredError && !isAfterExternalBoundary(attempt)) state = 'expired'
    else if (error instanceof ProvenPreDispatchCancellationError && attempt.externalIds.length === 0) state = 'safely-rejected-before-dispatch'
    else if (error instanceof ProvenOffchainCancellationError) state = 'cancelled-proven'
    else if (error instanceof AttemptRevertedError) state = 'reverted'
    else if (error instanceof CleanupRequiredError) state = 'cleanup-required'
    else if (error instanceof DispatchStatusUnknownError || error instanceof SignatureStatusUnknownError || isAfterExternalBoundary(attempt, ceremony)) state = 'recovery-required'
    else state = 'safely-rejected-before-dispatch'
    if (attempt.state !== state) await transition(state, { error: errorMessage(error) })
    return state
  }
}
