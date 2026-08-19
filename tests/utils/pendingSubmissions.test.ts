import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Hash } from 'viem'
import {
  armPendingSubmission,
  clearPendingSubmission,
  createPendingSubmissionAttemptId,
  listPendingSubmissions,
  listReleasableArmedSubmissions,
  PendingSubmissionConflictError,
  PendingSubmissionStorageError,
  readPendingSubmission,
  registerActiveSubmissionAttempt,
  releasePendingSubmission,
  releaseUnverifiablePendingSubmission,
  resetPendingSubmissionMemoryFallback,
  resolvePendingSubmissionOutcome,
  unregisterActiveSubmissionAttempt,
  upgradePendingSubmissionToSubmitted,
  walletNeverAcceptedSubmission,
  writePendingSubmission,
  type PendingSubmissionRecord,
  type SubmittedPendingSubmission,
} from '~/utils/pendingSubmissions'
import { SafeTransactionStatusUnknownError } from '~/utils/safeWalletTransactions'

const safeMocks = vi.hoisted(() => ({
  waitForSafeTransactionExecution: vi.fn(),
}))

vi.mock('~/utils/safeWalletTransactions', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    waitForSafeTransactionExecution: safeMocks.waitForSafeTransactionExecution,
  }
})

const OWNER = getAddress('0x1000000000000000000000000000000000000000')
const OTHER_OWNER = getAddress('0x2000000000000000000000000000000000000000')
const TX_HASH = `0x${'11'.repeat(32)}` as Hash
const SAFE_TX_HASH = `0x${'22'.repeat(32)}` as Hash
const BATCH_KEY = `euler_pending_submission:batch:1:${OWNER}`

const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
  }
}

const record = (overrides: Partial<SubmittedPendingSubmission> = {}): PendingSubmissionRecord => ({
  phase: 'submitted',
  kind: 'transaction',
  hash: TX_HASH,
  chainId: 1,
  owner: OWNER,
  completesPlan: true,
  submittedAt: 1_000,
  ...overrides,
})

const armedRecord = (): PendingSubmissionRecord => ({
  phase: 'armed',
  chainId: 1,
  owner: OWNER,
  completesPlan: true,
  submittedAt: 1_000,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', createMemoryStorage())
  resetPendingSubmissionMemoryFallback()
})

describe('pending submission storage', () => {
  it('round-trips a record through storage', () => {
    writePendingSubmission('batch', record({ refreshExternalPositions: true }))

    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record({ refreshExternalPositions: true }))
    // Flows are isolated: the batch record must not leak into direct flows.
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
  })

  it('round-trips an armed record without an id', () => {
    writePendingSubmission('batch', armedRecord())

    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(armedRecord())
  })

  it('keys records per wallet and chain so one wallet cannot overwrite another', async () => {
    writePendingSubmission('batch', record())
    writePendingSubmission('batch', record({ owner: OTHER_OWNER, hash: SAFE_TX_HASH }))
    writePendingSubmission('batch', record({ chainId: 8453 }))

    // All three coexist and each is independently readable/reconcilable.
    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record())
    expect(readPendingSubmission('batch', OTHER_OWNER, 1)).toEqual(record({ owner: OTHER_OWNER, hash: SAFE_TX_HASH }))
    expect(readPendingSubmission('batch', OWNER, 8453)).toEqual(record({ chainId: 8453 }))
    expect(listPendingSubmissions('batch')).toHaveLength(3)

    // Clearing one wallet's record leaves the others quarantined.
    await clearPendingSubmission('batch', OWNER, 1)
    expect(readPendingSubmission('batch', OWNER, 1)).toBeUndefined()
    expect(readPendingSubmission('batch', OTHER_OWNER, 1)).toBeDefined()
    expect(readPendingSubmission('batch', OWNER, 8453)).toBeDefined()
  })

  it('clears a stored record', async () => {
    writePendingSubmission('outgoing-migration', record())

    await clearPendingSubmission('outgoing-migration', OWNER, 1)

    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
  })

  it('compare-and-delete keeps a record another attempt wrote in the meantime', async () => {
    const reconciled = record({ attemptId: 'attempt-old' })
    writePendingSubmission('batch', reconciled)
    // Another attempt replaced the record between reconcile and clear.
    const replacement = record({ attemptId: 'attempt-new', submittedAt: 2_000 })
    writePendingSubmission('batch', replacement)

    await clearPendingSubmission('batch', OWNER, 1, { ifMatches: reconciled })

    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(replacement)

    // With the exact record still in place the clear goes through.
    await clearPendingSubmission('batch', OWNER, 1, { ifMatches: replacement })
    expect(readPendingSubmission('batch', OWNER, 1)).toBeUndefined()
  })

  it('normalizes owners to checksum form for keying and reading', () => {
    writePendingSubmission('batch', record())

    expect(readPendingSubmission('batch', OWNER.toLowerCase() as typeof OWNER, 1)).toEqual(record())
  })

  it('normalizes the stored owner to checksum form', () => {
    localStorage.setItem(BATCH_KEY, JSON.stringify({
      ...record(),
      owner: OWNER.toLowerCase(),
    }))

    expect(readPendingSubmission('batch', OWNER, 1)?.owner).toBe(OWNER)
  })

  it.each([
    ['unparseable JSON', 'not json'],
    ['wrong phase', JSON.stringify({ ...record(), phase: 'other' })],
    ['missing phase', JSON.stringify({ ...record(), phase: undefined })],
    ['wrong kind', JSON.stringify({ ...record(), kind: 'other' })],
    ['malformed hash', JSON.stringify({ ...record(), hash: '0x1234' })],
    ['malformed owner', JSON.stringify({ ...record(), owner: '0xnope' })],
    ['non-boolean completesPlan', JSON.stringify({ ...record(), completesPlan: 'yes' })],
    ['non-numeric submittedAt', JSON.stringify({ ...record(), submittedAt: 'now' })],
    ['non-positive chainId', JSON.stringify({ ...record(), chainId: 0 })],
  ])('fails closed on a corrupt record (%s) instead of silently dropping it', (_label, raw) => {
    localStorage.setItem(BATCH_KEY, raw)

    // A corrupt record may still describe a live submission — deleting it
    // would reopen the exact replay the quarantine exists to block.
    expect(() => readPendingSubmission('batch', OWNER, 1)).toThrow(PendingSubmissionStorageError)
    expect(() => readPendingSubmission('batch', OWNER, 1)).toThrow('could not be read')
    expect(localStorage.getItem(BATCH_KEY)).toBe(raw)
  })

  it('fails closed on a record whose content disagrees with its storage key', () => {
    const raw = JSON.stringify(record({ owner: OTHER_OWNER }))
    localStorage.setItem(BATCH_KEY, raw)

    expect(() => readPendingSubmission('batch', OWNER, 1)).toThrow(PendingSubmissionStorageError)
    expect(localStorage.getItem(BATCH_KEY)).toBe(raw)
  })

  it('fails closed when the storage read itself throws', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', {
      ...storage,
      getItem: () => {
        throw new Error('storage read failed')
      },
    })

    // An existing durable record may be invisible behind the failing read —
    // that must block the attempt, never fall through to "no quarantine".
    expect(() => readPendingSubmission('batch', OWNER, 1)).toThrow(PendingSubmissionStorageError)
    expect(() => readPendingSubmission('batch', OWNER, 1)).toThrow('could not be read to verify')
  })

  it('skips unreadable entries when listing for display', () => {
    writePendingSubmission('batch', record({ owner: OTHER_OWNER }))
    localStorage.setItem(BATCH_KEY, 'not json')

    // Listing is display/mirror only — it must not crash hydration. The
    // corrupt entry still blocks at attempt time via readPendingSubmission.
    expect(listPendingSubmissions('batch')).toEqual([record({ owner: OTHER_OWNER })])
    expect(() => readPendingSubmission('batch', OWNER, 1)).toThrow(PendingSubmissionStorageError)
  })

  it('aborts the reservation without browser storage while still blocking this realm', () => {
    vi.stubGlobal('localStorage', undefined)

    // No durable storage: the write must throw so nothing reaches the wallet…
    expect(() => writePendingSubmission('batch', record())).toThrow(PendingSubmissionStorageError)
    expect(() => writePendingSubmission('batch', record())).toThrow('nothing was handed to the wallet')
    // …but the in-realm copy still blocks this session's retries.
    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record())
    expect(listPendingSubmissions('batch')).toEqual([record()])
  })

  it('aborts the reservation when the storage write throws', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', {
      ...storage,
      setItem: () => {
        throw new Error('quota exceeded')
      },
    })

    expect(() => writePendingSubmission('batch', record())).toThrow(PendingSubmissionStorageError)
    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record())
  })

  it('aborts the reservation when the storage write does not stick', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', {
      ...storage,
      // A lying storage: accepts the write, returns nothing on read-back.
      setItem: () => {},
      getItem: () => null,
      get length() {
        return 0
      },
    })

    expect(() => writePendingSubmission('batch', record())).toThrow(PendingSubmissionStorageError)
    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record())
    expect(listPendingSubmissions('batch')).toEqual([record()])
  })

  it('lists records across storage and the in-memory fallback together', () => {
    const storage = globalThis.localStorage
    writePendingSubmission('batch', record())
    vi.stubGlobal('localStorage', undefined)
    // The storage-less write throws (nothing durable), but its in-realm copy
    // must still show up so the UI mirrors everything that blocks.
    expect(() => writePendingSubmission('batch', record({ owner: OTHER_OWNER }))).toThrow(PendingSubmissionStorageError)
    vi.stubGlobal('localStorage', storage)

    expect(listPendingSubmissions('batch')).toEqual(expect.arrayContaining([
      record(),
      record({ owner: OTHER_OWNER }),
    ]))
    expect(listPendingSubmissions('batch')).toHaveLength(2)
  })
})

describe('armPendingSubmission', () => {
  const armInput = (attemptId: string, overrides: Partial<Parameters<typeof armPendingSubmission>[1]> = {}) => ({
    owner: OWNER,
    chainId: 1,
    completesPlan: true,
    attemptId,
    ...overrides,
  })

  it('reserves atomically and returns the durable armed record', async () => {
    const armed = await armPendingSubmission('direct', armInput('attempt-1'))

    expect(armed).toMatchObject({ phase: 'armed', owner: OWNER, chainId: 1, attemptId: 'attempt-1' })
    expect(readPendingSubmission('direct', OWNER, 1)).toEqual(armed)
  })

  it('refuses when any flow already holds a reservation for this wallet/chain', async () => {
    writePendingSubmission('batch', record({ attemptId: 'other-attempt' }))

    await expect(armPendingSubmission('direct', armInput('attempt-1')))
      .rejects.toThrow(PendingSubmissionConflictError)
    // The existing reservation is untouched.
    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record({ attemptId: 'other-attempt' }))
    expect(readPendingSubmission('direct', OWNER, 1)).toBeUndefined()
  })

  it('lets exactly one of two simultaneous arms win from an empty read', async () => {
    // Both attempts passed the read-only gate on an empty store; the atomic
    // check+reserve under the per-wallet lock must let only one proceed to
    // the wallet.
    const results = await Promise.allSettled([
      armPendingSubmission('direct', armInput('attempt-a')),
      armPendingSubmission('batch', armInput('attempt-b')),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PendingSubmissionConflictError)
  })

  it('does not conflict across different wallets or chains', async () => {
    await armPendingSubmission('direct', armInput('attempt-1'))

    await expect(armPendingSubmission('direct', armInput('attempt-2', { owner: OTHER_OWNER })))
      .resolves.toMatchObject({ owner: OTHER_OWNER })
    await expect(armPendingSubmission('direct', armInput('attempt-3', { chainId: 8453 })))
      .resolves.toMatchObject({ chainId: 8453 })
  })

  it('lets the same attempt re-arm its own armed reservation', async () => {
    await armPendingSubmission('direct', armInput('attempt-1'))

    await expect(armPendingSubmission('direct', armInput('attempt-1', { completesPlan: false })))
      .resolves.toMatchObject({ attemptId: 'attempt-1', completesPlan: false })
  })

  it('refuses to re-arm over its own submitted record — the hash must survive', async () => {
    await armPendingSubmission('direct', armInput('attempt-1'))
    await upgradePendingSubmissionToSubmitted('direct', {
      owner: OWNER,
      chainId: 1,
      attemptId: 'attempt-1',
      kind: 'transaction',
      hash: TX_HASH,
      completesPlan: true,
    })

    await expect(armPendingSubmission('direct', armInput('attempt-1')))
      .rejects.toThrow(PendingSubmissionConflictError)
    expect(readPendingSubmission('direct', OWNER, 1)).toMatchObject({ phase: 'submitted', hash: TX_HASH })
  })

  it('refuses a reservation left by a dead attempt (reload) — no silent takeover', async () => {
    // A record without this attempt's id (e.g. armed before a reload) blocks.
    writePendingSubmission('direct', { ...armedRecord(), attemptId: 'gone-attempt' })

    await expect(armPendingSubmission('direct', armInput('attempt-new')))
      .rejects.toThrow(PendingSubmissionConflictError)
  })

  it('throws before the wallet when the reservation cannot be proven durable', async () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', {
      ...storage,
      setItem: () => {
        throw new Error('quota exceeded')
      },
    })

    await expect(armPendingSubmission('direct', armInput('attempt-1')))
      .rejects.toThrow(PendingSubmissionStorageError)
  })

  it('throws before the wallet when existing state cannot be read', async () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', {
      ...storage,
      getItem: () => {
        throw new Error('storage read failed')
      },
    })

    await expect(armPendingSubmission('direct', armInput('attempt-1')))
      .rejects.toThrow(PendingSubmissionStorageError)
  })
})

describe('upgradePendingSubmissionToSubmitted', () => {
  const upgradeInput = (attemptId: string) => ({
    owner: OWNER,
    chainId: 1,
    attemptId,
    kind: 'transaction' as const,
    hash: TX_HASH,
    completesPlan: true,
  })

  it('upgrades the attempt\'s own armed reservation', async () => {
    await armPendingSubmission('direct', { owner: OWNER, chainId: 1, completesPlan: true, attemptId: 'attempt-1' })

    const upgraded = await upgradePendingSubmissionToSubmitted('direct', upgradeInput('attempt-1'))

    expect(upgraded).toMatchObject({ phase: 'submitted', hash: TX_HASH, attemptId: 'attempt-1' })
    expect(readPendingSubmission('direct', OWNER, 1)).toEqual(upgraded)
  })

  it('refuses to upgrade a reservation another attempt owns', async () => {
    await armPendingSubmission('direct', { owner: OWNER, chainId: 1, completesPlan: true, attemptId: 'attempt-owner' })

    await expect(upgradePendingSubmissionToSubmitted('direct', upgradeInput('attempt-stale')))
      .resolves.toBeUndefined()
    // The owner's armed reservation is untouched.
    expect(readPendingSubmission('direct', OWNER, 1)).toMatchObject({ phase: 'armed', attemptId: 'attempt-owner' })
  })

  it('refuses to create a record when none exists', async () => {
    await expect(upgradePendingSubmissionToSubmitted('direct', upgradeInput('attempt-1')))
      .resolves.toBeUndefined()
    expect(readPendingSubmission('direct', OWNER, 1)).toBeUndefined()
  })

  /**
   * Storage stub that accepts every write except a submitted-phase record —
   * simulating a quota-bound storage that held the armed reservation but
   * refuses the larger rewrite. Everything else delegates to `working`.
   */
  const submittedWriteRefusingStorage = (working: Storage): Storage => ({
    get length() {
      return working.length
    },
    clear: () => working.clear(),
    key: (index: number) => working.key(index),
    getItem: (key: string) => working.getItem(key),
    removeItem: (key: string) => working.removeItem(key),
    setItem: (key: string, value: string) => {
      if (value.includes('"phase":"submitted"')) throw new Error('quota exceeded')
      working.setItem(key, value)
    },
  })

  it('preserves the observed id durably and throws when the submitted rewrite cannot be made durable', async () => {
    await armPendingSubmission('direct', { owner: OWNER, chainId: 1, completesPlan: true, attemptId: 'attempt-1' })
    const working = globalThis.localStorage
    vi.stubGlobal('localStorage', submittedWriteRefusingStorage(working))

    try {
      // The wallet already returned the hash — silently keeping a hashless
      // armed record would let a manual release dismiss a mined transaction.
      await expect(upgradePendingSubmissionToSubmitted('direct', upgradeInput('attempt-1')))
        .rejects.toThrow('could not durably record its id')
    }
    finally {
      vi.stubGlobal('localStorage', working)
    }
    expect(readPendingSubmission('direct', OWNER, 1)).toMatchObject({
      phase: 'armed',
      attemptId: 'attempt-1',
      observedId: { kind: 'transaction', hash: TX_HASH },
    })
  })

  it('after a failed upgrade the preserved id blocks re-arming and manual release, and verifies objectively', async () => {
    await armPendingSubmission('direct', { owner: OWNER, chainId: 1, completesPlan: true, attemptId: 'attempt-1' })
    const working = globalThis.localStorage
    vi.stubGlobal('localStorage', submittedWriteRefusingStorage(working))
    try {
      await expect(upgradePendingSubmissionToSubmitted('direct', upgradeInput('attempt-1')))
        .rejects.toThrow(PendingSubmissionStorageError)
    }
    finally {
      vi.stubGlobal('localStorage', working)
    }
    // The observedId record was written durably, which drops the in-realm
    // copy — everything below therefore behaves exactly as after a reload.

    // A fresh attempt cannot take over the reservation.
    await expect(armPendingSubmission('direct', { owner: OWNER, chainId: 1, completesPlan: true, attemptId: 'attempt-2' }))
      .rejects.toThrow(PendingSubmissionConflictError)
    // The hashless manual-release path refuses it, and the recovery listing
    // never offers it.
    await expect(releaseUnverifiablePendingSubmission('direct', OWNER, 1, { userConfirmedWalletShowsNoPendingSubmission: true }))
      .rejects.toThrow('cannot be dismissed')
    expect(listReleasableArmedSubmissions(['direct'])).toEqual([])
    // Reconciliation verifies the record through the observed hash like any
    // submitted record.
    const stored = readPendingSubmission('direct', OWNER, 1)
    const provider = {
      getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    }
    await expect(resolvePendingSubmissionOutcome(stored as PendingSubmissionRecord, {
      provider: provider as never,
      getSafeWalletProvider: vi.fn(),
    })).resolves.toBe('landed')
    expect(provider.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX_HASH })
  })

  it('refuses the hashless manual release even when the id could only be kept in memory', async () => {
    await armPendingSubmission('direct', { owner: OWNER, chainId: 1, completesPlan: true, attemptId: 'attempt-1' })
    const working = globalThis.localStorage
    vi.stubGlobal('localStorage', {
      get length() {
        return working.length
      },
      clear: () => working.clear(),
      key: (index: number) => working.key(index),
      getItem: (key: string) => working.getItem(key),
      removeItem: (key: string) => working.removeItem(key),
      setItem: () => {
        throw new Error('quota exceeded')
      },
    })

    try {
      await expect(upgradePendingSubmissionToSubmitted('direct', upgradeInput('attempt-1')))
        .rejects.toThrow('could not durably record its id')
      // The durable record still looks hashless-armed — only the in-realm
      // copy carries the observed id — yet the release must still refuse.
      expect(readPendingSubmission('direct', OWNER, 1)).toMatchObject({ phase: 'armed', attemptId: 'attempt-1' })
      await expect(releaseUnverifiablePendingSubmission('direct', OWNER, 1, { userConfirmedWalletShowsNoPendingSubmission: true }))
        .rejects.toThrow('cannot be dismissed')
      expect(readPendingSubmission('direct', OWNER, 1)).toBeDefined()
    }
    finally {
      vi.stubGlobal('localStorage', working)
    }
  })
})

describe('listReleasableArmedSubmissions', () => {
  it('lists an armed record whose owning attempt is no longer live', () => {
    writePendingSubmission('batch', { ...armedRecord(), attemptId: 'gone-attempt' })

    expect(listReleasableArmedSubmissions(['batch'])).toEqual([{
      flow: 'batch',
      chainId: 1,
      owner: OWNER,
      state: 'armed',
      record: expect.objectContaining({ phase: 'armed', attemptId: 'gone-attempt' }),
    }])
  })

  it('never offers records that are live, submitted, or carry an observed id', () => {
    registerActiveSubmissionAttempt('live-attempt')
    try {
      // Live attempt: its wallet prompt may be open right now.
      writePendingSubmission('batch', { ...armedRecord(), attemptId: 'live-attempt' })
      // Submitted: has an id, resolves objectively.
      writePendingSubmission('direct', record())
      // Armed with an observed id: the failed-upgrade case, also objective.
      writePendingSubmission('outgoing-migration', {
        ...armedRecord(),
        attemptId: 'gone-attempt',
        observedId: { kind: 'transaction', hash: TX_HASH },
      } as PendingSubmissionRecord)

      expect(listReleasableArmedSubmissions(['batch', 'direct', 'outgoing-migration'])).toEqual([])
    }
    finally {
      unregisterActiveSubmissionAttempt('live-attempt')
    }
  })

  it('reports an unparseable entry as corrupt so recovery can offer the acknowledged release', () => {
    localStorage.setItem(BATCH_KEY, 'not json')

    expect(listReleasableArmedSubmissions(['batch'])).toEqual([{
      flow: 'batch',
      chainId: 1,
      owner: OWNER,
      state: 'corrupt',
    }])
  })
})

describe('releasePendingSubmission', () => {
  it('releases the attempt\'s own record', async () => {
    await armPendingSubmission('direct', { owner: OWNER, chainId: 1, completesPlan: true, attemptId: 'attempt-1' })

    await expect(releasePendingSubmission('direct', OWNER, 1, { attemptId: 'attempt-1' })).resolves.toBe(true)
    expect(readPendingSubmission('direct', OWNER, 1)).toBeUndefined()
  })

  it('is a no-op for a stale completion after another attempt reserved anew', async () => {
    // Tab A armed, tab B took over the key with a fresh reservation; tab A's
    // terminal callback must not delete tab B's record.
    writePendingSubmission('direct', { ...armedRecord(), attemptId: 'attempt-b' })

    await expect(releasePendingSubmission('direct', OWNER, 1, { attemptId: 'attempt-a' })).resolves.toBe(false)
    expect(readPendingSubmission('direct', OWNER, 1)).toMatchObject({ attemptId: 'attempt-b' })
  })

  it('keeps an unreadable record blocking — ownership is unprovable', async () => {
    localStorage.setItem(`euler_pending_submission:direct:1:${OWNER}`, 'not json')

    await expect(releasePendingSubmission('direct', OWNER, 1, { attemptId: 'attempt-1' })).resolves.toBe(false)
    expect(localStorage.getItem(`euler_pending_submission:direct:1:${OWNER}`)).toBe('not json')
  })
})

describe('releaseUnverifiablePendingSubmission', () => {
  const acknowledgement = { userConfirmedWalletShowsNoPendingSubmission: true as const }

  it('releases an armed record after the user checked the wallet', async () => {
    writePendingSubmission('batch', { ...armedRecord(), attemptId: 'gone' })

    await expect(releaseUnverifiablePendingSubmission('batch', OWNER, 1, acknowledgement)).resolves.toBe(true)
    expect(readPendingSubmission('batch', OWNER, 1)).toBeUndefined()
  })

  it('releases a corrupt record after the user checked the wallet', async () => {
    localStorage.setItem(BATCH_KEY, 'not json')

    await expect(releaseUnverifiablePendingSubmission('batch', OWNER, 1, acknowledgement)).resolves.toBe(true)
    expect(localStorage.getItem(BATCH_KEY)).toBeNull()
  })

  it('refuses to dismiss a submitted record — it has an id and can still confirm', async () => {
    writePendingSubmission('batch', record())

    await expect(releaseUnverifiablePendingSubmission('batch', OWNER, 1, acknowledgement))
      .rejects.toThrow('verified automatically and cannot be dismissed')
    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record())
  })

  it('reports false when nothing is quarantined', async () => {
    await expect(releaseUnverifiablePendingSubmission('batch', OWNER, 1, acknowledgement)).resolves.toBe(false)
  })
})

describe('createPendingSubmissionAttemptId', () => {
  it('produces a distinct id per attempt', () => {
    expect(createPendingSubmissionAttemptId()).not.toBe(createPendingSubmissionAttemptId())
  })
})

describe('walletNeverAcceptedSubmission', () => {
  it.each([
    ['EIP-1193 user rejection code', { code: 4001 }],
    ['viem user rejection', { name: 'UserRejectedRequestError' }],
    ['connector not connected', { name: 'ConnectorNotConnectedError' }],
    ['nested cause chain', new Error('outer', { cause: { cause: { code: 4001 } } })],
  ])('recognizes a provable non-acceptance (%s)', (_label, error) => {
    expect(walletNeverAcceptedSubmission(error)).toBe(true)
  })

  it.each([
    ['plain error', new Error('Failed to fetch')],
    ['timeout-ish error', { name: 'TimeoutError', code: -32603 }],
    ['malformed response', new Error('Safe wallet returned an unexpected call bundle id.')],
    ['nothing', undefined],
  ])('treats anything else as possibly accepted (%s)', (_label, error) => {
    expect(walletNeverAcceptedSubmission(error)).toBe(false)
  })
})

describe('resolvePendingSubmissionOutcome', () => {
  const getSafeWalletProvider = vi.fn()

  it('always stays unknown for an armed record — there is no id to verify', async () => {
    const provider = {
      getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    }

    await expect(resolvePendingSubmissionOutcome(armedRecord(), {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
    expect(provider.getTransactionReceipt).not.toHaveBeenCalled()
  })

  it('stays unknown without a provider to verify against', async () => {
    await expect(resolvePendingSubmissionOutcome(record(), {
      provider: undefined,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
  })

  it.each([
    ['success', 'landed'],
    ['reverted', 'not-landed'],
  ] as const)('maps a %s transaction receipt to %s', async (status, expected) => {
    const provider = {
      getTransactionReceipt: vi.fn(async () => ({ status })),
    }

    await expect(resolvePendingSubmissionOutcome(record(), {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe(expected)
    expect(provider.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX_HASH })
  })

  it('stays unknown when the transaction has no receipt yet', async () => {
    // No receipt covers both a pending transaction and a dropped one that a
    // mempool copy could still re-broadcast — neither is a terminal verdict.
    const provider = {
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('receipt not found')
      }),
    }

    await expect(resolvePendingSubmissionOutcome(record(), {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
  })

  const proposal = record({ kind: 'proposal', hash: SAFE_TX_HASH })
  const provider = { getTransactionReceipt: vi.fn() }

  it('stays unknown when no Safe provider can be acquired', async () => {
    getSafeWalletProvider.mockResolvedValueOnce(undefined)

    await expect(resolvePendingSubmissionOutcome(proposal, {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
    expect(safeMocks.waitForSafeTransactionExecution).not.toHaveBeenCalled()
  })

  it('stays unknown when Safe provider acquisition throws', async () => {
    getSafeWalletProvider.mockRejectedValueOnce(new Error('no session'))

    await expect(resolvePendingSubmissionOutcome(proposal, {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
  })

  it.each([
    ['success', 'landed'],
    ['reverted', 'not-landed'],
  ] as const)('maps a %s Safe execution receipt to %s', async (status, expected) => {
    getSafeWalletProvider.mockResolvedValueOnce({ request: vi.fn() })
    safeMocks.waitForSafeTransactionExecution.mockResolvedValueOnce({
      hash: SAFE_TX_HASH,
      receipt: { status },
    })

    await expect(resolvePendingSubmissionOutcome(proposal, {
      provider: provider as never,
      getSafeWalletProvider,
      safeStatusTimeoutMs: 5_000,
    })).resolves.toBe(expected)
    expect(safeMocks.waitForSafeTransactionExecution).toHaveBeenCalledWith(expect.objectContaining({
      submittedHash: SAFE_TX_HASH,
      timeoutMs: 5_000,
    }))
  })

  it.each([
    ['Safe transaction was cancelled', 'not-landed'],
    ['Safe transaction failed', 'not-landed'],
    ['network exploded', 'unknown'],
  ] as const)('maps a "%s" Safe status error to %s', async (message, expected) => {
    getSafeWalletProvider.mockResolvedValueOnce({ request: vi.fn() })
    safeMocks.waitForSafeTransactionExecution.mockRejectedValueOnce(new Error(message))

    await expect(resolvePendingSubmissionOutcome(proposal, {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe(expected)
  })

  it('stays unknown while the Safe status itself is unknown', async () => {
    getSafeWalletProvider.mockResolvedValueOnce({ request: vi.fn() })
    safeMocks.waitForSafeTransactionExecution.mockRejectedValueOnce(
      new SafeTransactionStatusUnknownError(SAFE_TX_HASH, 'timeout'),
    )

    await expect(resolvePendingSubmissionOutcome(proposal, {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
  })
})
