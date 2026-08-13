import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { usePendingSafeBundleRecovery } from '~/composables/usePendingSafeBundleRecovery'
import {
  loadPendingSafeBundleSubmissions,
  reservePendingSafeBundleSubmission,
} from '~/utils/pending-safe-bundle-submission'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

describe('usePendingSafeBundleRecovery', () => {
  let storage: ReturnType<typeof memoryStorage>

  beforeEach(() => {
    storage = memoryStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: storage },
    })
    vi.stubGlobal('onMounted', (callback: () => void) => callback())
  })

  it('requires confirmation for the exact displayed account and chain', () => {
    reservePendingSafeBundleSubmission(storage, {
      reservationId: 'hashless',
      account: ACCOUNT,
      chainId: 1,
      errorMessage: 'Verify in Safe',
    })
    const recovery = usePendingSafeBundleRecovery()

    expect(recovery.pendingHashlessBundles.value).toHaveLength(1)
    expect(() => recovery.clearVerifiedHashlessBundle({
      reservationId: 'hashless',
      account: ACCOUNT,
      chainId: 1,
      confirmedAbsent: false,
    })).toThrow('Confirm that Safe contains no proposal')

    recovery.clearVerifiedHashlessBundle({
      reservationId: 'hashless',
      account: ACCOUNT,
      chainId: 1,
      confirmedAbsent: true,
    })
    expect(loadPendingSafeBundleSubmissions(storage)).toEqual([])
    expect(recovery.pendingHashlessBundles.value).toEqual([])
  })
})
