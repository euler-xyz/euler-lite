import { ref } from 'vue'
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hash, type TransactionReceipt } from 'viem'
import type { MigrationAuthorizationRequest, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAccount } from '@wagmi/vue/actions'
import { getEulerSdkForChain, getEulerSdkFresh } from '~/composables/useEulerSdk'
import { useEulerTx } from '~/composables/useEulerTx'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'
import { WalletExecutionContextChangedError } from '~/utils/walletExecutionContext'

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

  it('prepares the transaction plan with the caller-pinned signature mode', async () => {
    const prepare = vi.fn().mockResolvedValue({ kind: 'prepared' })
    vi.mocked(getEulerSdkForChain).mockResolvedValue({
      executionService: { prepareTransactionPlan: prepare },
    } as never)
    const { prepareTransactionPlan } = useEulerTx()

    await prepareTransactionPlan([] as TransactionPlan, { usePermit2: false })

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ usePermit2: false }))
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
