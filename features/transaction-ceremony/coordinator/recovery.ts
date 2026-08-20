import type { AttemptRecord, AttemptState } from '../domain/attempt'
import type { SealedCeremony } from '../domain/ceremony'
import type { CeremonyJournal, ExternalArtifactRecord } from '../persistence/journal'
import { isTerminalAttemptState } from '../persistence/journal'
import { assertCeremonyIntegrity } from '../domain/seal'

export interface ReconciliationResult {
  state: Extract<AttemptState, 'succeeded' | 'reverted' | 'cancelled-proven' | 'cleanup-required' | 'recovery-required'>
  externalIds?: readonly { kind: ExternalArtifactRecord['kind'], value: string }[]
  detail?: string
}

export interface AttemptReconciler {
  reconcile(ceremony: SealedCeremony, attempt: AttemptRecord): Promise<ReconciliationResult>
}

/** Reconciles durable facts only. It never creates a replacement attempt. */
export class CeremonyRecoveryService {
  constructor(
    private readonly journal: CeremonyJournal,
    private readonly reconcilers: Readonly<Record<'eoa' | 'safe', AttemptReconciler>>,
    private readonly now: () => number = Date.now,
  ) {}

  list() {
    return this.journal.listRecoverableAttempts()
  }

  async reconcile(attemptId: string): Promise<AttemptRecord> {
    let attempt = await this.journal.getAttempt(attemptId)
    if (!attempt) throw new Error('Recovery attempt is missing')
    if (isTerminalAttemptState(attempt.state)) return attempt
    const ceremony = await this.journal.getCeremony(attempt.ceremonyId)
    if (!ceremony || ceremony.templateDigest !== attempt.templateDigest) throw new Error('Recovery ceremony is missing or corrupt')
    assertCeremonyIntegrity(ceremony)
    const result = await this.reconcilers[ceremony.template.transport].reconcile(ceremony, attempt)
    for (const external of result.externalIds ?? []) {
      attempt = await this.journal.recordExternalArtifact(
        { attemptId, version: attempt.version, fence: attempt.fence },
        { ...external, observedAt: this.now() },
      )
    }
    if (result.state === 'succeeded') {
      for (const obligation of await this.journal.listCleanupObligations(attemptId)) {
        if (obligation.status === 'completed') continue
        await this.journal.updateCleanupObligation(
          { attemptId, version: attempt.version, fence: attempt.fence },
          obligation.obligationId,
          'completed',
          this.now(),
        )
      }
    }
    attempt = await this.journal.transitionAttempt({
      expected: { attemptId, version: attempt.version, fence: attempt.fence },
      to: result.state,
      now: this.now(),
      ...(result.detail ? { error: result.detail } : {}),
    })
    if (isTerminalAttemptState(result.state)) {
      await this.journal.releaseLane({ attemptId, version: attempt.version, fence: attempt.fence }, this.now())
    }
    return attempt
  }
}
