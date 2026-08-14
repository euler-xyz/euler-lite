import { useToast } from '~/components/ui/composables/useToast'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'

/**
 * Every connector throws its own "<protocol> ... for the Euler SwapVerifier is
 * required" when the batch needs an authorization item but none was supplied.
 * Without signatures that means the grant we mined no longer covers the plan.
 */
const MISSING_AUTHORIZATION_ERROR = /for the Euler SwapVerifier is required/i

const STALE_AUTHORIZATION_MESSAGE
  = 'On-chain allowances changed while preparing the migration. Please retry.'

const revokeKey = (revoke: MigrationAuthorizationRevoke) => [
  revoke.walletContext.chainId,
  revoke.walletContext.account.toLowerCase(),
  revoke.transaction.to.toLowerCase(),
  revoke.transaction.data.toLowerCase(),
  revoke.transaction.value?.toString() ?? '0',
].join(':')

/**
 * Toast-wrapped authorization restoration for the plain-transaction migration
 * flow, plus the translation of the SDK's missing-authorization errors.
 *
 * Restoration transactions are best-effort by design: the migration itself has
 * already settled (or already failed), so a declined restoration must not
 * surface as a failure. Failed restorations remain queued and must complete
 * before another migration attempt proceeds.
 */
export const useMigrationAuthorizationFlow = () => {
  const { sendMigrationAuthorizationRevokes } = useEulerTx()
  const { warning: showWarning } = useToast()
  const pendingRevokes = useState<MigrationAuthorizationRevoke[]>(
    'migration-authorization:pending-revokes',
    () => [],
  )

  const queueRevokes = (revokes: readonly MigrationAuthorizationRevoke[]) => {
    const known = new Set(pendingRevokes.value.map(revokeKey))
    const additions = revokes.filter(revoke => !known.has(revokeKey(revoke)))
    if (additions.length) pendingRevokes.value = [...pendingRevokes.value, ...additions]
  }

  const restorePendingRevokes = async (): Promise<boolean> => {
    const snapshot = [...pendingRevokes.value]
    if (!snapshot.length) return true

    const { restored, failed } = await sendMigrationAuthorizationRevokes(snapshot)
    const restoredKeys = new Set(restored.map(revokeKey))
    if (restoredKeys.size) {
      pendingRevokes.value = pendingRevokes.value.filter(
        revoke => !restoredKeys.has(revokeKey(revoke)),
      )
    }
    return failed.length === 0
  }

  const restorePendingBeforeRetry = async (): Promise<boolean> => {
    if (await restorePendingRevokes()) return true
    showWarning('A previous migration authorization is still standing. Reconnect its wallet and network to restore it before retrying, or restore it manually.')
    return false
  }

  const revokeAfterSuccess = async (
    revokes: readonly MigrationAuthorizationRevoke[],
    options?: { shouldNotify?: () => boolean },
  ) => {
    queueRevokes(revokes)
    if (await restorePendingRevokes()) return
    if (options?.shouldNotify?.() === false) return
    showWarning('Migration succeeded, but restoring your previous authorization failed or was cancelled. You can restore it manually later.')
  }

  const revokeAfterAbort = async (
    revokes: readonly MigrationAuthorizationRevoke[],
    options?: { shouldNotify?: () => boolean },
  ) => {
    queueRevokes(revokes)
    if (await restorePendingRevokes()) return
    if (options?.shouldNotify?.() === false) return
    showWarning('The temporary authorization granted for this migration is still standing. Retry the migration or restore your previous authorization manually.')
  }

  const toMigrationExecutionError = (err: unknown): unknown =>
    err instanceof Error && MISSING_AUTHORIZATION_ERROR.test(err.message)
      ? new Error(STALE_AUTHORIZATION_MESSAGE)
      : err

  return {
    pendingRevokes,
    restorePendingBeforeRetry,
    revokeAfterSuccess,
    revokeAfterAbort,
    toMigrationExecutionError,
  }
}
