import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  listReleasableArmedSubmissions,
  releaseUnverifiablePendingSubmission,
  subscribeToPendingSubmissionChanges,
  type PendingSubmissionFlow,
  type ReleasableArmedSubmission,
} from '~/utils/pendingSubmissions'
import { logWarn } from '~/utils/errorHandling'

/**
 * Flows whose armed records have no owning recovery surface of their own: a
 * reload while the wallet prompt was open orphans the record, and the page
 * that armed it holds no state to offer the release from. The batch flow is
 * excluded — the batch cart drawer persists across navigation and owns its
 * own release CTA over the exact entries the record covers.
 */
export const RECOVERABLE_SUBMISSION_FLOWS: readonly PendingSubmissionFlow[] = [
  'direct',
  'outgoing-migration',
  'inbound-migration',
  'cow-order',
]

export const recoverableSubmissionLabel = (flow: PendingSubmissionFlow): string =>
  flow === 'cow-order'
    ? 'CoW Swap order'
    : flow === 'outgoing-migration' || flow === 'inbound-migration'
      ? 'migration'
      : 'transaction'

/**
 * App-root recovery for armed pending-submission records orphaned by a reload
 * before the wallet answered. Such records have no transaction id, so they
 * can never resolve on-chain by themselves — they block every executor for
 * the wallet/chain until the user explicitly confirms the wallet itself shows
 * nothing pending and dismisses them. Records that carry any verifiable id
 * (submitted, or armed with an observed id) are never listed: they resolve
 * objectively and must not be dismissable.
 */
export const usePendingSubmissionRecovery = () => {
  const { address } = useWagmi()
  // shallowRef: entries are immutable snapshots replaced wholesale on every
  // refresh — deep reactivity would only mangle the readonly record types.
  const entries = shallowRef<ReleasableArmedSubmission[]>([])
  const releaseError = ref('')

  const refresh = () => {
    const owner = address.value
    if (!owner) {
      entries.value = []
      return
    }
    try {
      // Both sides are EIP-55 checksummed (the listing via getAddress, the
      // connected address via useWagmi's normalization).
      entries.value = listReleasableArmedSubmissions(RECOVERABLE_SUBMISSION_FLOWS)
        .filter(entry => entry.owner === owner)
    }
    catch (err) {
      // Recovery is best-effort UI — it must never break the app shell. The
      // executors' own gates keep failing closed regardless.
      logWarn('pendingSubmissionRecovery/list', err)
      entries.value = []
    }
  }

  /**
   * Risk-labelled manual release. Callers must only invoke this from a
   * control whose copy states the user checked the wallet's pending activity
   * and found nothing pending — the acknowledgement flag asserts exactly
   * that. A refusal (e.g. the record gained an id meanwhile) surfaces as
   * `releaseError` and the listing refreshes either way.
   */
  const release = async (entry: ReleasableArmedSubmission) => {
    releaseError.value = ''
    try {
      await releaseUnverifiablePendingSubmission(entry.flow, entry.owner, entry.chainId, {
        userConfirmedWalletShowsNoPendingSubmission: true,
      })
    }
    catch (err) {
      releaseError.value = err instanceof Error ? err.message : 'This record could not be dismissed.'
      logWarn('pendingSubmissionRecovery/release', err)
    }
    finally {
      refresh()
    }
  }

  let unsubscribe: (() => void) | undefined
  onMounted(() => {
    unsubscribe = subscribeToPendingSubmissionChanges(refresh)
    // Same-key writes from other tabs arrive as storage events.
    window.addEventListener('storage', refresh)
    refresh()
  })
  onUnmounted(() => {
    unsubscribe?.()
    unsubscribe = undefined
    window.removeEventListener('storage', refresh)
  })
  watch(address, refresh)

  return { entries, releaseError, refresh, release }
}
