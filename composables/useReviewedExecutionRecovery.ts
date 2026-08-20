import type { SubmissionAttempt } from '~/features/reviewed-execution/domain/submission-attempt'
import { SUBMISSION_JOURNAL_CHANNEL, IndexedDbSubmissionJournal } from '~/features/reviewed-execution/persistence/journal'

const attempts = ref<SubmissionAttempt[]>([])
const isLoading = ref(false)
const error = ref<string>()
let reconcileHandler: ((attemptId: string) => Promise<void>) | undefined
let channel: BroadcastChannel | undefined

export const useReviewedExecutionRecovery = () => {
  const refresh = async () => {
    if (!import.meta.client) return
    isLoading.value = true
    error.value = undefined
    try {
      const journal = await IndexedDbSubmissionJournal.open()
      attempts.value = await journal.listRecoverableAttempts()
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Unable to read transaction recovery state'
    }
    finally {
      isLoading.value = false
    }
  }

  const registerReconciler = (handler: (attemptId: string) => Promise<void>) => {
    reconcileHandler = handler
  }

  const reconcile = async (attemptId: string) => {
    if (!reconcileHandler) throw new Error('Transaction recovery is not initialized')
    await reconcileHandler(attemptId)
    await refresh()
  }

  onMounted(() => {
    void refresh()
    channel ??= new BroadcastChannel(SUBMISSION_JOURNAL_CHANNEL)
    channel.addEventListener('message', refresh)
  })

  onUnmounted(() => {
    channel?.removeEventListener('message', refresh)
  })

  return {
    attempts: readonly(attempts),
    isLoading: readonly(isLoading),
    error: readonly(error),
    refresh,
    reconcile,
    registerReconciler,
  }
}
