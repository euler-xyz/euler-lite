import { ref } from 'vue'
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hash, type Hex, type TransactionReceipt } from 'viem'
import type { MigrationAuthorizationRequest, TransactionMigrationAuthorizationRequest, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAccount } from '@wagmi/vue/actions'
import { getEulerSdkForChain, getEulerSdkFresh } from '~/composables/useEulerSdk'
import { SAFE_REVIEW_APPROVALS_CHANGED_ERROR, useEulerTx } from '~/composables/useEulerTx'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'
import { WalletExecutionContextChangedError } from '~/utils/walletExecutionContext'
import { getPendingSafeSubmissionKind, getPreparedBatchFingerprint, loadPendingSafeBatchSubmissions, PENDING_SAFE_BATCH_STORAGE_KEY, SAFE_SUBMISSION_STORAGE_INVALID_ERROR, savePendingSafeBatchSubmissions } from '~/utils/pending-safe-batch-submission'
import { markReviewedSafeExecutionRequired } from '~/utils/reviewed-execution'

const wagmiMocks = vi.hoisted(() => ({
  sendTransactionAsync: vi.fn(),
  signTypedDataAsync: vi.fn(),
  sendCalls: vi.fn(),
  config: {},
}))

vi.mock('@wagmi/vue', () => ({
  useConfig: () => wagmiMocks.config,
  useSendTransaction: () => ({ sendTransactionAsync: wagmiMocks.sendTransactionAsync }),
  useSignTypedData: () => ({ signTypedDataAsync: wagmiMocks.signTypedDataAsync }),
}))

vi.mock('@wagmi/vue/actions', () => ({
  getAccount: vi.fn(),
  sendCalls: wagmiMocks.sendCalls,
}))

vi.mock('~/composables/useEulerSdk', () => ({
  buildSubgraphProxyApiPath: vi.fn(),
  getEulerSdkForChain: vi.fn(),
  getEulerSdkFresh: vi.fn(),
}))

const serializedLocks = () => {
  let tail = Promise.resolve()
  return {
    request: vi.fn(<T>(_name: string, _options: LockOptions, callback: () => T | Promise<T>) => {
      const result = tail.then(callback, callback)
      tail = result.then(() => undefined, () => undefined)
      return result
    }),
  }
}

const OWNER = getAddress('0x1000000000000000000000000000000000000000')
const OTHER_OWNER = getAddress('0x2000000000000000000000000000000000000000')
const TOKEN = getAddress('0x3000000000000000000000000000000000000000')
const SWAP_VERIFIER = getAddress('0x4000000000000000000000000000000000000000')
const GRANT_HASH = `0x${'11'.repeat(32)}` as Hash

const authorizationRequest = {
  kind: 'transaction',
  connectorId: 'aave',
  protocol: 'Aave V3',
  chainId: 1,
  owner: OWNER,
  call: {
    to: TOKEN,
    abi: erc20Abi,
    functionName: 'approve',
    args: [SWAP_VERIFIER, 1000n],
  },
  revocation: {
    to: TOKEN,
    abi: erc20Abi,
    functionName: 'approve',
    args: [SWAP_VERIFIER, 0n],
  },
} as unknown as TransactionMigrationAuthorizationRequest

const typedAuthorizationRequest: Extract<MigrationAuthorizationRequest, { kind: 'typedData' }> = {
  kind: 'typedData',
  connectorId: 'aave',
  protocol: 'Aave V3',
  chainId: 1,
  owner: OWNER,
  typedData: {
    domain: {},
    types: {},
    primaryType: 'Authorization',
    message: {},
  },
}

describe('useEulerTx migration authorization cleanup', () => {
  let currentAccount = OWNER
  let currentChainId = 1
  let walletAddress = ref<Address | undefined>(OWNER)
  let walletChainId = ref<number | undefined>(1)
  let addressesChainId = ref<number | undefined>(1)

  beforeEach(() => {
    vi.clearAllMocks()
    currentAccount = OWNER
    currentChainId = 1
    walletAddress = ref(OWNER)
    walletChainId = ref(1)
    addressesChainId = ref(1)

    vi.stubGlobal('useWagmi', () => ({ address: walletAddress, chainId: walletChainId }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false), spyAddress: ref(undefined) }))
    vi.stubGlobal('useSignaturePreference', () => ({ signaturesEnabled: ref(true) }))
    vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet: ref(false), isSafeWalletResolved: ref(true) }))
    vi.stubGlobal('usePortfolioRefresh', () => ({ triggerPortfolioRefresh: vi.fn() }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: addressesChainId }))
    vi.stubGlobal('navigator', { locks: serializedLocks() })

    vi.mocked(getAccount).mockImplementation(() => ({
      address: currentAccount,
      chainId: currentChainId,
      connector: undefined,
    }) as never)
    wagmiMocks.sendTransactionAsync.mockResolvedValue(GRANT_HASH)

    const provider = {
      waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => ({
        transactionHash: hash,
        status: 'success',
      }) as TransactionReceipt),
    }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
    } as never)
  })

  it.each([
    ['account', () => {
      walletAddress.value = OTHER_OWNER
      currentAccount = OTHER_OWNER
    }],
    ['chain', () => {
      walletChainId.value = 8453
      addressesChainId.value = 8453
      currentChainId = 8453
    }],
  ] as const)('does not retarget a prepared grant after %s drift', async (kind, driftWallet) => {
    const { executeMigrationAuthorizationGrants } = useEulerTx()
    const revokes: MigrationAuthorizationRevoke[] = []
    driftWallet()

    await expect(executeMigrationAuthorizationGrants(authorizationRequest, revokes))
      .rejects.toMatchObject({ name: WalletExecutionContextChangedError.name, kind })
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
    expect(revokes).toEqual([])
  })

  it.each([
    ['account', () => { currentAccount = OTHER_OWNER }],
    ['chain', () => { currentChainId = 8453 }],
  ] as const)('does not sign a reviewed migration authorization after %s drift', async (kind, driftWallet) => {
    const { signMigrationAuthorization } = useEulerTx()
    driftWallet()

    await expect(signMigrationAuthorization(typedAuthorizationRequest))
      .rejects.toMatchObject({ name: WalletExecutionContextChangedError.name, kind })
    expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('pins a reviewed migration authorization signature to its owner', async () => {
    wagmiMocks.signTypedDataAsync.mockResolvedValue(`0x${'33'.repeat(65)}`)
    const { signMigrationAuthorization } = useEulerTx()

    await signMigrationAuthorization(typedAuthorizationRequest)

    expect(wagmiMocks.signTypedDataAsync).toHaveBeenCalledWith({
      ...typedAuthorizationRequest.typedData,
      account: OWNER,
    })
  })

  it('prepares the transaction plan with the caller-pinned signature mode', async () => {
    const prepare = vi.fn().mockResolvedValue({ kind: 'prepared' })
    vi.mocked(getEulerSdkForChain).mockResolvedValue({
      executionService: { prepareTransactionPlan: prepare },
    } as never)
    const { prepareTransactionPlan } = useEulerTx()

    await prepareTransactionPlan([] as TransactionPlan, { usePermit2: false })

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ usePermit2: false }))
  })

  it('prepares without Permit2 while Safe classification is unresolved', async () => {
    vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet: ref(false), isSafeWalletResolved: ref(false) }))
    const prepare = vi.fn().mockResolvedValue({ kind: 'prepared' })
    vi.mocked(getEulerSdkForChain).mockResolvedValue({
      executionService: { prepareTransactionPlan: prepare },
    } as never)
    const { prepareTransactionPlan } = useEulerTx()

    await prepareTransactionPlan([] as TransactionPlan, { usePermit2: true })

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ usePermit2: false }))
  })

  it.each([
    ['account', () => { currentAccount = OTHER_OWNER }],
    ['chain', () => { currentChainId = 8453 }],
  ] as const)('does not start raw reviewed execution after %s drift', async (kind, driftWallet) => {
    const { executePlan } = useEulerTx()
    driftWallet()

    await expect(executePlan([], { account: OWNER, chainId: 1 }))
      .rejects.toMatchObject({ name: WalletExecutionContextChangedError.name, kind })
    expect(getEulerSdkFresh).not.toHaveBeenCalled()
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it('does not broadcast a reviewed migration after account drift', async () => {
    const executePreparedTransactionPlan = vi.fn(async ({ sendTransaction }: {
      sendTransaction: (tx: { to: Address, data: Hex }) => Promise<Hash>
    }) => {
      await sendTransaction({ to: TOKEN, data: '0x1234' })
      return { receipts: [] }
    })
    const provider = { waitForTransactionReceipt: vi.fn() }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const { executePreparedPlan } = useEulerTx()
    const prepared = {
      __prepared: true,
      plan: [],
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared
    walletAddress.value = OTHER_OWNER
    currentAccount = OTHER_OWNER

    await expect(executePreparedPlan(prepared))
      .rejects.toMatchObject({ name: WalletExecutionContextChangedError.name, kind: 'account' })
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it.each([
    ['account', () => { currentAccount = OTHER_OWNER }],
    ['chain', () => { currentChainId = 8453 }],
  ] as const)('does not sign prepared typed data after %s drift', async (kind, driftWallet) => {
    const executePreparedTransactionPlan = vi.fn(async ({ signTypedData }: {
      signTypedData: (typedData: Record<string, unknown>) => Promise<Hex>
    }) => {
      driftWallet()
      await signTypedData({ domain: {}, types: {}, primaryType: 'Permit', message: {} })
      return { receipts: [] }
    })
    const provider = { waitForTransactionReceipt: vi.fn() }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const { executePreparedPlan } = useEulerTx()
    const prepared = {
      __prepared: true,
      plan: [],
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared

    await expect(executePreparedPlan(prepared))
      .rejects.toMatchObject({ name: WalletExecutionContextChangedError.name, kind })
    expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('pins prepared typed-data signing to the reviewed account', async () => {
    const signature = `0x${'22'.repeat(65)}` as Hex
    wagmiMocks.signTypedDataAsync.mockResolvedValue(signature)
    const typedData = { domain: {}, types: {}, primaryType: 'Permit', message: {} }
    const executePreparedTransactionPlan = vi.fn(async ({ signTypedData }: {
      signTypedData: (value: typeof typedData) => Promise<Hex>
    }) => {
      await signTypedData(typedData)
      return { receipts: [] }
    })
    const provider = { waitForTransactionReceipt: vi.fn() }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const { executePreparedPlan } = useEulerTx()
    const prepared = {
      __prepared: true,
      plan: [],
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared

    await expect(executePreparedPlan(prepared)).resolves.toBeDefined()
    expect(wagmiMocks.signTypedDataAsync).toHaveBeenCalledWith({
      ...typedData,
      account: OWNER,
    })
  })

  it.each([
    ['account', () => { currentAccount = OTHER_OWNER }],
    ['chain', () => { currentChainId = 8453 }],
  ] as const)('does not send a direct revoke after %s drift', async (_kind, driftWallet) => {
    const { executeMigrationAuthorizationGrants, sendMigrationAuthorizationRevokes } = useEulerTx()
    const revokes: MigrationAuthorizationRevoke[] = []

    await executeMigrationAuthorizationGrants(authorizationRequest, revokes)
    driftWallet()

    await expect(sendMigrationAuthorizationRevokes(revokes)).resolves.toEqual({
      restored: [],
      failed: revokes,
    })
    expect(wagmiMocks.sendTransactionAsync).toHaveBeenCalledTimes(1)
    expect(revokes).toEqual([{
      transaction: {
        to: TOKEN,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [SWAP_VERIFIER, 0n],
        }),
      },
      walletContext: { account: OWNER, chainId: 1 },
    }])
  })

  it('attempts every revoke and reports partial cleanup', async () => {
    const { sendMigrationAuthorizationRevokes } = useEulerTx()
    const transaction = {
      to: TOKEN,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [SWAP_VERIFIER, 0n],
      }),
    }
    const blocked = {
      transaction,
      walletContext: { account: OTHER_OWNER, chainId: 1 },
    }
    const restorable = {
      transaction,
      walletContext: { account: OWNER, chainId: 1 },
    }

    await expect(sendMigrationAuthorizationRevokes([blocked, restorable])).resolves.toEqual({
      restored: [restorable],
      failed: [blocked],
    })
    expect(wagmiMocks.sendTransactionAsync).toHaveBeenCalledTimes(1)
  })
})

describe('useEulerTx Safe wallet bundling', () => {
  const EVC = getAddress('0x5000000000000000000000000000000000000000')
  const SAFE_TX_HASH = `0x${'22'.repeat(32)}` as Hash
  const APPROVE_DATA = '0x095ea7b3' as Hex
  const BATCH_DATA = '0xabcdef' as Hex

  let currentAccount = OWNER
  let currentChainId = 1
  let executePreparedTransactionPlan: ReturnType<typeof vi.fn>
  let safeStorageValues: Map<string, string>

  const safeConnector = {
    id: 'safe',
    name: 'Safe',
    getProvider: async () => ({ request: vi.fn() }),
  }

  const approvedPlan = [
    {
      type: 'requiredApproval',
      token: TOKEN,
      owner: OWNER,
      spender: SWAP_VERIFIER,
      amount: 100n,
      resolved: [{
        type: 'approve',
        token: TOKEN,
        owner: OWNER,
        spender: SWAP_VERIFIER,
        amount: 100n,
        data: APPROVE_DATA,
      }],
    },
    {
      type: 'evcBatch',
      items: [{ targetContract: SWAP_VERIFIER, onBehalfOfAccount: OWNER, value: 0n, data: '0x01' }],
    },
  ] as unknown as TransactionPlan

  const buildPrepared = (plan: TransactionPlan, usePermit2 = false) => ({
    __prepared: true,
    plan,
    chainId: 1,
    account: OWNER,
    usePermit2,
    unlimitedApproval: false,
  }) as TransactionPlanPrepared

  beforeEach(() => {
    vi.clearAllMocks()
    currentAccount = OWNER
    currentChainId = 1
    safeStorageValues = new Map()

    vi.stubGlobal('useWagmi', () => ({ address: ref(OWNER), chainId: ref(1) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false), spyAddress: ref(undefined) }))
    vi.stubGlobal('useSignaturePreference', () => ({ signaturesEnabled: ref(false) }))
    vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet: ref(true), isSafeWalletResolved: ref(true) }))
    vi.stubGlobal('usePortfolioRefresh', () => ({ triggerPortfolioRefresh: vi.fn() }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('navigator', { locks: serializedLocks() })
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => safeStorageValues.get(key) ?? null,
        setItem: (key: string, value: string) => safeStorageValues.set(key, value),
        removeItem: (key: string) => safeStorageValues.delete(key),
      },
    })

    vi.mocked(getAccount).mockImplementation(() => ({
      address: currentAccount,
      chainId: currentChainId,
      connector: safeConnector,
    }) as never)

    wagmiMocks.sendCalls.mockResolvedValue({ id: SAFE_TX_HASH })
    executePreparedTransactionPlan = vi.fn(async () => ({ receipts: [] }))

    const provider = {
      getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => ({
        transactionHash: hash,
        status: 'success',
        blockNumber: 123n,
      }) as TransactionReceipt),
      waitForTransactionReceipt: vi.fn(),
    }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      deploymentService: { getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: EVC } } })) },
      executionService: {
        encodeBatch: vi.fn(() => BATCH_DATA),
        executePreparedTransactionPlan,
      },
    } as never)
  })

  it('submits approve + EVC batch as one Safe call bundle', async () => {
    const { executePreparedPlan } = useEulerTx()

    const result = await executePreparedPlan(buildPrepared(approvedPlan))

    expect(wagmiMocks.sendCalls).toHaveBeenCalledTimes(1)
    expect(wagmiMocks.sendCalls).toHaveBeenCalledWith(wagmiMocks.config, {
      account: OWNER,
      chainId: 1,
      // Submission is pinned to the connector whose provider was identified
      // as Safe, so a concurrent connector switch cannot reroute the bundle.
      connector: safeConnector,
      forceAtomic: true,
      calls: [
        { to: TOKEN, data: APPROVE_DATA, value: 0n },
        { to: EVC, data: BATCH_DATA, value: 0n },
      ],
    })
    expect(result.hashes).toEqual([SAFE_TX_HASH])
    expect(result.receipts[0].transactionHash).toBe(SAFE_TX_HASH)
    // The sequential path never runs: no per-transaction sends.
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it('persists Safe submission state before and immediately after bundled submission', async () => {
    const events: string[] = []
    const { executePreparedPlan } = useEulerTx()

    await executePreparedPlan(buildPrepared(approvedPlan), {
      onSafePreflight: () => {
        expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
        events.push('reserved')
      },
      onSafeSubmission: (submittedHash) => {
        expect(wagmiMocks.sendCalls).toHaveBeenCalledTimes(1)
        expect(submittedHash).toBe(SAFE_TX_HASH)
        events.push('submitted')
      },
    })

    expect(events).toEqual(['reserved', 'submitted'])
  })

  it('durably blocks retry when a direct Safe submission response is lost before its hash', async () => {
    wagmiMocks.sendCalls.mockRejectedValue(new Error('Safe provider response was lost'))
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toThrow('hash was not retained')

    const pending = loadPendingSafeBatchSubmissions(window.localStorage)
    expect(pending).toHaveLength(1)
    expect(getPendingSafeSubmissionKind(pending[0]!)).toBe('operation')
    expect(pending[0]).not.toHaveProperty('submittedHash')

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toThrow('hash was not retained')
    expect(wagmiMocks.sendCalls).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite a direct Safe reservation acquired by another tab after reconciliation', async () => {
    const otherReservation = {
      account: OWNER,
      chainId: 1,
      batchFingerprint: 'fedcba9876543210',
      errorMessage: 'other tab pending',
      grantedRevokes: [],
      submissionKind: 'operation' as const,
    }
    const provider = {
      getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => ({
        transactionHash: hash,
        status: 'success',
        blockNumber: 123n,
      }) as TransactionReceipt),
    }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      deploymentService: { getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: EVC } } })) },
      executionService: {
        encodeBatch: vi.fn(() => {
          savePendingSafeBatchSubmissions(window.localStorage, [otherReservation])
          return BATCH_DATA
        }),
        executePreparedTransactionPlan,
      },
    } as never)
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toThrow('hash was not retained')

    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(loadPendingSafeBatchSubmissions(window.localStorage)).toEqual([otherReservation])
  })

  it.each([
    ['malformed state', () => safeStorageValues.set(PENDING_SAFE_BATCH_STORAGE_KEY, '{')],
    ['unreadable state', () => {
      vi.stubGlobal('window', {
        localStorage: {
          getItem: () => { throw new Error('denied') },
          setItem: vi.fn(),
          removeItem: vi.fn(),
        },
      })
    }],
  ])('blocks direct Safe submission for %s', async (_label, corruptStorage) => {
    corruptStorage()
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toThrow(SAFE_SUBMISSION_STORAGE_INVALID_ERROR)

    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
  })

  it('does not trust a terminal-looking pre-hash provider error', async () => {
    wagmiMocks.sendCalls.mockRejectedValue(new Error('Safe transaction was cancelled'))
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toThrow('hash was not retained')
    expect(loadPendingSafeBatchSubmissions(window.localStorage)).toEqual([
      expect.objectContaining({ submissionKind: 'operation' }),
    ])
  })

  it('persists a direct Safe hash until execution reaches a terminal receipt', async () => {
    let resolveReceipt: ((receipt: TransactionReceipt) => void) | undefined
    const provider = {
      getTransactionReceipt: vi.fn(() => new Promise<TransactionReceipt>((resolve) => {
        resolveReceipt = resolve
      })),
    }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      deploymentService: { getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: EVC } } })) },
      executionService: {
        encodeBatch: vi.fn(() => BATCH_DATA),
        executePreparedTransactionPlan,
      },
    } as never)
    const { executePreparedPlan } = useEulerTx()

    const execution = executePreparedPlan(buildPrepared(approvedPlan))
    await vi.waitFor(() => expect(resolveReceipt).toBeTypeOf('function'))

    expect(loadPendingSafeBatchSubmissions(window.localStorage)).toEqual([
      expect.objectContaining({ submittedHash: SAFE_TX_HASH, submissionKind: 'operation' }),
    ])

    resolveReceipt?.({
      transactionHash: SAFE_TX_HASH,
      status: 'success',
      blockNumber: 123n,
    } as TransactionReceipt)
    await execution
    expect(loadPendingSafeBatchSubmissions(window.localStorage)).toEqual([])
  })

  it('reconciles a persisted direct Safe hash before allowing another submission', async () => {
    const prepared = buildPrepared(approvedPlan)
    savePendingSafeBatchSubmissions(window.localStorage, [{
      account: OWNER,
      chainId: 1,
      batchFingerprint: getPreparedBatchFingerprint(prepared),
      errorMessage: 'pending',
      grantedRevokes: [],
      submissionKind: 'operation',
      submittedHash: SAFE_TX_HASH,
    }])
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(prepared))
      .rejects.toThrow('prior Safe operation executed')

    expect(loadPendingSafeBatchSubmissions(window.localStorage)).toEqual([])
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
  })

  it('falls back to sequential execution for single-call plans', async () => {
    const { executePreparedPlan } = useEulerTx()
    const batchOnly = [approvedPlan[1]] as TransactionPlan

    const reviewed = buildPrepared(batchOnly, true)
    await executePreparedPlan(reviewed)

    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).toHaveBeenCalledTimes(1)
    // The consent-bearing envelope is never rewritten inside execution. With
    // no Permit2 item in the prepared plan, the option bit is inert.
    expect(executePreparedTransactionPlan.mock.calls[0][0].prepared).toBe(reviewed)
  })

  it('invalidates a late-classified Safe review instead of repairing it to one call', async () => {
    const permitPrepared = buildPrepared([
      {
        ...approvedPlan[0],
        resolved: [{ type: 'permit2', token: TOKEN, amount: 100n, owner: OWNER, spender: SWAP_VERIFIER }],
      },
      approvedPlan[1],
    ] as unknown as TransactionPlan)
    const resolveRequiredApprovals = vi.fn(async () => approvedPlan)
    const provider = { getTransactionReceipt: vi.fn() }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      deploymentService: { getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: EVC } } })) },
      executionService: {
        encodeBatch: vi.fn(() => BATCH_DATA),
        resolveRequiredApprovals,
        executePreparedTransactionPlan,
      },
    } as never)
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(permitPrepared))
      .rejects.toThrow(SAFE_REVIEW_APPROVALS_CHANGED_ERROR)

    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(resolveRequiredApprovals).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
  })

  it('does not submit a bundle after account drift', async () => {
    const { executePreparedPlan } = useEulerTx()
    currentAccount = OTHER_OWNER

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toMatchObject({ name: WalletExecutionContextChangedError.name, kind: 'account' })
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
  })

  it('retains the preflight lock when Safe returns an unusable bundle id', async () => {
    wagmiMocks.sendCalls.mockResolvedValue({ id: 'bundle-1' })
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toThrow('hash was not retained')
    expect(loadPendingSafeBatchSubmissions(window.localStorage)).toEqual([
      expect.objectContaining({ submissionKind: 'operation' }),
    ])
  })

  it('throws on a mined-but-reverted Safe bundle instead of finalizing it', async () => {
    const provider = {
      getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => ({
        transactionHash: hash,
        status: 'reverted',
        blockNumber: 123n,
      }) as TransactionReceipt),
    }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      deploymentService: { getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: EVC } } })) },
      executionService: {
        encodeBatch: vi.fn(() => BATCH_DATA),
        executePreparedTransactionPlan,
      },
    } as never)
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toThrow('Safe transaction reverted')
    // The sequential path must not run after the bundle already executed.
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
  })

  it('does not replace reviewed Permit2 rows with approval writes during Safe execution', async () => {
    const permitPrepared = buildPrepared([
      {
        ...approvedPlan[0],
        resolved: [{ type: 'permit2', token: TOKEN, amount: 100n, owner: OWNER, spender: SWAP_VERIFIER }],
      },
      approvedPlan[1],
    ] as unknown as TransactionPlan)
    const resolveRequiredApprovals = vi.fn(async () => approvedPlan)
    const provider = {
      getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => ({
        transactionHash: hash,
        status: 'success',
        blockNumber: 123n,
      }) as TransactionReceipt),
    }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      deploymentService: { getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: EVC } } })) },
      executionService: {
        encodeBatch: vi.fn(() => BATCH_DATA),
        resolveRequiredApprovals,
        executePreparedTransactionPlan,
      },
    } as never)
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(permitPrepared))
      .rejects.toThrow(SAFE_REVIEW_APPROVALS_CHANGED_ERROR)

    expect(resolveRequiredApprovals).not.toHaveBeenCalled()
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('fails closed for a reviewed WalletConnect Safe bundle when its provider is unavailable', async () => {
    // Provider loss prevents WalletConnect from identifying the peer as Safe,
    // so the requirement must travel with the reviewed envelope.
    const brokenSafeConnector = {
      id: 'walletconnect',
      name: 'WalletConnect',
      getProvider: async () => {
        throw new Error('provider unavailable')
      },
    }
    vi.mocked(getAccount).mockImplementation(() => ({
      address: currentAccount,
      chainId: currentChainId,
      connector: brokenSafeConnector,
    }) as never)
    const { executePreparedPlan } = useEulerTx()

    const reviewed = markReviewedSafeExecutionRequired(buildPrepared(approvedPlan, true))
    await expect(executePreparedPlan(reviewed))
      .rejects.toThrow('Safe connection unavailable')

    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it('fails closed for a reviewed single-call WalletConnect Safe operation when its provider is unavailable', async () => {
    const brokenSafeConnector = {
      id: 'walletconnect',
      name: 'WalletConnect',
      getProvider: async () => {
        throw new Error('provider unavailable')
      },
    }
    vi.mocked(getAccount).mockImplementation(() => ({
      address: currentAccount,
      chainId: currentChainId,
      connector: brokenSafeConnector,
    }) as never)
    const { executePreparedPlan } = useEulerTx()

    const reviewed = markReviewedSafeExecutionRequired(buildPrepared([approvedPlan[1]] as TransactionPlan))
    await expect(executePreparedPlan(reviewed))
      .rejects.toThrow('Safe connection unavailable')

    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it('does not repair and sequentially execute a Safe permit2 envelope without its provider', async () => {
    const brokenSafeConnector = {
      id: 'safe',
      name: 'Safe',
      getProvider: async () => {
        throw new Error('provider unavailable')
      },
    }
    vi.mocked(getAccount).mockImplementation(() => ({
      address: currentAccount,
      chainId: currentChainId,
      connector: brokenSafeConnector,
    }) as never)
    const resolveRequiredApprovals = vi.fn(async () => approvedPlan)
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => ({ getTransactionReceipt: vi.fn() })) },
      deploymentService: { getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: EVC } } })) },
      executionService: {
        encodeBatch: vi.fn(() => BATCH_DATA),
        resolveRequiredApprovals,
        executePreparedTransactionPlan,
      },
    } as never)
    const permitPrepared = buildPrepared([
      {
        ...approvedPlan[0],
        resolved: [{ type: 'permit2', token: TOKEN, amount: 100n, owner: OWNER, spender: SWAP_VERIFIER }],
      },
      approvedPlan[1],
    ] as unknown as TransactionPlan, true)
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(permitPrepared))
      .rejects.toThrow(SAFE_REVIEW_APPROVALS_CHANGED_ERROR)

    expect(resolveRequiredApprovals).not.toHaveBeenCalled()
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
  })

  it('bundles raw plans after resolving approvals through the SDK', async () => {
    const processPlanPlugins = vi.fn(async (plan: TransactionPlan) => plan)
    const resolveRequiredApprovals = vi.fn(async () => approvedPlan)
    const executeTransactionPlan = vi.fn()
    const provider = {
      getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => ({
        transactionHash: hash,
        status: 'success',
        blockNumber: 123n,
      }) as TransactionReceipt),
    }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      deploymentService: { getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: EVC } } })) },
      executionService: {
        encodeBatch: vi.fn(() => BATCH_DATA),
        processPlanPlugins,
        resolveRequiredApprovals,
        executeTransactionPlan,
      },
    } as never)
    const { executePlan } = useEulerTx()

    const result = await executePlan([approvedPlan[0]] as TransactionPlan)

    expect(resolveRequiredApprovals).toHaveBeenCalledWith(expect.objectContaining({ usePermit2: false }))
    expect(wagmiMocks.sendCalls).toHaveBeenCalledTimes(1)
    expect(executeTransactionPlan).not.toHaveBeenCalled()
    expect(result.hashes).toEqual([SAFE_TX_HASH])
  })

  const GRANT_CALL = { to: TOKEN, data: '0x11ff' as Hex, value: 0n }
  const REVOKE_CALL = { to: TOKEN, data: '0x22ff' as Hex }

  it('wraps the plan with plain calls inside one Safe bundle in order', async () => {
    const { executePreparedPlanWithPlainCalls } = useEulerTx()
    const batchOnly = [approvedPlan[1]] as TransactionPlan

    const result = await executePreparedPlanWithPlainCalls(buildPrepared(batchOnly), {
      before: [GRANT_CALL],
      after: [REVOKE_CALL],
    })

    expect(wagmiMocks.sendCalls).toHaveBeenCalledTimes(1)
    expect(wagmiMocks.sendCalls).toHaveBeenCalledWith(wagmiMocks.config, {
      account: OWNER,
      chainId: 1,
      connector: safeConnector,
      forceAtomic: true,
      calls: [
        // Grants before the batch, revocations after — one atomic proposal.
        { to: TOKEN, data: '0x11ff', value: 0n },
        { to: EVC, data: BATCH_DATA, value: 0n },
        { to: TOKEN, data: '0x22ff', value: 0n },
      ],
    })
    expect(result?.hashes).toEqual([SAFE_TX_HASH])
    expect(result?.receipts[0].transactionHash).toBe(SAFE_TX_HASH)
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
  })

  it('runs persistence hooks for a Safe bundle wrapped with plain calls', async () => {
    const events: string[] = []
    const { executePreparedPlanWithPlainCalls } = useEulerTx()

    await executePreparedPlanWithPlainCalls(buildPrepared([approvedPlan[1]] as TransactionPlan), {
      before: [GRANT_CALL],
      after: [REVOKE_CALL],
    }, {
      allowSingleCall: true,
      onSafePreflight: () => {
        expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
        events.push('reserved')
      },
      onSafeSubmission: (submittedHash) => {
        expect(submittedHash).toBe(SAFE_TX_HASH)
        events.push('submitted')
      },
    })

    expect(events).toEqual(['reserved', 'submitted'])
  })

  it('durably blocks retry when a wrapped Safe submission loses its response before the hash', async () => {
    wagmiMocks.sendCalls.mockRejectedValue(new Error('Safe provider response was lost'))
    const { executePreparedPlanWithPlainCalls } = useEulerTx()
    const prepared = buildPrepared([approvedPlan[1]] as TransactionPlan)
    const extraCalls = { before: [GRANT_CALL], after: [REVOKE_CALL] }

    await expect(executePreparedPlanWithPlainCalls(prepared, extraCalls, { allowSingleCall: true }))
      .rejects.toThrow('hash was not retained')
    expect(loadPendingSafeBatchSubmissions(window.localStorage)).toEqual([
      expect.objectContaining({ submissionKind: 'operation' }),
    ])

    await expect(executePreparedPlanWithPlainCalls(prepared, extraCalls, { allowSingleCall: true }))
      .rejects.toThrow('hash was not retained')
    expect(wagmiMocks.sendCalls).toHaveBeenCalledTimes(1)
  })

  it('rejects wrapper calls around a plan that encodes no calls', async () => {
    const { executePreparedPlanWithPlainCalls } = useEulerTx()

    // A no-op migration must never submit [grant, revoke] alone and
    // finalize as success.
    await expect(executePreparedPlanWithPlainCalls(buildPrepared([] as TransactionPlan), {
      before: [GRANT_CALL],
      after: [REVOKE_CALL],
    })).rejects.toThrow('produced no calls to bundle')
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
  })

  it('returns undefined from the plain-calls bundle for non-Safe connectors', async () => {
    vi.mocked(getAccount).mockImplementation(() => ({
      address: currentAccount,
      chainId: currentChainId,
      connector: { id: 'io.metamask', name: 'MetaMask', getProvider: async () => ({ request: vi.fn() }) },
    }) as never)
    const { executePreparedPlanWithPlainCalls } = useEulerTx()

    const result = await executePreparedPlanWithPlainCalls(buildPrepared([approvedPlan[1]] as TransactionPlan), {
      before: [GRANT_CALL],
      after: [REVOKE_CALL],
    })

    // The caller owns the sequential fallback (grants must mine first).
    expect(result).toBeUndefined()
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
  })

  it('returns undefined from the plain-calls bundle for a Safe without a provider', async () => {
    vi.mocked(getAccount).mockImplementation(() => ({
      address: currentAccount,
      chainId: currentChainId,
      connector: {
        id: 'safe',
        name: 'Safe',
        getProvider: async () => {
          throw new Error('provider unavailable')
        },
      },
    }) as never)
    const { executePreparedPlanWithPlainCalls } = useEulerTx()

    const result = await executePreparedPlanWithPlainCalls(buildPrepared([approvedPlan[1]] as TransactionPlan), {
      before: [GRANT_CALL],
    })

    expect(result).toBeUndefined()
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
  })

  it('throws on a reverted plain-calls bundle instead of finalizing it', async () => {
    const provider = {
      getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => ({
        transactionHash: hash,
        status: 'reverted',
        blockNumber: 123n,
      }) as TransactionReceipt),
    }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      deploymentService: { getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: EVC } } })) },
      executionService: { encodeBatch: vi.fn(() => BATCH_DATA), executePreparedTransactionPlan },
    } as never)
    const { executePreparedPlanWithPlainCalls } = useEulerTx()

    await expect(executePreparedPlanWithPlainCalls(buildPrepared([approvedPlan[1]] as TransactionPlan), {
      before: [GRANT_CALL],
      after: [REVOKE_CALL],
    })).rejects.toThrow('Safe transaction reverted')
  })

  it('passes extra state overrides through prepared simulation', async () => {
    const simulatePreparedTransactionPlan = vi.fn(async () => ({ kind: 'simulated' }))
    const { getEulerSdkForChain } = await import('~/composables/useEulerSdk')
    vi.mocked(getEulerSdkForChain).mockResolvedValue({
      executionService: { simulatePreparedTransactionPlan },
    } as never)
    const { simulatePreparedPlan } = useEulerTx()
    const prepared = buildPrepared([approvedPlan[1]] as TransactionPlan)
    const overrides = [{ address: TOKEN, stateDiff: [] }]

    await simulatePreparedPlan(prepared, undefined, overrides as never)
    expect(simulatePreparedTransactionPlan).toHaveBeenCalledWith(prepared, expect.objectContaining({
      extraStateOverrides: overrides,
    }))

    await simulatePreparedPlan(prepared)
    expect(simulatePreparedTransactionPlan).toHaveBeenLastCalledWith(prepared, expect.not.objectContaining({
      extraStateOverrides: expect.anything(),
    }))
  })
})
