import { ref } from 'vue'
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hash, type Hex, type TransactionReceipt } from 'viem'
import { Account, type MigrationAuthorizationRequest, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAccount } from '@wagmi/vue/actions'
import { getEulerSdkForChain, getEulerSdkFresh } from '~/composables/useEulerSdk'
import { isSuccessfulTransactionReceipt, useEulerTx } from '~/composables/useEulerTx'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'
import { loadPendingSafeBundleSubmissions, reservePendingSafeBundleSubmission } from '~/utils/pending-safe-bundle-submission'
import { WalletExecutionContextChangedError } from '~/utils/walletExecutionContext'
import * as safeWalletTransactions from '~/utils/safeWalletTransactions'
import { clearLiteTosSignature, setLiteTosSignature } from '~/utils/sdk-tos'

const wagmiMocks = vi.hoisted(() => ({
  sendTransactionAsync: vi.fn(),
  signTypedDataAsync: vi.fn(),
  sendCalls: vi.fn(),
  config: {},
}))

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

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
const VAULT = getAddress('0x5000000000000000000000000000000000000000')
const OTHER_TOKEN = getAddress('0x6000000000000000000000000000000000000000')
const GRANT_HASH = `0x${'11'.repeat(32)}` as Hash

describe('isSuccessfulTransactionReceipt', () => {
  it('rejects reverted receipts during Safe reconciliation', () => {
    expect(isSuccessfulTransactionReceipt({ status: 'success' })).toBe(true)
    expect(isSuccessfulTransactionReceipt({ status: 'reverted' })).toBe(false)
  })
})

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
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: memoryStorage() },
    })
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

  it('prepares the transaction plan with the caller-pinned signature mode', async () => {
    const prepare = vi.fn().mockResolvedValue({ kind: 'prepared' })
    vi.mocked(getEulerSdkForChain).mockResolvedValue({
      executionService: { prepareTransactionPlan: prepare },
    } as never)
    const { prepareTransactionPlan } = useEulerTx()

    await prepareTransactionPlan([] as TransactionPlan, { usePermit2: false })

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ usePermit2: false }))
  })

  it('does not execute a prepared plan after the TOS context changes', async () => {
    clearLiteTosSignature({ chainId: 1, account: OWNER })
    const prepared = {
      __prepared: true,
      plan: [],
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared
    vi.mocked(getEulerSdkForChain).mockResolvedValue({
      executionService: { prepareTransactionPlan: vi.fn().mockResolvedValue(prepared) },
    } as never)
    const { prepareTransactionPlan, executePreparedPlan } = useEulerTx()
    const trackedPrepared = await prepareTransactionPlan([] as TransactionPlan)

    setLiteTosSignature({
      chainId: 1,
      account: OWNER,
      tosMessage: 'current terms',
      tosMessageHash: `0x${'22'.repeat(32)}`,
    })

    await expect(executePreparedPlan(trackedPrepared))
      .rejects.toThrow('Terms of Use context changed')
    expect(getEulerSdkFresh).not.toHaveBeenCalled()

    clearLiteTosSignature({ chainId: 1, account: OWNER })
  })

  it('rejects a preloaded plan account from another chain', async () => {
    const account = new Account({ chainId: 8453, owner: OWNER, subAccounts: {} })
    const { planDeposit } = useEulerTx()

    await expect(planDeposit({
      vaultAddress: VAULT,
      assetAddress: TOKEN,
      amount: 1n,
      account,
    })).rejects.toThrow('does not match the active chain')
  })

  it('verifies the current-chain vault asset before planning a deposit', async () => {
    const account = new Account({ chainId: 1, owner: OWNER, subAccounts: {} })
    const fetchVault = vi.fn().mockResolvedValue({
      result: { chainId: 1, address: VAULT, asset: { address: OTHER_TOKEN } },
      errors: [],
    })
    const sdkPlanDeposit = vi.fn()
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      vaultMetaService: { fetchVault },
      executionService: { planDeposit: sdkPlanDeposit },
    } as never)
    const { planDeposit } = useEulerTx()

    await expect(planDeposit({
      vaultAddress: VAULT,
      assetAddress: TOKEN,
      amount: 1n,
      account,
    })).rejects.toThrow('Deposit vault metadata changed')
    expect(sdkPlanDeposit).not.toHaveBeenCalled()

    fetchVault.mockResolvedValueOnce({
      result: { chainId: 1, address: VAULT, asset: { address: TOKEN } },
      errors: [],
    })
    sdkPlanDeposit.mockReturnValueOnce([])

    await expect(planDeposit({
      vaultAddress: VAULT,
      assetAddress: TOKEN,
      amount: 1n,
      account,
    })).resolves.toEqual([])
    expect(sdkPlanDeposit).toHaveBeenCalledWith(expect.objectContaining({
      account,
      vault: VAULT,
      asset: TOKEN,
      amount: 1n,
    }))
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
  ] as const)('does not request a prepared Permit2 signature after %s drift', async (kind, driftWallet) => {
    const executePreparedTransactionPlan = vi.fn(async ({ signTypedData }: {
      signTypedData: (typedData: Record<string, unknown>) => Promise<Hex>
    }) => {
      await signTypedData({
        domain: {},
        types: {},
        primaryType: 'PermitWitnessTransferFrom',
        message: {},
      })
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
      usePermit2: true,
      unlimitedApproval: false,
    } as TransactionPlanPrepared
    driftWallet()

    await expect(executePreparedPlan(prepared))
      .rejects.toMatchObject({ name: WalletExecutionContextChangedError.name, kind })
    expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('pins a prepared Permit2 signature request to the reviewed owner', async () => {
    wagmiMocks.signTypedDataAsync.mockResolvedValue('0x1234')
    const executePreparedTransactionPlan = vi.fn(async ({ signTypedData }: {
      signTypedData: (typedData: Record<string, unknown>) => Promise<Hex>
    }) => {
      await signTypedData({
        domain: {},
        types: {},
        primaryType: 'PermitWitnessTransferFrom',
        message: {},
      })
      return { receipts: [] }
    })
    const provider = { waitForTransactionReceipt: vi.fn() }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
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

    expect(wagmiMocks.signTypedDataAsync).toHaveBeenCalledWith(expect.objectContaining({ account: OWNER }))
  })

  it('forwards prepared-plan progress to the caller', async () => {
    const progress = { completed: 0, total: 1, status: 'evcBatch' as const }
    const executePreparedTransactionPlan = vi.fn(async ({ onProgress }: {
      onProgress?: (value: typeof progress) => void
    }) => {
      onProgress?.(progress)
      return { receipts: [] }
    })
    const provider = { waitForTransactionReceipt: vi.fn() }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const onProgress = vi.fn()
    const { executePreparedPlan } = useEulerTx()

    await executePreparedPlan({
      __prepared: true,
      plan: [],
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared, { onProgress })

    expect(onProgress).toHaveBeenCalledWith(progress)
  })

  it('routes prerequisite and terminal Safe hashes to separate callbacks', async () => {
    const approvalHash = `0x${'21'.repeat(32)}` as Hash
    const batchHash = `0x${'22'.repeat(32)}` as Hash
    wagmiMocks.sendTransactionAsync
      .mockResolvedValueOnce(approvalHash)
      .mockResolvedValueOnce(batchHash)
    const executePreparedTransactionPlan = vi.fn(async ({ onProgress, sendTransaction }: {
      onProgress?: (value: { completed: number, total: number, status: 'approval' | 'evcBatch' }) => void
      sendTransaction: (tx: { to: Address, data: Hex }) => Promise<Hash>
    }) => {
      onProgress?.({ completed: 0, total: 2, status: 'approval' })
      await sendTransaction({ to: TOKEN, data: '0x1234' })
      onProgress?.({ completed: 1, total: 2, status: 'evcBatch' })
      await sendTransaction({ to: VAULT, data: '0x5678' })
      return { receipts: [] }
    })
    const provider = { waitForTransactionReceipt: vi.fn() }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const safeProviderSpy = vi.spyOn(safeWalletTransactions, 'getSafeWalletProvider')
      .mockResolvedValue({ request: vi.fn() } as never)
    const waitSpy = vi.spyOn(safeWalletTransactions, 'waitForSafeTransactionExecution')
      .mockImplementation(async ({ submittedHash }) => ({
        hash: submittedHash,
        receipt: { transactionHash: submittedHash, status: 'success' } as TransactionReceipt,
      }))
    const onSafePrerequisiteSubmission = vi.fn()
    const onSafeTerminalSubmissionStart = vi.fn()
    const onSafeSubmission = vi.fn()
    const { executePreparedPlan } = useEulerTx()

    try {
      await executePreparedPlan({
        __prepared: true,
        plan: [],
        chainId: 1,
        account: OWNER,
        usePermit2: false,
        unlimitedApproval: false,
      } as TransactionPlanPrepared, {
        onSafePrerequisiteSubmission,
        onSafeTerminalSubmissionStart,
        onSafeSubmission,
      })

      expect(onSafePrerequisiteSubmission).toHaveBeenCalledExactlyOnceWith(approvalHash)
      expect(onSafeTerminalSubmissionStart).toHaveBeenCalledTimes(1)
      expect(onSafeSubmission).toHaveBeenCalledExactlyOnceWith(batchHash)
    }
    finally {
      waitSpy.mockRestore()
      safeProviderSpy.mockRestore()
    }
  })

  it('blocks Safe execution before the SDK can submit when durable preflight fails', async () => {
    const executePreparedTransactionPlan = vi.fn()
    const provider = { waitForTransactionReceipt: vi.fn() }
    vi.mocked(getEulerSdkFresh).mockResolvedValue({
      providerService: { getProvider: vi.fn(() => provider) },
      executionService: { executePreparedTransactionPlan },
    } as never)
    const safeProviderSpy = vi.spyOn(safeWalletTransactions, 'getSafeWalletProvider')
      .mockResolvedValue({ request: vi.fn() } as never)
    const storageError = new Error('localStorage quota exceeded')
    const onSafePreflight = vi.fn(() => {
      throw storageError
    })
    const { executePreparedPlan } = useEulerTx()

    try {
      await expect(executePreparedPlan({
        __prepared: true,
        plan: [],
        chainId: 1,
        account: OWNER,
        usePermit2: false,
        unlimitedApproval: false,
      } as TransactionPlanPrepared, { onSafePreflight })).rejects.toBe(storageError)

      expect(onSafePreflight).toHaveBeenCalledTimes(1)
      expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
      expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
    }
    finally {
      safeProviderSpy.mockRestore()
    }
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
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: memoryStorage() },
    })
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
  })

  it('submits approve + EVC batch as one Safe call bundle', async () => {
    const { executePreparedPlan } = useEulerTx()
    const lifecycle: string[] = []

    const result = await executePreparedPlan(buildPrepared(approvedPlan), {
      onSafePreflight: () => { lifecycle.push('preflight') },
      onSafeTerminalSubmissionStart: () => { lifecycle.push('terminal') },
      onSafeSubmission: (hash) => { lifecycle.push(`submitted:${hash}`) },
    })

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
    expect(lifecycle).toEqual(['preflight', 'terminal', `submitted:${SAFE_TX_HASH}`])
    // The sequential path never runs: no per-transaction sends.
    expect(executePreparedTransactionPlan).not.toHaveBeenCalled()
    expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it('durably reserves ordinary Safe bundles before opening the wallet', async () => {
    wagmiMocks.sendCalls.mockImplementationOnce(async () => {
      const pending = loadPendingSafeBundleSubmissions(window.localStorage)[0]
      expect(pending).toMatchObject({
        account: OWNER,
        chainId: 1,
      })
      expect(pending?.submittedHash).toBeUndefined()
      return { id: SAFE_TX_HASH }
    })
    const { executePreparedPlan } = useEulerTx()

    await executePreparedPlan(buildPrepared(approvedPlan))

    expect(loadPendingSafeBundleSubmissions(window.localStorage)).toEqual([])
  })

  it('preserves another context reservation when this tab writes its Safe lifecycle', async () => {
    reservePendingSafeBundleSubmission(window.localStorage, {
      reservationId: 'other-context',
      account: OTHER_OWNER,
      chainId: 8453,
      errorMessage: 'Other Safe submission pending',
    })
    const { executePreparedPlan } = useEulerTx()

    await executePreparedPlan(buildPrepared(approvedPlan))

    expect(loadPendingSafeBundleSubmissions(window.localStorage)).toEqual([{
      reservationId: 'other-context',
      account: OTHER_OWNER,
      chainId: 8453,
      errorMessage: 'Other Safe submission pending',
    }])
  })

  it('does not let a second tab enter Safe while the first lifecycle owns the mutex', async () => {
    let rejectFirst!: (error: unknown) => void
    wagmiMocks.sendCalls.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectFirst = reject
    }))
    const { executePreparedPlan } = useEulerTx()

    const first = executePreparedPlan(buildPrepared(approvedPlan))
    await vi.waitFor(() => expect(wagmiMocks.sendCalls).toHaveBeenCalledTimes(1))

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toThrow('Another tab is already managing a Safe submission')
    expect(wagmiMocks.sendCalls).toHaveBeenCalledTimes(1)

    const rejection = Object.assign(new Error('User rejected the request'), { code: 4001 })
    rejectFirst(rejection)
    await expect(first).rejects.toBe(rejection)
  })

  it('retains the hashless reservation when sendCalls rejects ambiguously', async () => {
    wagmiMocks.sendCalls.mockRejectedValueOnce(new Error('Safe relay unavailable'))
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toBeInstanceOf(safeWalletTransactions.SafeSubmissionStatusUnknownError)
    const pending = loadPendingSafeBundleSubmissions(window.localStorage)[0]
    expect(pending).toMatchObject({
      account: OWNER,
      chainId: 1,
    })
    expect(pending?.submittedHash).toBeUndefined()
  })

  it('retains the hashless reservation when Safe returns no usable bundle id', async () => {
    wagmiMocks.sendCalls.mockResolvedValueOnce({ id: undefined } as never)
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toBeInstanceOf(safeWalletTransactions.SafeSubmissionStatusUnknownError)
    const pending = loadPendingSafeBundleSubmissions(window.localStorage)[0]
    expect(pending).toMatchObject({
      account: OWNER,
      chainId: 1,
    })
    expect(pending?.submittedHash).toBeUndefined()
  })

  it('clears the reservation for an explicit wallet rejection', async () => {
    const rejection = Object.assign(new Error('User rejected the request'), { code: 4001 })
    wagmiMocks.sendCalls.mockRejectedValueOnce(rejection)
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan))).rejects.toBe(rejection)
    expect(loadPendingSafeBundleSubmissions(window.localStorage)).toEqual([])
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

  it('treats a pre-hash terminal Safe fallback failure as submission-ambiguous', async () => {
    const transportError = new Error('Safe relay connection closed')
    wagmiMocks.sendTransactionAsync.mockRejectedValueOnce(transportError)
    executePreparedTransactionPlan.mockImplementationOnce(async ({ onProgress, sendTransaction }) => {
      onProgress({ completed: 0, total: 1, status: 'evcBatch' })
      await sendTransaction({ to: EVC, data: BATCH_DATA, value: 0n })
      return { receipts: [] }
    })
    const onSafeTerminalSubmissionStart = vi.fn()
    const { executePreparedPlan } = useEulerTx()
    const batchOnly = [approvedPlan[1]] as TransactionPlan

    await expect(executePreparedPlan(buildPrepared(batchOnly), {
      onSafeTerminalSubmissionStart,
    })).rejects.toMatchObject({
      name: safeWalletTransactions.SafeSubmissionStatusUnknownError.name,
      cause: transportError,
    })
    expect(onSafeTerminalSubmissionStart).toHaveBeenCalledTimes(1)
  })

  it('propagates an explicit rejection from the terminal Safe fallback', async () => {
    const rejection = Object.assign(new Error('User rejected the request'), { code: 4001 })
    wagmiMocks.sendTransactionAsync.mockRejectedValueOnce(rejection)
    executePreparedTransactionPlan.mockImplementationOnce(async ({ onProgress, sendTransaction }) => {
      onProgress({ completed: 0, total: 1, status: 'evcBatch' })
      await sendTransaction({ to: EVC, data: BATCH_DATA, value: 0n })
      return { receipts: [] }
    })
    const { executePreparedPlan } = useEulerTx()
    const batchOnly = [approvedPlan[1]] as TransactionPlan

    await expect(executePreparedPlan(buildPrepared(batchOnly))).rejects.toBe(rejection)
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

  it('treats bundle ids that are not hash-shaped as submission-ambiguous', async () => {
    wagmiMocks.sendCalls.mockResolvedValue({ id: 'bundle-1' })
    const { executePreparedPlan } = useEulerTx()

    await expect(executePreparedPlan(buildPrepared(approvedPlan)))
      .rejects.toBeInstanceOf(safeWalletTransactions.SafeSubmissionStatusUnknownError)
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

  it('arms and records a plain-calls Safe bundle before confirmation polling', async () => {
    const lifecycle: string[] = []
    const { executePreparedPlanWithPlainCalls } = useEulerTx()

    await executePreparedPlanWithPlainCalls(buildPrepared([approvedPlan[1]] as TransactionPlan), {
      before: [GRANT_CALL],
      after: [REVOKE_CALL],
    }, {
      onSafePreflight: () => { lifecycle.push('preflight') },
      onSafeTerminalSubmissionStart: () => { lifecycle.push('terminal') },
      onSafeSubmission: (hash) => { lifecycle.push(`submitted:${hash}`) },
    })

    expect(lifecycle).toEqual([
      'preflight',
      'terminal',
      `submitted:${SAFE_TX_HASH}`,
    ])
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
