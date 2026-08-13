import { ref } from 'vue'
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hash, type Hex, type TransactionReceipt } from 'viem'
import { Account, type MigrationAuthorizationRequest, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAccount } from '@wagmi/vue/actions'
import { getEulerSdkForChain, getEulerSdkFresh } from '~/composables/useEulerSdk'
import { isSuccessfulTransactionReceipt, useEulerTx } from '~/composables/useEulerTx'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'
import { WalletExecutionContextChangedError } from '~/utils/walletExecutionContext'
import * as safeWalletTransactions from '~/utils/safeWalletTransactions'

const wagmiMocks = vi.hoisted(() => ({
  sendTransactionAsync: vi.fn(),
  signTypedDataAsync: vi.fn(),
  config: {},
}))

vi.mock('@wagmi/vue', () => ({
  useConfig: () => wagmiMocks.config,
  useSendTransaction: () => ({ sendTransactionAsync: wagmiMocks.sendTransactionAsync }),
  useSignTypedData: () => ({ signTypedDataAsync: wagmiMocks.signTypedDataAsync }),
}))

vi.mock('@wagmi/vue/actions', () => ({
  getAccount: vi.fn(),
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
        onSafeSubmission,
      })

      expect(onSafePrerequisiteSubmission).toHaveBeenCalledExactlyOnceWith(approvalHash)
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
