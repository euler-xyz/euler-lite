import type { Address } from 'viem'
import {
  clearHashlessPendingSafeBundleSubmission,
  loadPendingSafeBundleSubmissions,
  type PendingSafeBundleSubmission,
} from '~/utils/pending-safe-bundle-submission'
import { acquireSafeSubmissionLock } from '~/utils/safe-submission-lock'

const getStorage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  }
  catch {
    return undefined
  }
}

export const usePendingSafeBundleRecovery = () => {
  const pendingHashlessBundles = ref<PendingSafeBundleSubmission[]>([])

  const refresh = () => {
    const storage = getStorage()
    pendingHashlessBundles.value = storage
      ? loadPendingSafeBundleSubmissions(storage).filter(submission => !submission.submittedHash)
      : []
  }

  const clearVerifiedHashlessBundle = async (args: {
    reservationId: string
    account: Address
    chainId: number
    confirmedAbsent: boolean
  }) => {
    if (!args.confirmedAbsent) {
      throw new Error('Confirm that Safe contains no proposal before clearing this lock.')
    }
    const release = await acquireSafeSubmissionLock()
    try {
      const storage = getStorage()
      if (!storage) throw new Error('Durable Safe submission storage is unavailable.')
      const pending = loadPendingSafeBundleSubmissions(storage)
        .find(submission => submission.reservationId === args.reservationId)
      if (!pending || pending.account !== args.account || pending.chainId !== args.chainId) {
        throw new Error('The pending Safe bundle context changed. Review it again before clearing.')
      }
      clearHashlessPendingSafeBundleSubmission(storage, args.reservationId)
      refresh()
    }
    finally {
      release()
    }
  }

  onMounted(refresh)

  return {
    pendingHashlessBundles,
    clearVerifiedHashlessBundle,
    refresh,
  }
}
