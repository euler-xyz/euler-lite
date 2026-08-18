import { ref } from 'vue'
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hash, type Hex, type TransactionReceipt } from 'viem'
import type { MigrationAuthorizationRequest, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAccount } from '@wagmi/vue/actions'
import { getEulerSdkForChain, getEulerSdkFresh } from '~/composables/useEulerSdk'
import { useEulerTx, type PreparedPlanBroadcast } from '~/composables/useEulerTx'
import { createDirectSubmissionQuarantine } from '~/utils/directSubmissionQuarantine'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'
import { registerLandedBatchSubmissionHandler } from '~/utils/pendingSubmissionGate'
import { readPendingSubmission, resetPendingSubmissionMemoryFallback, writePendingSubmission } from '~/utils/pendingSubmissions'
import { WalletExecutionContextChangedError } from '~/utils/walletExecutionContext'

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
} as unknown as MigrationAuthorizationRequest

const typedAuthorizationRequest = {
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
} as unknown as MigrationAuthorizationRequest

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
    vi.stubGlobal('usePortfolioRefresh', () => ({ triggerPortfolioRefresh: vi.fn() }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: addressesChainId }))

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
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('receipt not found')
      }),
    }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
    } as never)
    // The pending-submission quarantine is module state shared across tests.
    resetPendingSubmissionMemoryFallback()
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

  it('signs through the connector that passed the context check, not the live one', async () => {
    const reviewedConnector = { id: 'io.metamask', name: 'MetaMask' }
    const swappedConnector = { id: 'io.rabby', name: 'Rabby' }
    let activeConnector: unknown = reviewedConnector
    vi.mocked(getAccount).mockImplementation(() => ({
      address: currentAccount,
      chainId: currentChainId,
      connector: activeConnector,
    }) as never)
    wagmiMocks.signTypedDataAsync.mockResolvedValue(`0x${'ab'.repeat(65)}`)
    const { signMigrationAuthorization } = useEulerTx()

    await signMigrationAuthorization(typedAuthorizationRequest, {
      // A connector switch in the check-to-sign gap: the swapped connector
      // was never validated and must not receive the signature request.
      beforeSignature: () => {
        activeConnector = swappedConnector
      },
    })

    expect(wagmiMocks.signTypedDataAsync).toHaveBeenCalledTimes(1)
    expect(wagmiMocks.signTypedDataAsync).toHaveBeenCalledWith(
      expect.objectContaining({ connector: reviewedConnector }),
    )
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

  it('estimates a prepared envelope without rerunning the raw plan pipeline', async () => {
    const estimatePrepared = vi.fn().mockResolvedValue(123n)
    vi.mocked(getEulerSdkForChain).mockResolvedValue({
      executionService: { estimateGasForPreparedTransactionPlan: estimatePrepared },
    } as never)
    const prepared = {
      __prepared: true,
      plan: [],
      chainId: 8453,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared
    const { estimateGasForPreparedPlan } = useEulerTx()

    await expect(estimateGasForPreparedPlan(prepared)).resolves.toBe(123n)

    expect(getEulerSdkForChain).toHaveBeenCalledWith(8453)
    expect(estimatePrepared).toHaveBeenCalledWith(prepared)
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

  it('pins mid-plan typed-data signatures to the connector captured at execution start', async () => {
    const reviewedConnector = { id: 'io.metamask', name: 'MetaMask' }
    const swappedConnector = { id: 'io.rabby', name: 'Rabby' }
    let activeConnector: unknown = reviewedConnector
    vi.mocked(getAccount).mockImplementation(() => ({
      address: currentAccount,
      chainId: currentChainId,
      connector: activeConnector,
    }) as never)
    wagmiMocks.signTypedDataAsync.mockResolvedValue(`0x${'ab'.repeat(65)}`)
    const executePreparedTransactionPlan = vi.fn(async ({ signTypedData }: {
      signTypedData: (typedData: unknown) => Promise<Hex>
    }) => {
      // The wallet switches connectors while the executor is mid-plan; the
      // permit signature must still go to the connector that was validated.
      activeConnector = swappedConnector
      await signTypedData({ domain: {}, types: {}, primaryType: 'PermitSingle', message: {} })
      return { receipts: [] }
    })
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => ({ waitForTransactionReceipt: vi.fn() })) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const { executePreparedPlan } = useEulerTx()

    await executePreparedPlan({
      __prepared: true,
      plan: [],
      chainId: 1,
      account: OWNER,
      usePermit2: true,
      unlimitedApproval: false,
    } as TransactionPlanPrepared)

    expect(wagmiMocks.signTypedDataAsync).toHaveBeenCalledTimes(1)
    expect(wagmiMocks.signTypedDataAsync).toHaveBeenCalledWith(
      expect.objectContaining({ connector: reviewedConnector }),
    )
  })

  it('classifies ordered broadcasts so only the last submission stays unconfirmed on failure', async () => {
    const approvalItem = { type: 'requiredApproval', resolved: [] }
    const evcBatchItem = { type: 'evcBatch', items: [] }
    const plan = [approvalItem, evcBatchItem] as unknown as TransactionPlan
    const executePreparedTransactionPlan = vi.fn(async ({ sendTransaction, onProgress }: {
      sendTransaction: (tx: { to: Address, data: Hex }) => Promise<Hash>
      onProgress: (progress: { status: string, item?: unknown, hash?: Hash }) => void
    }) => {
      // Mirrors the SDK executor contract: a pre-send progress event names
      // the item about to be sent, the receipt is awaited, and the same
      // event re-fires with the confirmed hash before the next send.
      onProgress({ status: 'approval', item: approvalItem })
      const approvalHash = await sendTransaction({ to: TOKEN, data: '0x01' })
      onProgress({ status: 'approval', item: approvalItem, hash: approvalHash })
      onProgress({ status: 'evcBatch', item: evcBatchItem })
      await sendTransaction({ to: TOKEN, data: '0x02' })
      throw new Error('Receipt polling failed.')
    })
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => ({ waitForTransactionReceipt: vi.fn() })) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const { executePreparedPlan } = useEulerTx()
    const broadcasts: PreparedPlanBroadcast[] = []

    await expect(executePreparedPlan({
      __prepared: true,
      plan,
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared, {
      onBroadcast: b => broadcasts.push(b),
    })).rejects.toThrow('Receipt polling failed.')

    // The confirmed approval is retryable history; only the accepted-but-
    // unconfirmed value-moving batch is left ambiguous for quarantine.
    // Every send arms replay protection before crossing the wallet boundary.
    expect(broadcasts).toEqual([
      expect.objectContaining({ item: 'approval', index: 0, completesPlan: false, status: 'armed' }),
      expect.objectContaining({ kind: 'transaction', item: 'approval', index: 0, completesPlan: false, status: 'submitted' }),
      expect.objectContaining({ item: 'approval', index: 0, status: 'confirmed' }),
      expect.objectContaining({ item: 'evcBatch', index: 1, completesPlan: true, status: 'armed' }),
      expect.objectContaining({ kind: 'transaction', item: 'evcBatch', index: 1, completesPlan: true, status: 'submitted' }),
    ])
  })

  it('fires only an armed broadcast when the wallet fails without disproving acceptance', async () => {
    const evcBatchItem = { type: 'evcBatch', items: [] }
    const plan = [evcBatchItem] as unknown as TransactionPlan
    wagmiMocks.sendTransactionAsync.mockRejectedValue(new Error('wallet connection dropped mid-request'))
    const executePreparedTransactionPlan = vi.fn(async ({ sendTransaction, onProgress }: {
      sendTransaction: (tx: { to: Address, data: Hex }) => Promise<Hash>
      onProgress: (progress: { status: string, item?: unknown }) => void
    }) => {
      onProgress({ status: 'evcBatch', item: evcBatchItem })
      await sendTransaction({ to: TOKEN, data: '0x02' })
    })
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => ({
        waitForTransactionReceipt: vi.fn(),
        getTransactionReceipt: vi.fn(async () => {
          throw new Error('receipt not found')
        }),
      })) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const quarantine = createDirectSubmissionQuarantine({
      flow: 'outgoing-migration',
      getSafeWalletProvider: async () => undefined,
    })
    quarantine.begin({ owner: OWNER, chainId: 1 })
    const { executePreparedPlan } = useEulerTx()
    const broadcasts: PreparedPlanBroadcast[] = []
    const prepared = {
      __prepared: true,
      plan,
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared

    await expect(executePreparedPlan(prepared, {
      onBroadcast: (b) => {
        broadcasts.push(b)
        quarantine.track(b)
      },
    })).rejects.toThrow('wallet connection dropped mid-request')

    // No id ever reached onBroadcast and the failure does not prove the
    // wallet rejected the request, so the armed reservation must stand.
    expect(broadcasts).toEqual([
      expect.objectContaining({ item: 'evcBatch', index: 0, completesPlan: true, status: 'armed' }),
    ])
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toMatchObject({ phase: 'armed' })

    // A retry — including one from a fresh session after a reload — is
    // blocked at the executor gate before the wallet is invoked again.
    wagmiMocks.sendTransactionAsync.mockClear()
    await expect(executePreparedPlan(prepared)).rejects.toThrow(
      'handed to the wallet but no transaction id came back',
    )
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).toHaveBeenCalledTimes(1)
  })

  it('releases the armed reservation when the wallet provably rejected the request', async () => {
    const evcBatchItem = { type: 'evcBatch', items: [] }
    const plan = [evcBatchItem] as unknown as TransactionPlan
    wagmiMocks.sendTransactionAsync.mockRejectedValue(
      Object.assign(new Error('User rejected the request.'), { code: 4001 }),
    )
    const executePreparedTransactionPlan = vi.fn(async ({ sendTransaction, onProgress }: {
      sendTransaction: (tx: { to: Address, data: Hex }) => Promise<Hash>
      onProgress: (progress: { status: string, item?: unknown }) => void
    }) => {
      onProgress({ status: 'evcBatch', item: evcBatchItem })
      await sendTransaction({ to: TOKEN, data: '0x02' })
    })
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => ({ waitForTransactionReceipt: vi.fn() })) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const quarantine = createDirectSubmissionQuarantine({
      flow: 'outgoing-migration',
      getSafeWalletProvider: async () => undefined,
    })
    quarantine.begin({ owner: OWNER, chainId: 1 })
    const { executePreparedPlan } = useEulerTx()
    const broadcasts: PreparedPlanBroadcast[] = []
    const prepared = {
      __prepared: true,
      plan,
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared

    await expect(executePreparedPlan(prepared, {
      onBroadcast: (b) => {
        broadcasts.push(b)
        quarantine.track(b)
      },
    })).rejects.toThrow('User rejected the request.')

    expect(broadcasts).toEqual([
      expect.objectContaining({ item: 'evcBatch', index: 0, status: 'armed' }),
      expect.objectContaining({ item: 'evcBatch', index: 0, status: 'rejected' }),
    ])
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()

    // With the reservation released, a retry reaches the wallet again.
    await expect(executePreparedPlan(prepared, {
      onBroadcast: b => quarantine.track(b),
    })).rejects.toThrow('User rejected the request.')
    expect(wagmiMocks.sendTransactionAsync).toHaveBeenCalledTimes(2)
  })

  it('blocks a direct plan while an ambiguous batch submission from this wallet is unresolved', async () => {
    writePendingSubmission('batch', {
      phase: 'armed',
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
      submittedAt: 1_000,
    })
    const executePreparedTransactionPlan = vi.fn()
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => ({
        waitForTransactionReceipt: vi.fn(),
        getTransactionReceipt: vi.fn(async () => {
          throw new Error('receipt not found')
        }),
      })) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan({
      __prepared: true,
      plan: [],
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared)).rejects.toThrow(
      'A previous batch submission was handed to the wallet but no transaction id came back',
    )
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
    // The record must survive the refusal so the conflict stays enforced.
    expect(readPendingSubmission('batch', OWNER, 1)).toBeDefined()
  })

  it('blocks a direct plan while a submitted batch record cannot be verified on-chain', async () => {
    writePendingSubmission('batch', {
      phase: 'submitted',
      kind: 'transaction',
      hash: GRANT_HASH,
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
      submittedAt: 1_000,
    })
    const executePreparedTransactionPlan = vi.fn()
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => ({
        waitForTransactionReceipt: vi.fn(),
        getTransactionReceipt: vi.fn(async () => {
          throw new Error('receipt not found')
        }),
      })) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan({
      __prepared: true,
      plan: [],
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared)).rejects.toThrow('could not be verified yet')
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
    expect(readPendingSubmission('batch', OWNER, 1)).toBeDefined()
  })

  it('does not block a direct plan over another wallet\'s pending submission', async () => {
    writePendingSubmission('batch', {
      phase: 'armed',
      chainId: 1,
      owner: OTHER_OWNER,
      completesPlan: true,
      submittedAt: 1_000,
    })
    const executePreparedTransactionPlan = vi.fn(async () => ({ receipts: [] }))
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => ({
        waitForTransactionReceipt: vi.fn(),
        getTransactionReceipt: vi.fn(async () => {
          throw new Error('receipt not found')
        }),
      })) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const { executePreparedPlan } = useEulerTx()

    await executePreparedPlan({
      __prepared: true,
      plan: [],
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared)

    expect(executePreparedTransactionPlan).toHaveBeenCalledTimes(1)
    expect(readPendingSubmission('batch', OTHER_OWNER, 1)).toBeDefined()
  })

  it('runs the caller freshness guard after async setup and before a plain broadcast', async () => {
    const provider = {
      waitForTransactionReceipt: vi.fn(),
    }
    let resolveSdk!: (sdk: unknown) => void
    const sdkPromise = new Promise<unknown>((resolve) => {
      resolveSdk = resolve
    })
    vi.mocked(getEulerSdkFresh).mockReturnValue(sdkPromise as never)
    let current = true
    const { sendPlainTransactions } = useEulerTx()
    const execution = sendPlainTransactions([{ to: TOKEN, data: '0x1234' }], {
      beforeBroadcast: () => {
        if (!current) throw new Error('review became stale')
      },
    })
    await vi.waitFor(() => expect(getEulerSdkFresh).toHaveBeenCalledTimes(1))

    current = false
    resolveSdk({ providerService: { getProvider: vi.fn(() => provider) } })

    await expect(execution).rejects.toThrow('review became stale')
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
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

    vi.stubGlobal('useWagmi', () => ({ address: ref(OWNER), chainId: ref(1) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false), spyAddress: ref(undefined) }))
    vi.stubGlobal('useSignaturePreference', () => ({ signaturesEnabled: ref(false) }))
    vi.stubGlobal('usePortfolioRefresh', () => ({ triggerPortfolioRefresh: vi.fn() }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))

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
    // The pending-submission quarantine is module state shared across tests.
    resetPendingSubmissionMemoryFallback()
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

  it('reports the Safe bundle as submitted on acceptance and confirmed after its receipt', async () => {
    const { executePreparedPlan } = useEulerTx()
    const broadcasts: PreparedPlanBroadcast[] = []

    await executePreparedPlan(buildPrepared(approvedPlan), {
      onBroadcast: b => broadcasts.push(b),
    })

    expect(broadcasts).toEqual([
      // Replay protection arms before the bundle crosses the wallet boundary.
      expect.objectContaining({ item: 'bundle', index: 0, completesPlan: true, status: 'armed' }),
      expect.objectContaining({ kind: 'proposal', hash: SAFE_TX_HASH, item: 'bundle', completesPlan: true, status: 'submitted' }),
      expect.objectContaining({ kind: 'proposal', hash: SAFE_TX_HASH, item: 'bundle', status: 'confirmed' }),
    ])
  })

  it('falls back to sequential execution for single-call plans', async () => {
    const { executePreparedPlan } = useEulerTx()
    const batchOnly = [approvedPlan[1]] as TransactionPlan

    // usePermit2: true with no permit2 items — the envelope must still be
    // normalized before the sequential fallback runs it for a Safe.
    await executePreparedPlan(buildPrepared(batchOnly, true))

    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).toHaveBeenCalledTimes(1)
    expect(executePreparedTransactionPlan.mock.calls[0][0].prepared.usePermit2).toBe(false)
  })

  it('executes the repaired envelope sequentially when the repair leaves one call', async () => {
    const permitPrepared = buildPrepared([
      {
        ...approvedPlan[0],
        resolved: [{ type: 'permit2', token: TOKEN, amount: 100n, owner: OWNER, spender: SWAP_VERIFIER }],
      },
      approvedPlan[1],
    ] as unknown as TransactionPlan)
    // Allowance turned out sufficient: the repair resolves to no approve
    // calls, leaving only the EVC batch — nothing to bundle.
    const repairedPlan = [
      { ...approvedPlan[0], resolved: [] },
      approvedPlan[1],
    ] as unknown as TransactionPlan
    const resolveRequiredApprovals = vi.fn(async () => repairedPlan)
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

    await executePreparedPlan(permitPrepared)

    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).toHaveBeenCalledTimes(1)
    // The sequential fallback runs the REPAIRED envelope, not the permit2 one.
    const executedPrepared = executePreparedTransactionPlan.mock.calls[0][0].prepared
    expect(executedPrepared.plan).toBe(repairedPlan)
    expect(executedPrepared.usePermit2).toBe(false)
  })

  it('does not submit a bundle after account drift', async () => {
    const { executePreparedPlan } = useEulerTx()
    currentAccount = OTHER_OWNER

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toMatchObject({ name: WalletExecutionContextChangedError.name, kind: 'account' })
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
  })

  it('rejects bundle ids that are not hash-shaped', async () => {
    wagmiMocks.sendCalls.mockResolvedValue({ id: 'bundle-1' })
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toThrow('unexpected call bundle id')
  })

  it('keeps the armed reservation when the Safe returns a malformed bundle id', async () => {
    wagmiMocks.sendCalls.mockResolvedValue({ id: 'bundle-1' })
    const quarantine = createDirectSubmissionQuarantine({
      flow: 'outgoing-migration',
      getSafeWalletProvider: async () => undefined,
    })
    quarantine.begin({ owner: OWNER, chainId: 1 })
    const { executePreparedPlan } = useEulerTx()
    const broadcasts: PreparedPlanBroadcast[] = []

    await expect(executePreparedPlan(buildPrepared(approvedPlan), {
      onBroadcast: (b) => {
        broadcasts.push(b)
        quarantine.track(b)
      },
    })).rejects.toThrow('unexpected call bundle id')

    // The wallet DID respond, so acceptance cannot be ruled out: only the
    // armed event fires (no 'rejected') and the durable reservation stands.
    expect(broadcasts).toEqual([
      expect.objectContaining({ item: 'bundle', index: 0, completesPlan: true, status: 'armed' }),
    ])
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toMatchObject({ phase: 'armed' })

    // A retry — including from a fresh session after a reload — is blocked
    // at the executor gate before the wallet is invoked again.
    wagmiMocks.sendCalls.mockClear()
    await expect(executePreparedPlan(buildPrepared(approvedPlan))).rejects.toThrow(
      'handed to the wallet but no transaction id came back',
    )
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
  })

  it('releases the armed bundle when the Safe wallet provably rejected it', async () => {
    wagmiMocks.sendCalls.mockRejectedValue(
      Object.assign(new Error('User rejected the request.'), { name: 'UserRejectedRequestError' }),
    )
    const quarantine = createDirectSubmissionQuarantine({
      flow: 'outgoing-migration',
      getSafeWalletProvider: async () => undefined,
    })
    quarantine.begin({ owner: OWNER, chainId: 1 })
    const { executePreparedPlan } = useEulerTx()
    const broadcasts: PreparedPlanBroadcast[] = []

    await expect(executePreparedPlan(buildPrepared(approvedPlan), {
      onBroadcast: (b) => {
        broadcasts.push(b)
        quarantine.track(b)
      },
    })).rejects.toThrow('User rejected the request.')

    expect(broadcasts).toEqual([
      expect.objectContaining({ item: 'bundle', index: 0, status: 'armed' }),
      expect.objectContaining({ item: 'bundle', index: 0, status: 'rejected' }),
    ])
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()

    // With the reservation released, a retry reaches the wallet again.
    await expect(executePreparedPlan(buildPrepared(approvedPlan), {
      onBroadcast: b => quarantine.track(b),
    })).rejects.toThrow('User rejected the request.')
    expect(wagmiMocks.sendCalls).toHaveBeenCalledTimes(2)
  })

  it('blocks a Safe bundle while a landed batch record awaits cart reconciliation', async () => {
    // No cart handler is registered yet: the record must be kept so the cart
    // can reconcile it when it next runs.
    writePendingSubmission('batch', {
      phase: 'submitted',
      kind: 'transaction',
      hash: SAFE_TX_HASH,
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
      submittedAt: 1_000,
    })
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan))).rejects.toThrow(
      'Open the batch cart to reconcile',
    )
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(readPendingSubmission('batch', OWNER, 1)).toBeDefined()
  })

  it('retires a landed batch record through the registered cart handler before executing', async () => {
    const handler = vi.fn()
    registerLandedBatchSubmissionHandler(handler)
    writePendingSubmission('batch', {
      phase: 'submitted',
      kind: 'transaction',
      hash: SAFE_TX_HASH,
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
      submittedAt: 1_000,
    })
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan))).rejects.toThrow(
      'the batch cart was reconciled',
    )
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ hash: SAFE_TX_HASH }))
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
  })

  it('clears a landed migration record and demands re-review before executing', async () => {
    writePendingSubmission('outgoing-migration', {
      phase: 'submitted',
      kind: 'transaction',
      hash: SAFE_TX_HASH,
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
      submittedAt: 1_000,
    })
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan))).rejects.toThrow(
      'confirmed on-chain. Review your positions',
    )
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    // Landed migrations are terminal: the record is released after refusal.
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
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

  it('repairs permit2-resolved prepared envelopes before bundling', async () => {
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

    const result = await executePreparedPlan(permitPrepared)

    // The stale permit2 resolution was re-resolved with permit2 off and the
    // repaired plan bundled — no permit2 signature ceremony on a Safe.
    expect(resolveRequiredApprovals).toHaveBeenCalledWith(expect.objectContaining({ usePermit2: false }))
    expect(wagmiMocks.sendCalls).toHaveBeenCalledTimes(1)
    expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
    expect(result.hashes).toEqual([SAFE_TX_HASH])
  })

  it('normalizes the envelope in degraded mode when the Safe provider is unavailable', async () => {
    // Connector identifies as Safe, but getProvider() rejects — no bundle
    // and no status polling are possible, yet permit2 must stay off.
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
    const { executePreparedPlan } = useEulerTx()

    await executePreparedPlan(buildPrepared([approvedPlan[1]] as TransactionPlan, true))

    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(executePreparedTransactionPlan).toHaveBeenCalledTimes(1)
    expect(executePreparedTransactionPlan.mock.calls[0][0].prepared.usePermit2).toBe(false)
  })

  it('repairs permit2 envelopes in degraded mode before sequential execution', async () => {
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

    await executePreparedPlan(permitPrepared)

    // The permit2 resolution is repaired even though no bundle is possible,
    // and the sequential path runs the repaired envelope.
    expect(resolveRequiredApprovals).toHaveBeenCalledWith(expect.objectContaining({ usePermit2: false }))
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
    const executedPrepared = executePreparedTransactionPlan.mock.calls[0][0].prepared
    expect(executedPrepared.plan).toBe(approvedPlan)
    expect(executedPrepared.usePermit2).toBe(false)
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

    const result = await executePreparedPlanWithPlainCalls(buildPrepared(approvedPlan), {
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
        { to: TOKEN, data: APPROVE_DATA, value: 0n },
        { to: EVC, data: BATCH_DATA, value: 0n },
        { to: TOKEN, data: '0x22ff', value: 0n },
      ],
    })
    expect(result?.hashes).toEqual([SAFE_TX_HASH])
    expect(result?.receipts[0].transactionHash).toBe(SAFE_TX_HASH)
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
  })

  it('gates the plain-calls bundle on a conflicting pending submission', async () => {
    writePendingSubmission('batch', {
      phase: 'armed',
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
      submittedAt: 1_000,
    })
    const { executePreparedPlanWithPlainCalls } = useEulerTx()

    await expect(executePreparedPlanWithPlainCalls(buildPrepared(approvedPlan), {
      before: [GRANT_CALL],
      after: [REVOKE_CALL],
    })).rejects.toThrow('handed to the wallet but no transaction id came back')
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
    expect(readPendingSubmission('batch', OWNER, 1)).toBeDefined()
  })

  it('runs the caller freshness guard after Safe provider setup and before submission', async () => {
    let resolveSafeProvider!: (provider: { request: ReturnType<typeof vi.fn> }) => void
    const safeProviderPromise = new Promise<{ request: ReturnType<typeof vi.fn> }>((resolve) => {
      resolveSafeProvider = resolve
    })
    const deferredSafeConnector = {
      id: 'safe',
      name: 'Safe',
      getProvider: vi.fn(() => safeProviderPromise),
    }
    vi.mocked(getAccount).mockImplementation(() => ({
      address: currentAccount,
      chainId: currentChainId,
      connector: deferredSafeConnector,
    }) as never)
    let current = true
    const { executePreparedPlanWithPlainCalls } = useEulerTx()
    const execution = executePreparedPlanWithPlainCalls(
      buildPrepared([approvedPlan[1]] as TransactionPlan),
      { before: [GRANT_CALL], after: [REVOKE_CALL] },
      {
        allowSingleCall: true,
        beforeBroadcast: () => {
          if (!current) throw new Error('review became stale')
        },
      },
    )
    await vi.waitFor(() => expect(deferredSafeConnector.getProvider).toHaveBeenCalledTimes(1))

    current = false
    resolveSafeProvider({ request: vi.fn() })

    await expect(execution).rejects.toThrow('review became stale')
    expect(wagmiMocks.sendCalls).not.toHaveBeenCalled()
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
