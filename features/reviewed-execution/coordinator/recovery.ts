import type { SubmissionAttempt, SubmissionState } from '../domain/submission-attempt'
import type { ReviewedExecution } from '../domain/reviewed-execution'
import type { SubmissionJournal, ExternalArtifactRecord } from '../persistence/journal'
import { isTerminalSubmissionState } from '../persistence/journal'
import { assertReviewedExecutionIntegrity } from '../domain/seal'

export interface ReconciliationResult {
  state: Extract<SubmissionState, 'succeeded' | 'reverted' | 'cancelled-proven' | 'cleanup-required' | 'recovery-required'>
  externalIds?: readonly { kind: ExternalArtifactRecord['kind'], value: string }[]
  detail?: string
}

export interface AttemptReconciler {
  reconcile(execution: ReviewedExecution, attempt: SubmissionAttempt): Promise<ReconciliationResult>
}

/** Reconciles durable facts only. It never creates a replacement attempt. */
export class SubmissionRecoveryService {
  constructor(
    private readonly journal: SubmissionJournal,
    private readonly reconcilers: Readonly<Record<'eoa' | 'safe', AttemptReconciler>>,
    private readonly now: () => number = Date.now,
  ) {}

  list() {
    return this.journal.listRecoverableAttempts()
  }

  async reconcile(attemptId: string): Promise<SubmissionAttempt> {
    let attempt = await this.journal.getAttempt(attemptId)
    if (!attempt) throw new Error('Recovery attempt is missing')
    if (isTerminalSubmissionState(attempt.state)) return attempt
    const execution = await this.journal.getReviewedExecution(attempt.reviewId)
    if (!execution || execution.requestDigest !== attempt.requestDigest) throw new Error('Recovery reviewed execution is missing or corrupt')
    assertReviewedExecutionIntegrity(execution)
    const result = await this.reconcilers[execution.requestSet.transport].reconcile(execution, attempt)
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
    if (isTerminalSubmissionState(result.state)) {
      await this.journal.releaseLane({ attemptId, version: attempt.version, fence: attempt.fence }, this.now())
    }
    return attempt
  }
}
