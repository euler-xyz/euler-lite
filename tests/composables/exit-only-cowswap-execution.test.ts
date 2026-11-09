import { computed, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAddressScreen } from '~/composables/useAddressScreen'
import type { ExecuteCowSwapTransactionPlanArgs, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { useCowSwapExecutionCore } from '~/composables/cowswap/useCowSwapExecutionCore'
import { ADDRESS_EXIT_ONLY_MESSAGE, isAddressExitOnly, setAddressExitOnly } from '~/composables/addressExitOnlyState'
import { openCowSwapReviewModal } from '~/composables/cowswap/openCowSwapReviewModal'
import { useCowSwapClosePositionExecution } from '~/composables/cowswap/useCowSwapClosePositionExecution'
import { useCowSwapCollateralSwapExecution } from '~/composables/cowswap/useCowSwapCollateralSwapExecution'
import { useCowSwapOpenPositionExecution } from '~/composables/cowswap/useCowSwapOpenPositionExecution'

const OWNER = '0x1000000000000000000000000000000000000000'
const rawAddress = ref<string | undefined>()
const rawConnected = ref(false)
const rawChain = ref({ id: 1 })
const mocks = vi.hoisted(() => ({ screenAddress: vi.fn(), execute: vi.fn(), modalOpen: vi.fn(), disconnect: vi.fn(), send: vi.fn(), sign: vi.fn(), cancel: vi.fn() }))
vi.mock('@wagmi/vue', () => ({
  useAccount: () => ({ address: rawAddress, isConnected: rawConnected, connector: ref(undefined), chain: rawChain, status: ref('connected') }),
  useSwitchChain: () => ({ switchChain: vi.fn() }),
  useEnsName: () => ({ data: ref(undefined) }),
  useConfig: () => ({}),
  useDisconnect: () => ({ disconnect: mocks.disconnect }),
  useSendTransaction: () => ({ sendTransactionAsync: mocks.send }),
  useSignTypedData: () => ({ signTypedDataAsync: mocks.sign }),
}))
vi.mock('@wagmi/vue/actions', () => ({ connect: vi.fn(), getConnectors: () => [] }))
vi.mock('#components', () => ({ BlockedAddressModal: {}, CowSwapReviewModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: mocks.modalOpen, close: vi.fn() }) }))
vi.mock('~/services/screening', () => ({ screenAddress: mocks.screenAddress }))
vi.mock('~/services/vpn', () => ({ detectVpn: async () => false, resetVpnCache: vi.fn() }))
vi.mock('~/services/country', () => ({ resetCountryCache: vi.fn() }))
vi.mock('~/composables/usePortfolioRefresh', () => ({ usePortfolioRefresh: () => ({ triggerPortfolioRefresh: vi.fn() }) }))
vi.mock('~/utils/sdk-query-cache', () => ({ invalidateSdkQueries: vi.fn(async () => {}) }))
vi.mock('~/entities/cowswap', async original => ({
  ...await original<typeof import('~/entities/cowswap')>(),
  cancelCowSwapOrder: mocks.cancel,
}))
vi.mock('~/composables/useEulerSdk', () => ({ getEulerSdkFresh: async () => ({ executionService: {
  planOpenPositionWithCoW: () => [{ type: 'cowSwap', kind: 'openPosition', chainId: 1, params: {} }],
  planClosePositionWithCow: () => [{ type: 'cowSwap', kind: 'closePosition', chainId: 1, params: {} }],
  planSwapCollateralWithCoW: () => [{ type: 'cowSwap', kind: 'swapCollateral', chainId: 1, params: {} }],
  planCancelClosePositionWithCow: () => [{ type: 'cowSwap', kind: 'cancelClosePosition', chainId: 1, params: {} }],
  executeCowSwapTransactionPlan: mocks.execute,
} }) }))

let resetScreeningCache = () => setAddressExitOnly(false)
afterEach(() => {
  resetScreeningCache()
  vi.unstubAllGlobals()
})
describe.each([
  ['open-position', useCowSwapOpenPositionExecution, false],
  ['collateral-swap', useCowSwapCollateralSwapExecution, false],
  ['close-position repayment', useCowSwapClosePositionExecution, true],
] as const)('retained CoW %s review', (_flow, createExecution, isExit) => {
  it.each(['blocked', 'exit-only', 'clear'] as const)('applies a new %s verdict after reconnecting the same owner', async (verdict) => {
    vi.clearAllMocks()
    rawAddress.value = undefined
    rawConnected.value = false
    await nextTick()
    vi.stubGlobal('useRouter', () => ({ push: vi.fn(), replace: vi.fn(async () => {}) }))
    vi.stubGlobal('useRoute', () => ({ path: '/borrow/test/test', query: { network: '1' }, hash: '' }))
    vi.stubGlobal('useEulerAddresses', () => ({ changeCurrentChainId: vi.fn(), chainId: ref(1), allowedChainIds: computed(() => [1]) }))
    vi.stubGlobal('useNuxtApp', () => ({}))
    vi.stubGlobal('useDeployConfig', () => ({ enableEarnPage: true, enableExplorePage: true, enableLendPage: true }))
    const screening = useAddressScreen()
    resetScreeningCache = screening.resetScreeningCache
    screening.resetScreeningCache()
    const { useWagmi } = await import('~/composables/useWagmi')
    vi.stubGlobal('useWagmi', useWagmi)
    const wallet = useWagmi()
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useCowSwapEligibility', () => ({ cowSwapForcedOff: ref(false) }))
    mocks.screenAddress.mockResolvedValueOnce('clear').mockResolvedValueOnce(verdict)
    mocks.execute.mockResolvedValue({ results: [], orderUids: ['test-order'] })
    rawAddress.value = OWNER
    rawConnected.value = true
    await vi.waitFor(() => expect(wallet.isConnected.value).toBe(true))
    const execution = createExecution()
    const open = vi.fn()
    openCowSwapReviewModal({ open }, {
      signSteps: [], wrapperSteps: [], walletWarningsDescription: '',
      execution, orderStatus: { orderStatus: ref(null) },
      executeParams: { chainId: 1 } as Parameters<typeof execution.executeAsync>[0],
      logPrefix: 'exit-only-test',
    })
    // A wallet disconnect/account round-trip triggers reset and a fresh screen;
    // neither the CoW modal nor its confirm closure is discarded by that path.
    rawAddress.value = undefined
    rawConnected.value = false
    await nextTick()
    expect(wallet.isConnected.value).toBe(false)
    rawAddress.value = OWNER
    rawConnected.value = true
    await vi.waitFor(() => expect(mocks.screenAddress).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(screening.isScreening.value).toBe(false))
    expect(isAddressExitOnly.value).toBe(verdict === 'exit-only')
    expect(wallet.isConnected.value).toBe(verdict !== 'blocked')
    expect(screening.isAddressScreened(OWNER)).toBe(verdict !== 'blocked')
    await open.mock.calls[0][1].props.onConfirm()
    expect(mocks.execute).toHaveBeenCalledTimes(verdict === 'clear' || (verdict === 'exit-only' && isExit) ? 1 : 0)
  })
})

describe('CoW execution handoff policy', () => {
  const typedData = { domain: {}, types: {}, primaryType: 'Order', message: {} }
  const transaction = { to: OWNER, data: '0x' } as const
  const flow = (kind: 'openPosition' | 'closePosition') => ({
    plan: [{ type: 'cowSwap', kind, chainId: 1, params: {} }] as TransactionPlan,
    chainId: 1,
    cancellationMode: kind === 'closePosition' ? 'evc-permit' as const : 'cow-api' as const,
  })
  const result = { results: [], orderUids: ['test-order'] }

  beforeEach(() => {
    vi.clearAllMocks()
    setAddressExitOnly(false)
    vi.stubGlobal('useWagmi', () => ({ address: ref(OWNER) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useCowSwapEligibility', () => ({ cowSwapForcedOff: ref(false) }))
    mocks.sign.mockResolvedValue('0x01')
    mocks.send.mockResolvedValue('0x02')
  })

  it.each(['transaction', 'signature', 'submission'] as const)('checks a changed verdict before %s', async (boundary) => {
    mocks.execute.mockImplementationOnce(async (args: ExecuteCowSwapTransactionPlanArgs) => {
      setAddressExitOnly(true)
      if (boundary === 'transaction') await args.sendTransaction(transaction)
      if (boundary === 'signature') await args.signTypedData(typedData)
      if (boundary === 'submission') args.onProgress?.({ status: 'submitOrder', completed: 0, total: 1 })
      return result
    })
    await expect(useCowSwapExecutionCore().executePlan(flow('openPosition'))).rejects.toThrow(ADDRESS_EXIT_ONLY_MESSAGE)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.sign).not.toHaveBeenCalled()
  })

  it('stops an open-position signature returned after the address becomes exit-only', async () => {
    mocks.sign.mockImplementationOnce(async () => {
      setAddressExitOnly(true)
      return '0x01'
    })
    const submit = vi.fn()
    mocks.execute.mockImplementationOnce(async (args: ExecuteCowSwapTransactionPlanArgs) => {
      await args.signTypedData(typedData)
      submit()
      return result
    })
    await expect(useCowSwapExecutionCore().executePlan(flow('openPosition'))).rejects.toThrow(ADDRESS_EXIT_ONLY_MESSAGE)
    expect(mocks.sign).toHaveBeenCalledOnce()
    expect(submit).not.toHaveBeenCalled()
  })

  it('allows close-position repayment transactions, signatures and submission', async () => {
    setAddressExitOnly(true)
    mocks.execute.mockImplementationOnce(async (args: ExecuteCowSwapTransactionPlanArgs) => {
      await args.sendTransaction(transaction)
      await args.signTypedData(typedData)
      args.onProgress?.({ status: 'submitOrder', completed: 0, total: 1 })
      return result
    })
    await expect(useCowSwapExecutionCore().executePlan(flow('closePosition'))).resolves.toBe('test-order')
    expect(mocks.send).toHaveBeenCalledOnce()
    expect(mocks.sign).toHaveBeenCalledOnce()
  })

  it('allows soft cancellation of an open-position order after reclassification', async () => {
    mocks.execute.mockResolvedValueOnce(result)
    const core = useCowSwapExecutionCore()
    await core.executePlan(flow('openPosition'))
    setAddressExitOnly(true)
    mocks.cancel.mockImplementationOnce(async ({ signTypedData }: Pick<ExecuteCowSwapTransactionPlanArgs, 'signTypedData'>) => {
      await signTypedData(typedData)
    })
    await core.cancelOrder()
    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(mocks.sign).toHaveBeenCalledOnce()
    expect(core.cancellationStatus.value).toBe('soft_submitted')
  })

  it('allows hard cancellation of a close-position permit while exit-only', async () => {
    setAddressExitOnly(true)
    mocks.execute.mockResolvedValueOnce({
      ...result, results: [{ permitCancellation: { chainId: 1, owner: OWNER, nonce: 1n, nonceNamespace: 1n, wrapperAddress: OWNER } }],
    })
    const core = useCowSwapExecutionCore()
    await core.executePlan(flow('closePosition'))
    mocks.execute.mockImplementationOnce(async (args: ExecuteCowSwapTransactionPlanArgs) => {
      expect(args.plan[0]).toMatchObject({ kind: 'cancelClosePosition' })
      await args.sendTransaction(transaction)
      return { results: [], orderUids: [] }
    })
    await core.cancelOrder()
    expect(mocks.send).toHaveBeenCalledOnce()
    expect(core.cancellationStatus.value).toBe('hard_confirmed')
  })
})
