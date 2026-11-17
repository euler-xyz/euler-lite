import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, markRaw, reactive, ref, toRaw } from 'vue'
import { Account, type EVault, type SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { getAddress, maxUint256, type Address } from 'viem'
import { useCowSwapCollateralSwapReview } from '~/composables/cowswap/useCowSwapCollateralSwapReview'
import type { CowSwapCollateralSwapExecuteParams } from '~/composables/cowswap/useCowSwapCollateralSwapExecution'
import type { CowSwapExecutionStatus } from '~/entities/cowswap'
import { buildSdkExecutionService } from '../golden/harness'

const mocks = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), error: vi.fn(), readContract: vi.fn() }))
vi.mock('#components', () => ({ CowSwapReviewModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: mocks.open, close: mocks.close }) }))
vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({ error: mocks.error }) }))
vi.mock('~/utils/errorHandling', () => ({ logWarn: vi.fn() }))

const MODAL_ID = 7
const OWNER = '0x1111111111111111111111111111111111111111'
const SUB_ACCOUNT = '0x1111111111111111111111111111111111111101'
const SOURCE = getAddress('0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9')
const B = getAddress('0x998D761eC1BAdaCeb064624cc3A1d37A46C88bA4')
const C = getAddress('0xbC4B4AC47582c3E38Ce5940B80Da65401F4628f1')
const makeVault = (address: Address, symbol: string, decimals: number) => ({
  address, asset: { address, symbol, decimals }, totalShares: 1_000_000n, totalAssets: 1_000_000n,
}) as EVault
const makeAccount = () => markRaw(new Account({ chainId: 1, owner: OWNER, subAccounts: {} }))
const vaultC = makeVault(C, 'wstETH', 18)
const makeQuote = (receiver = B): SwapQuote => ({
  vaultIn: SOURCE,
  receiver,
  accountIn: SUB_ACCOUNT,
  accountOut: SUB_ACCOUNT,
  amountIn: '1000000',
  slippage: 0.5,
  // The route name the swap API really sends for CoW. It is not the provider key `cow`.
  route: [{ providerName: 'CoW Protocol' }],
  providerData: { sellAmount: '999990', feeAmount: '10', buyAmount: receiver === B ? '129610' : '30159760000000000' },
}) as unknown as SwapQuote

const scopes: ReturnType<typeof effectScope>[] = []
const createForm = () => {
  const state = reactive({
    enabled: true,
    chainId: 1,
    owner: OWNER as Address,
    subAccount: SUB_ACCOUNT as Address,
    account: makeAccount() as ReturnType<typeof makeAccount> | undefined,
    fromVault: makeVault(SOURCE, 'USDC', 6),
    toVault: makeVault(B, 'WBTC', 8),
    quote: makeQuote() as SwapQuote | null,
    collateralShares: 1_000_000n,
    collateralAssets: 1_000_000n,
    slippage: 0.5,
    quoteFetchedAt: 123,
  })
  const execution = {
    reset: vi.fn(),
    executeAsync: vi.fn(async (_params: CowSwapCollateralSwapExecuteParams) => 'order-uid' as const),
    cancelOrder: vi.fn(),
    status: ref<CowSwapExecutionStatus>('idle'),
    error: ref<Error | null>(null),
    orderUid: ref(undefined),
    isPending: computed(() => false),
    explorerUrl: computed(() => undefined),
    locallyCancelled: ref(false),
    cancellationMode: ref(undefined),
    cancellationStatus: ref('none' as const),
  }
  const scope = effectScope()
  scopes.push(scope)
  const review = scope.run(() => useCowSwapCollateralSwapReview({
    getInput: () => state.enabled && state.quote ? { ...state, quote: state.quote } : undefined,
    execution,
    orderStatus: { orderStatus: ref(null) } as Parameters<typeof useCowSwapCollateralSwapReview>[0]['orderStatus'],
  }))!
  return { state, execution, scope, ...review }
}
type Form = ReturnType<typeof createForm>
const modalProps = () => mocks.open.mock.lastCall![1].props
const holdAllowance = () => {
  const pending = Promise.withResolvers<bigint>()
  mocks.readContract.mockReturnValueOnce(pending.promise)
  return pending
}
const settleAllowance = (pending: ReturnType<typeof holdAllowance>, outcome: string) => {
  if (outcome === 'rejected') pending.reject(new Error('RPC unavailable'))
  else pending.resolve(outcome === 'approved' ? maxUint256 : 0n)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.open.mockReturnValue(MODAL_ID)
  mocks.readContract.mockResolvedValue(maxUint256)
  vi.stubGlobal('useRpcClient', () => ({ client: ref({ readContract: mocks.readContract }) }))
})
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.unstubAllGlobals()
})

describe.each(['approved', 'zero', 'rejected'])('CoW collateral review with %s allowance', (outcome) => {
  it('keeps an unchanged B review aligned with the SDK order and wrapper', async () => {
    const form = createForm()
    const pending = holdAllowance()
    const submitted = form.submit()
    expect(mocks.readContract).toHaveBeenCalledOnce()
    settleAllowance(pending, outcome)
    await submitted

    expect(mocks.open).toHaveBeenCalledOnce()
    const props = modalProps()
    expect(props.wrapperSteps[0]).toMatchObject({ label: 'Enable collateral', labelSuffix: 'WBTC' })
    expect(props.wrapperSteps.find((step: { label: string }) => step.label === 'Swap').toAssetInfo)
      .toMatchObject({ symbol: 'WBTC', amount: '0.0012961' })
    expect(props.signSteps.some((step: { label: string }) => step.label === 'Approve for swap')).toBe(outcome !== 'approved')
    expect(props.quoteFetchedAt).toBe(123)
    await props.onConfirm()
    expect(form.execution.executeAsync).toHaveBeenCalledOnce()
    const params = form.execution.executeAsync.mock.lastCall![0]
    const plan = buildSdkExecutionService().planSwapCollateralWithCoW(params)
    expect(plan[0]).toMatchObject({ type: 'cowSwap', kind: 'swapCollateral', params: { buyToken: B, wrapper: { toVault: B } } })
    expect(params.swapQuote).not.toBe(toRaw(form.state.quote))
  })

  it.each(['reselect C', 'no reselection', 'quote not refreshed'])('aborts a pending B preparation after switching to C: %s', async (selection) => {
    const form = createForm()
    const pending = holdAllowance()
    const submitted = form.submit()
    form.state.toVault = vaultC
    if (selection !== 'quote not refreshed') form.state.quote = null
    if (selection === 'reselect C') form.state.quote = makeQuote(C)
    settleAllowance(pending, outcome)
    await submitted

    expect(mocks.open).not.toHaveBeenCalled()
    expect(form.execution.executeAsync).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('Collateral swap changed'))
  })
})

it('rejects an already stale quote when the form target changed before Review', async () => {
  const form = createForm()
  form.state.toVault = vaultC
  await form.submit()
  expect(mocks.readContract).not.toHaveBeenCalled()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('Collateral swap changed'))
})

it('allows a fresh C review after cancelling B preparation', async () => {
  const form = createForm()
  const pending = holdAllowance()
  const submitted = form.submit()
  form.state.toVault = vaultC
  form.state.quote = makeQuote(C)
  pending.resolve(maxUint256)
  await submitted
  await form.submit()
  expect(mocks.open).toHaveBeenCalledOnce()
  expect(modalProps().wrapperSteps[0].labelSuffix).toBe('wstETH')
  await modalProps().onConfirm()
  const plan = buildSdkExecutionService().planSwapCollateralWithCoW(form.execution.executeAsync.mock.lastCall![0])
  expect(plan[0]).toMatchObject({ params: { buyToken: C, wrapper: { toVault: C } } })
})

const changes: Record<string, (form: Form) => void> = {
  'target': (form) => { form.state.toVault = vaultC },
  'source': (form) => { form.state.fromVault = vaultC },
  'owner': (form) => { form.state.owner = SUB_ACCOUNT },
  'chain': (form) => { form.state.chainId = 56 },
  'position': (form) => { form.state.subAccount = OWNER },
  'shares': (form) => { form.state.collateralShares++ },
  'assets': (form) => { form.state.collateralAssets++ },
  'slippage': (form) => { form.state.slippage = 1 },
  'quote time': (form) => { form.state.quoteFetchedAt = 456 },
  // A refetched quote is a new object, even when its content is the same.
  'quote replacement': (form) => { form.state.quote = makeQuote() },
  'route cleared': (form) => { form.state.quote = null },
  'CoW disabled': (form) => { form.state.enabled = false },
  'page disposed': (form) => { form.scope.stop() },
}

it.each(Object.entries(changes))('closes the review instead of executing when %s changes before Confirm', async (_name, change) => {
  const form = createForm()
  await form.submit()
  change(form)
  await modalProps().onConfirm()
  expect(form.execution.executeAsync).not.toHaveBeenCalled()
  // The stale review is closed with a toast, not left open with a Confirm that cannot work.
  expect(mocks.close).toHaveBeenCalledWith(MODAL_ID)
  expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('Collateral swap changed'))
  expect(form.execution.error.value).toBeNull()
})

// The app replaces vault and account objects on every refetch. Equal data must not
// cancel a review, neither during the allowance read nor at Confirm.
const refetches: Record<string, (form: Form) => void> = {
  'target vault': (form) => { form.state.toVault = makeVault(B, 'WBTC', 8) },
  'source vault': (form) => { form.state.fromVault = makeVault(SOURCE, 'USDC', 6) },
  'account': (form) => { form.state.account = makeAccount() },
}

it.each(Object.entries(refetches))('keeps the review valid when the %s is refetched with the same data', async (_name, refetch) => {
  const form = createForm()
  const pending = holdAllowance()
  const submitted = form.submit()
  refetch(form)
  pending.resolve(maxUint256)
  await submitted
  expect(mocks.open).toHaveBeenCalledOnce()

  refetch(form)
  await modalProps().onConfirm()
  expect(form.execution.executeAsync).toHaveBeenCalledOnce()
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.error).not.toHaveBeenCalled()
})

it('executes the reviewed copy even if the live quote object is edited afterwards', async () => {
  const form = createForm()
  await form.submit()
  // Real quotes are plain objects, so an in-place edit is invisible to the form.
  toRaw(form.state.quote!).providerData!.buyAmount = '1'
  await modalProps().onConfirm()
  expect(form.execution.executeAsync.mock.lastCall![0].swapQuote.providerData!.buyAmount).toBe('129610')
})

it('captures vault presentation and quote data before the allowance read', async () => {
  const form = createForm()
  const pending = holdAllowance()
  const submitted = form.submit()
  // Background metadata updates must not rewrite the captured presentation.
  form.state.toVault.asset.symbol = 'Changed'
  form.state.toVault.totalAssets *= 2n
  pending.resolve(maxUint256)
  await submitted
  expect(modalProps().wrapperSteps[0].labelSuffix).toBe('WBTC')
  expect(modalProps().wrapperSteps.find((step: { label: string }) => step.label === 'Swap').toAssetInfo.amount).toBe('0.0012961')
  await modalProps().onConfirm()
  expect(form.execution.executeAsync).toHaveBeenCalledOnce()
})

it('accepts a quote whose underlying valuation differs from the cached position rate', async () => {
  const form = createForm()
  form.state.quote!.amountIn = '1000001'
  await form.submit()
  await modalProps().onConfirm()
  expect(form.execution.executeAsync).toHaveBeenCalledOnce()
})

it('says so when the account is not loaded yet', async () => {
  const form = createForm()
  form.state.account = undefined
  await form.submit()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledWith('Account not ready')
})

it('stays silent when the page is left during the allowance read', async () => {
  const form = createForm()
  const pending = holdAllowance()
  const submitted = form.submit()
  form.scope.stop()
  pending.resolve(maxUint256)
  await submitted
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.error).not.toHaveBeenCalled()
})
