import { useToast } from '~/components/ui/composables/useToast'
import type { PlainTxRequest } from '~/utils/migrationAuthorizationTxs'

/**
 * Every connector throws its own "<protocol> ... for the Euler SwapVerifier is
 * required" when the batch needs an authorization item but none was supplied.
 * Without signatures that means the grant we mined no longer covers the plan.
 */
const MISSING_AUTHORIZATION_ERROR = /for the Euler SwapVerifier is required/i

const STALE_AUTHORIZATION_MESSAGE
  = 'On-chain allowances changed while preparing the migration. Please retry.'

/**
 * Toast-wrapped authorization restoration for the plain-transaction migration
 * flow, plus the translation of the SDK's missing-authorization errors.
 *
 * Restoration transactions are best-effort by design: the migration itself has
 * already settled (or already failed), so a declined restoration must not
 * surface as a failure.
 */
export const useMigrationAuthorizationFlow = () => {
  const { sendMigrationAuthorizationRevokes } = useEulerTx()
  const { warning: showWarning } = useToast()

  const revokeAfterSuccess = async (revokes: readonly PlainTxRequest[]) => {
    if (!revokes.length) return
    if (await sendMigrationAuthorizationRevokes(revokes)) return
    showWarning('Migration succeeded, but restoring your previous authorization failed or was cancelled. You can restore it manually later.')
  }

  const revokeAfterAbort = async (revokes: readonly PlainTxRequest[]) => {
    if (!revokes.length) return
    if (await sendMigrationAuthorizationRevokes(revokes)) return
    showWarning('The temporary authorization granted for this migration is still standing. Retry the migration or restore your previous authorization manually.')
  }

  const toMigrationExecutionError = (err: unknown): unknown =>
    err instanceof Error && MISSING_AUTHORIZATION_ERROR.test(err.message)
      ? new Error(STALE_AUTHORIZATION_MESSAGE)
      : err

  return {
    revokeAfterSuccess,
    revokeAfterAbort,
    toMigrationExecutionError,
  }
}
