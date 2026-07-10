import { ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, IHasVaultAddress, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import type { Address, Hex } from 'viem'
import { useEulerTx } from '~/composables/useEulerTx'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    executePreparedTransactionPlan: vi.fn(),
    getAccount: vi.fn(),
    getEulerSdkFresh: vi.fn(),
    invalidateSdkQueries: vi.fn(),
    sendTransactionAsync: vi.fn(),
    signTypedDataAsync: vi.fn(),
    triggerPortfolioRefresh: vi.fn(),
  },
}))

vi.mock('@wagmi/vue', () => ({
  useConfig: () => ({}),
  useSendTransaction: () => ({ sendTransactionAsync: mocks.sendTransactionAsync }),
  useSignTypedData: () => ({ signTypedDataAsync: mocks.signTypedDataAsync }),
}))

vi.mock('@wagmi/vue/actions', () => ({
  getAccount: mocks.getAccount,
}))

vi.mock('~/composables/useEulerSdk', () => ({
  buildSubgraphProxyApiPath: vi.fn(),
  getEulerSdkForChain: vi.fn(),
  getEulerSdkFresh: mocks.getEulerSdkFresh,
}))

vi.mock('~/utils/errorHandling', () => ({
  logWarn: vi.fn(),
}))

vi.mock('~/utils/sdk-query-cache', () => ({
  invalidateSdkQueries: mocks.invalidateSdkQueries,
}))

vi.mock('~/utils/sdk-query-policy', () => ({
  INVALIDATE_AFTER_TX: [],
}))

vi.mock('~/utils/subgraph', () => ({
  waitForSubgraphBlock: vi.fn(),
}))

vi.mock('~/utils/profiler', () => ({
  profAsync: (_group: string, _operation: string, fn: () => unknown) => fn(),
}))

const OWNER = '0x0000000000000000000000000000000000000001' as Address
const OTHER_OWNER = '0x0000000000000000000000000000000000000002' as Address
const TARGET = '0x0000000000000000000000000000000000000003' as Address
const CHAIN_ID = 1
const OTHER_CHAIN_ID = 8453
const TX_HASH = `0x${'1'.repeat(64)}` as Hex
const SIGNATURE = `0x${'2'.repeat(130)}` as Hex

type PreparedExecutionCallbacks = {
  sendTransaction: (transaction: { to: Address, data: Hex, value?: bigint }) => Promise<Hex>
  signTypedData: (typedData: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  }) => Promise<Hex>
}

const typedData = {
  domain: { chainId: CHAIN_ID },
  types: { Permit: [{ name: 'owner', type: 'address' }] },
  primaryType: 'Permit',
  message: { owner: OWNER },
}

const preparedPlan = (account: TransactionPlanPrepared['account'] = OWNER): TransactionPlanPrepared => ({
  __prepared: true,
  plan: [],
  chainId: CHAIN_ID,
  account,
  usePermit2: true,
  unlimitedApproval: false,
})

describe('useEulerTx executePreparedPlan', () => {
  let walletAddress: Ref<Address | undefined>
  let walletChainId: Ref<number | undefined>

  beforeEach(() => {
    vi.clearAllMocks()
    walletAddress = ref(OWNER)
    walletChainId = ref(CHAIN_ID)

    vi.stubGlobal('useWagmi', () => ({
      address: walletAddress,
      chainId: walletChainId,
    }))
    vi.stubGlobal('useSpyMode', () => ({
      isSpyMode: ref(false),
      spyAddress: ref(undefined),
    }))
    vi.stubGlobal('usePermit2Preference', () => ({ permit2Enabled: ref(true) }))
    vi.stubGlobal('usePortfolioRefresh', () => ({ triggerPortfolioRefresh: mocks.triggerPortfolioRefresh }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(CHAIN_ID) }))

    mocks.getAccount.mockReturnValue({ connector: undefined })
    mocks.getEulerSdkFresh.mockResolvedValue({
      executionService: {
        executePreparedTransactionPlan: mocks.executePreparedTransactionPlan,
      },
    })
    mocks.sendTransactionAsync.mockResolvedValue(TX_HASH)
    mocks.signTypedDataAsync.mockResolvedValue(SIGNATURE)
  })

  it('rejects account drift immediately before a prepared signature', async () => {
    mocks.executePreparedTransactionPlan.mockImplementation(async ({ signTypedData }: PreparedExecutionCallbacks) => {
      walletAddress.value = OTHER_OWNER
      await signTypedData(typedData)
      return { receipts: [] }
    })

    await expect(useEulerTx().executePreparedPlan(preparedPlan())).rejects.toThrow(
      'Wallet account changed since this transaction was prepared. Review the transaction again.',
    )
    expect(mocks.signTypedDataAsync).not.toHaveBeenCalled()
  })

  it('rejects chain drift immediately before a prepared transaction', async () => {
    mocks.executePreparedTransactionPlan.mockImplementation(async ({ sendTransaction }: PreparedExecutionCallbacks) => {
      walletChainId.value = OTHER_CHAIN_ID
      await sendTransaction({ to: TARGET, data: '0x' })
      return { receipts: [] }
    })

    await expect(useEulerTx().executePreparedPlan(preparedPlan())).rejects.toThrow(
      'Wallet network changed since this transaction was prepared. Review the transaction again.',
    )
    expect(mocks.sendTransactionAsync).not.toHaveBeenCalled()
  })

  it('binds prepared sends and signatures to the prepared wallet context', async () => {
    mocks.executePreparedTransactionPlan.mockImplementation(async ({ sendTransaction, signTypedData }: PreparedExecutionCallbacks) => {
      await signTypedData(typedData)
      await sendTransaction({ to: TARGET, data: '0x' })
      return { receipts: [] }
    })
    const preparedAccount = { owner: OWNER } as Account<IHasVaultAddress>

    await useEulerTx().executePreparedPlan(preparedPlan(preparedAccount))

    expect(mocks.signTypedDataAsync).toHaveBeenCalledWith({
      ...typedData,
      account: OWNER,
    })
    expect(mocks.sendTransactionAsync).toHaveBeenCalledWith({
      account: OWNER,
      chainId: CHAIN_ID,
      to: TARGET,
      data: '0x',
      value: 0n,
    })
  })
})
