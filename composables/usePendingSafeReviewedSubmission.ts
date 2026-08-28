import type { Address } from 'viem'
import {
  clearHashlessPendingSafeReviewedSubmission,
  loadPendingSafeReviewedSubmissions,
  PENDING_SAFE_REVIEWED_SUBMISSION_KEY,
  type PendingSafeReviewedSubmission,
} from '~/utils/pending-safe-reviewed-submission'
import { withSafeReviewedSubmissionLock } from '~/utils/safe-reviewed-submission-lock'

const pending = ref<PendingSafeReviewedSubmission[]>([])
const storageError = ref('')

const getStorage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  }
  catch {
    return undefined
  }
}

export const usePendingSafeReviewedSubmission = () => {
  const { address, chainId } = useWagmi()

  const refresh = () => {
    const storage = getStorage()
    if (!storage) {
      pending.value = []
      storageError.value = 'Durable Safe submission storage is unavailable.'
      return
    }
    try {
      pending.value = loadPendingSafeReviewedSubmissions(storage)
      storageError.value = ''
    }
    catch (cause) {
      pending.value = []
      storageError.value = cause instanceof Error ? cause.message : 'Pending Safe submission storage is unreadable.'
    }
  }

  const current = computed(() => pending.value.find(record =>
    record.chainId === chainId.value
    && record.account.toLowerCase() === address.value?.toLowerCase(),
  ))

  const clearConfirmedAbsent = async (record: PendingSafeReviewedSubmission) => {
    await withSafeReviewedSubmissionLock(() => {
      const storage = getStorage()
      if (!storage) throw new Error('Durable Safe submission storage is unavailable.')
      clearHashlessPendingSafeReviewedSubmission(storage, {
        reservationId: record.reservationId,
        account: record.account as Address,
        chainId: record.chainId,
        confirmedAbsent: true,
      })
    })
    refresh()
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === PENDING_SAFE_REVIEWED_SUBMISSION_KEY) refresh()
  }
  onMounted(() => {
    refresh()
    window.addEventListener('storage', onStorage)
  })
  onUnmounted(() => window.removeEventListener('storage', onStorage))

  return { current, storageError, refresh, clearConfirmedAbsent }
}
