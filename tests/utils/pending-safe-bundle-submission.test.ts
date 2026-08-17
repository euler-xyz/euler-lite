import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import {
  clearHashlessPendingSafeBundleSubmission,
  loadPendingSafeBundleSubmissions,
  PENDING_SAFE_BUNDLE_STORAGE_KEY,
  reservePendingSafeBundleSubmission,
} from '~/utils/pending-safe-bundle-submission'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const HASH = `0x${'11'.repeat(32)}` as const

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

describe('pending Safe bundle recovery', () => {
  it('fails closed when the durable registry exists but is empty', () => {
    const storage = memoryStorage()
    storage.setItem(PENDING_SAFE_BUNDLE_STORAGE_KEY, '')

    expect(() => loadPendingSafeBundleSubmissions(storage))
      .toThrow('Pending Safe bundle storage is unreadable')
  })

  it('clears only a hashless reservation after manual verification', () => {
    const storage = memoryStorage()
    reservePendingSafeBundleSubmission(storage, {
      reservationId: 'hashless',
      account: ACCOUNT,
      chainId: 1,
      errorMessage: 'Verify in Safe',
    })

    clearHashlessPendingSafeBundleSubmission(storage, 'hashless')

    expect(loadPendingSafeBundleSubmissions(storage)).toEqual([])
  })

  it('refuses to clear a submitted bundle that must be hash-reconciled', () => {
    const storage = memoryStorage()
    reservePendingSafeBundleSubmission(storage, {
      reservationId: 'submitted',
      account: ACCOUNT,
      chainId: 1,
      submittedHash: HASH,
      errorMessage: 'Pending confirmation',
    })

    expect(() => clearHashlessPendingSafeBundleSubmission(storage, 'submitted'))
      .toThrow('must be reconciled by transaction hash')
    expect(loadPendingSafeBundleSubmissions(storage)).toHaveLength(1)
  })
})
