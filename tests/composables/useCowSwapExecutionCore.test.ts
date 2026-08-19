import { ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Address, type Hex } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { readPendingSubmission, resetPendingSubmissionMemoryFallback, writePendingSubmission } from '~/utils/pendingSubmissions'

// Hoisted so the same spy instances survive vi.resetModules() — the mock
// factories re-run for each fresh module graph but hand back these objects.
const wagmiMocks = vi.hoisted(() => ({
  sendTransactionAsync: vi.fn(),
  signTypedDataAsync: vi.fn(),
  getAccount: vi.fn(),
  config: {},
}))

const sdkMocks = vi.hoisted(() => ({
  getEulerSdkFresh: vi.fn(),
}))

const cowMocks = vi.hoisted(() => ({
  pollCowSwapOrderStatus: vi.fn(),
  fetchCowSwapOrderStatus: vi.fn(),
  cancelCowSwapOrder: vi.fn(),
  getCowSwapOrderExplorerUrl: vi.fn(() => 'https://explorer.cow.fi/orders/test'),
}))

vi.mock('@wagmi/vue', () => ({
  useConfig: () => wagmiMocks.config,
  useSendTransaction: () => ({ sendTransactionAsync: wagmiMocks.sendTransactionAsync }),
  useSignTypedData: () => ({ signTypedDataAsync: wagmiMocks.signTypedDataAsync }),
}))

vi.mock('@wagmi/vue/actions', () => ({
  getAccount: wagmiMocks.getAccount,
}))

vi.mock('~/entities/cowswap', () => ({
  pollCowSwapOrderStatus: cowMocks.pollCowSwapOrderStatus,
  fetchCowSwapOrderStatus: cowMocks.fetchCowSwapOrderStatus,
  cancelCowSwapOrder: cowMocks.cancelCowSwapOrder,
  getCowSwapOrderExplorerUrl: cowMocks.getCowSwapOrderExplorerUrl,
  COWSWAP_ORDER_POLL_INTERVAL_MS: 1,
  COWSWAP_ORDER_POLL_MAX_DURATION_MS: 50,
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkFresh: sdkMocks.getEulerSdkFresh,
}))

vi.mock('~/composables/usePortfolioRefresh', () => ({
  usePortfolioRefresh: () => ({ triggerPortfolioRefresh: vi.fn() }),
}))

const OWNER = getAddress('0x1000000000000000000000000000000000000000')
const OTHER_OWNER = getAddress('0x2000000000000000000000000000000000000000')
const APPROVAL_TARGET = getAddress('0x3000000000000000000000000000000000000000')
const CONNECTOR = { id: 'io.metamask', uid: 'uid-1' }
const ORDER_UID = `0x${'ab'.repeat(56)}`
const TX_HASH = `0x${'33'.repeat(32)}`

/** Shape of the argument object the core hands to executeCowSwapTransactionPlan. */
interface ExecArgs {
  plan: TransactionPlan
  chainId: number
  account: Address
  sendTransaction: (tx: { to: Address, data: Hex, value?: bigint }) => Promise<unknown>
  signTypedData: (typedData: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  }) => Promise<unknown>
  onProgress: (progress: { status?: string, orderUid?: string }) => void
}

const sdkFor = (executeCowSwapTransactionPlan: (args: ExecArgs) => Promise<unknown>) => ({
  providerService: {
    getProvider: vi.fn(() => ({
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('receipt not found')
      }),
    })),
  },
  executionService: { executeCowSwapTransactionPlan },
})

const successResult = { results: [], orderUids: [ORDER_UID] }

const typedDataStub = {
  domain: { name: 'Permit2' },
  types: { Permit: [] },
  primaryType: 'Permit',
  message: { spender: APPROVAL_TARGET },
}

describe('useCowSwapExecutionCore', () => {
  let isSafeWallet: Ref<boolean>
  let isSafeWalletResolved: Ref<boolean>

  const setupCore = async () => {
    const { useCowSwapExecutionCore } = await import('~/composables/cowswap/useCowSwapExecutionCore')
    return useCowSwapExecutionCore()
  }

  const dummyFlow = {
    plan: [] as TransactionPlan,
    chainId: 1,
    cancellationMode: 'cow-api' as const,
    orderbookUrl: 'https://api.cow.fi/mainnet',
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    isSafeWallet = ref(false)
    isSafeWalletResolved = ref(true)
    vi.stubGlobal('useWagmi', () => ({ address: ref(OWNER) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet, isSafeWalletResolved }))
    vi.stubGlobal('useCowSwapEligibility', () => ({
      cowSwapForcedOff: computed(() => isSafeWallet.value || !isSafeWalletResolved.value),
    }))
    wagmiMocks.getAccount.mockReturnValue({ address: OWNER, chainId: 1, connector: CONNECTOR })
    wagmiMocks.sendTransactionAsync.mockResolvedValue(TX_HASH)
    wagmiMocks.signTypedDataAsync.mockResolvedValue('0xsig')
    // Default: the orderbook never reports the order terminal within this
    // test, so the background release watcher leaves the record alone.
    cowMocks.pollCowSwapOrderStatus.mockResolvedValue({ terminal: false })
    cowMocks.fetchCowSwapOrderStatus.mockResolvedValue({ terminal: false })
    // The pending-submission quarantine is module state shared across tests.
    resetPendingSubmissionMemoryFallback()
  })

  describe('Safe backstop and cross-surface gate', () => {
    it('rejects execution for Safe wallets before any transaction is sent', async () => {
      isSafeWallet.value = true
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).rejects.toThrow('CoW Swap is not available with Safe wallets')
    })

    it('rejects execution while Safe detection is pending', async () => {
      isSafeWalletResolved.value = false
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).rejects.toThrow('CoW Swap is not available with Safe wallets')
    })

    it('blocks execution while an ambiguous submission from another surface is unresolved', async () => {
      // The CoW executor sends approvals and signs the order permit straight
      // through the wallet callbacks, without passing any plan-executor gate —
      // a quarantined submission from any flow must stop it before either.
      writePendingSubmission('batch', {
        phase: 'armed',
        chainId: 1,
        owner: OWNER,
        completesPlan: true,
        submittedAt: 1_000,
      })
      const executeCowSwapTransactionPlan = vi.fn()
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).rejects.toThrow(
        'handed to the wallet but no transaction id came back',
      )

      // Nothing crossed the wallet boundary: no approval transaction was sent
      // and no order or permit signature was requested.
      expect(executeCowSwapTransactionPlan).not.toHaveBeenCalled()
      expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
      expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
      expect(readPendingSubmission('batch', OWNER, 1)).toBeDefined()
    })
  })

  describe('owned quarantine lifecycle', () => {
    it('arms replay protection before the wallet boundary and upgrades it with the order uid', async () => {
      let recordAtBoundary: unknown
      const executeCowSwapTransactionPlan = vi.fn(async ({ onProgress }: ExecArgs) => {
        // The SDK is about to invoke the wallet callbacks — a reload here must
        // already find the durable reservation.
        recordAtBoundary = readPendingSubmission('cow-order', OWNER, 1)
        onProgress({ status: 'submitOrder' })
        onProgress({ orderUid: ORDER_UID })
        return successResult
      })
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).resolves.toBe(ORDER_UID)

      expect(recordAtBoundary).toMatchObject({ phase: 'armed', owner: OWNER, chainId: 1 })
      expect(readPendingSubmission('cow-order', OWNER, 1)).toMatchObject({
        phase: 'submitted',
        kind: 'cow-order',
        orderUid: ORDER_UID,
        owner: OWNER,
        chainId: 1,
      })
    })

    it('releases the record once the orderbook reports the order terminal', async () => {
      cowMocks.pollCowSwapOrderStatus.mockResolvedValue({ terminal: true, status: 'fulfilled' })
      const executeCowSwapTransactionPlan = vi.fn(async ({ onProgress }: ExecArgs) => {
        onProgress({ status: 'submitOrder', orderUid: ORDER_UID })
        return successResult
      })
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).resolves.toBe(ORDER_UID)

      await vi.waitFor(() => {
        expect(readPendingSubmission('cow-order', OWNER, 1)).toBeUndefined()
      })
      expect(cowMocks.pollCowSwapOrderStatus).toHaveBeenCalledWith(expect.objectContaining({
        orderUid: ORDER_UID,
        chainId: 1,
        orderbookUrl: 'https://api.cow.fi/mainnet',
      }))
    })

    it('keeps the armed record when the orderbook accepted the submission but the response was lost, and blocks the retry', async () => {
      const executeCowSwapTransactionPlan = vi.fn(async ({ onProgress }: ExecArgs) => {
        // The orderbook request went out; the response never came back, so no
        // order uid exists — but a live order may.
        onProgress({ status: 'submitOrder' })
        throw new Error('Failed to fetch')
      })
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).rejects.toThrow('Failed to fetch')
      expect(readPendingSubmission('cow-order', OWNER, 1)).toMatchObject({
        phase: 'armed',
        owner: OWNER,
        chainId: 1,
      })

      // A retry must not create a second live order: the gate stops it before
      // the executor or any wallet callback runs.
      await expect(core.executePlan(dummyFlow)).rejects.toThrow(
        'handed to the wallet but no transaction id came back',
      )
      expect(executeCowSwapTransactionPlan).toHaveBeenCalledTimes(1)
      expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
      expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
    })

    it('keeps the armed record after an ambiguous signature failure', async () => {
      wagmiMocks.signTypedDataAsync.mockRejectedValue(new Error('connection lost'))
      const executeCowSwapTransactionPlan = vi.fn(async ({ signTypedData }: ExecArgs) => {
        await signTypedData(typedDataStub)
        return successResult
      })
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).rejects.toThrow('connection lost')

      // A dropped connection cannot prove the wallet produced no signature —
      // the order may still be signable/submittable wallet-side.
      expect(readPendingSubmission('cow-order', OWNER, 1)).toMatchObject({
        phase: 'armed',
        owner: OWNER,
        chainId: 1,
      })
    })

    it('releases the record on a proven wallet rejection and allows a fresh attempt', async () => {
      wagmiMocks.signTypedDataAsync.mockRejectedValueOnce(
        Object.assign(new Error('User rejected the request.'), { code: 4001 }),
      )
      const executeCowSwapTransactionPlan = vi.fn(async ({ signTypedData }: ExecArgs) => {
        await signTypedData(typedDataStub)
        return successResult
      })
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).rejects.toThrow('User rejected the request.')
      expect(readPendingSubmission('cow-order', OWNER, 1)).toBeUndefined()

      await expect(core.executePlan(dummyFlow)).resolves.toBe(ORDER_UID)
      expect(executeCowSwapTransactionPlan).toHaveBeenCalledTimes(2)
    })

    it('preserves the order uid and throws when the submitted upgrade cannot be made durable', async () => {
      const executeCowSwapTransactionPlan = vi.fn(async ({ onProgress }: ExecArgs) => {
        onProgress({ status: 'submitOrder', orderUid: ORDER_UID })
        return successResult
      })
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      // Storage accepts the armed reservation but rejects the submitted
      // rewrite — the order is live at that point, so the failure must
      // surface instead of reading as success.
      const working = globalThis.localStorage
      vi.stubGlobal('localStorage', {
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
      try {
        await expect(core.executePlan(dummyFlow)).rejects.toThrow('could not durably record its id')
      }
      finally {
        vi.stubGlobal('localStorage', working)
      }

      // The known uid was preserved in fail-closed durable form: the record
      // is armed but carries the observed order id, so it can never be
      // dismissed manually and resolves objectively via the orderbook.
      expect(readPendingSubmission('cow-order', OWNER, 1)).toMatchObject({
        phase: 'armed',
        owner: OWNER,
        chainId: 1,
        observedId: { kind: 'cow-order', orderUid: ORDER_UID },
      })
    })
  })

  describe('pinned wallet callbacks', () => {
    it('dispatches every approval and signature with the reviewed account, chain, and connector', async () => {
      const executeCowSwapTransactionPlan = vi.fn(async ({ sendTransaction, signTypedData }: ExecArgs) => {
        await sendTransaction({ to: APPROVAL_TARGET, data: '0xdead', value: 5n })
        await signTypedData(typedDataStub)
        return successResult
      })
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).resolves.toBe(ORDER_UID)

      expect(wagmiMocks.sendTransactionAsync).toHaveBeenCalledWith({
        account: OWNER,
        chainId: 1,
        connector: CONNECTOR,
        to: APPROVAL_TARGET,
        data: '0xdead',
        value: 5n,
      })
      expect(wagmiMocks.signTypedDataAsync).toHaveBeenCalledWith(expect.objectContaining({
        account: OWNER,
        connector: CONNECTOR,
        primaryType: 'Permit',
      }))
    })

    it.each([
      {
        drift: 'account',
        current: { address: OTHER_OWNER, chainId: 1, connector: CONNECTOR },
        message: 'Wallet account changed during execution',
      },
      {
        drift: 'chain',
        current: { address: OWNER, chainId: 8453, connector: CONNECTOR },
        message: 'Wallet network changed during execution',
      },
      {
        drift: 'connector',
        current: { address: OWNER, chainId: 1, connector: { id: 'io.metamask', uid: 'uid-2' } },
        message: 'Wallet changed since review',
      },
    ])('refuses the next approval when the $drift changed during an SDK await', async ({ current, message }) => {
      const executeCowSwapTransactionPlan = vi.fn(async ({ sendTransaction }: ExecArgs) => {
        // The switch happens while the SDK awaits between callbacks — e.g. a
        // same-address connector swap the account/chain checks cannot see.
        wagmiMocks.getAccount.mockReturnValue(current)
        await sendTransaction({ to: APPROVAL_TARGET, data: '0xdead' })
        return successResult
      })
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).rejects.toThrow(message)

      expect(wagmiMocks.sendTransactionAsync).not.toHaveBeenCalled()
      expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
      // The abort happened before anything reached the wallet, so no order
      // artifact can exist and the reservation was released for the retry.
      expect(readPendingSubmission('cow-order', OWNER, 1)).toBeUndefined()
    })

    it('refuses the order signature when the connector changed, without invoking the wallet', async () => {
      const executeCowSwapTransactionPlan = vi.fn(async ({ signTypedData }: ExecArgs) => {
        wagmiMocks.getAccount.mockReturnValue({
          address: OWNER,
          chainId: 1,
          connector: { id: 'io.metamask', uid: 'uid-2' },
        })
        await signTypedData(typedDataStub)
        return successResult
      })
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).rejects.toThrow('Wallet changed since review')

      // The pin check throws before the signing request is built: no
      // signature was requested, so no artifact is possible and the
      // reservation was released.
      expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled()
      expect(readPendingSubmission('cow-order', OWNER, 1)).toBeUndefined()
    })

    it('refuses to start the ceremony when no connector is available at entry', async () => {
      wagmiMocks.getAccount.mockReturnValue({ address: OWNER, chainId: 1, connector: undefined })
      const executeCowSwapTransactionPlan = vi.fn()
      sdkMocks.getEulerSdkFresh.mockResolvedValue(sdkFor(executeCowSwapTransactionPlan) as never)
      const core = await setupCore()

      await expect(core.executePlan(dummyFlow)).rejects.toThrow('Wallet changed since review')

      expect(executeCowSwapTransactionPlan).not.toHaveBeenCalled()
      expect(readPendingSubmission('cow-order', OWNER, 1)).toBeUndefined()
    })
  })
})
