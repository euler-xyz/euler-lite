import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { maxUint256, parseUnits } from 'viem'
import type { EVault, SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { useMultiplyCowSwap } from '~/composables/borrow/useMultiplyCowSwap'
import { valueToNano } from '~/utils/crypto-utils'

const mocks = vi.hoisted(() => ({ error: vi.fn(), getNewSubAccount: vi.fn(), showReview: vi.fn(), approvalSteps: vi.fn(), readContract: vi.fn() }))
vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({ error: mocks.error }) }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ close: vi.fn() }) }))
vi.mock('~/composables/useSubAccounts', () => ({ getNewSubAccount: mocks.getNewSubAccount }))
vi.mock('~/utils/moooler-sound', () => ({ prepareMooolerSound: vi.fn(), playMooolerSound: vi.fn() }))
vi.mock('~/composables/cowswap', () => ({
  useCowSwapOpenPositionExecution: () => ({ reset: vi.fn(), status: ref('idle'), orderUid: ref(null) }),
  useCowSwapOrderStatus: () => ({ orderStatus: ref(null) }),
  openCowSwapReviewModal: mocks.showReview, buildApprovalSignSteps: mocks.approvalSteps,
}))

vi.mock('~/entities/cowswap', async original => ({
  ...await original<typeof import('~/entities/cowswap')>(),
  getCowSwapQuoteOrderAmounts: () => ({ sellAmount: 1n, buyAmount: 1n }),
}))

const address = '0x0000000000000000000000000000000000000001'
const subAccount = '0x0000000000000000000000000000000000000002'
const createForm = (deposit: string, output: string, cap: bigint, decimals: number) => {
  const vault = { address, asset: { address, decimals }, caps: { supplyCap: cap }, totalShares: parseUnits('900', decimals), totalAssets: parseUnits('900', decimals) } as unknown as EVault
  const quote = { amountOut: parseUnits(output, decimals).toString(), accountIn: subAccount, accountOut: subAccount } as unknown as SwapQuote
  const outputAmount = ref(output)
  const options = {
    multiplySupplyVault: computed(() => vault), multiplyLongVault: computed(() => vault), multiplyShortVault: computed(() => vault),
    multiplyInputAmount: ref(deposit), multiplyDebtAmountNano: computed(() => 1n), multiplyErrorText: computed(() => null),
    multiplySelectedQuote: computed(() => quote), multiplySelectedProvider: computed(() => null), multiplyEffectiveQuote: computed(() => quote),
    account: computed(() => ({})), multiplySlippage: ref(0.5),
    multiplySupplyProduct: computed(() => ({ name: 'Supply' })), multiplyShortProduct: computed(() => ({ name: 'Borrow' })),
    multiplyLongAmount: computed(() => outputAmount.value), multiplyEffectiveQuoteFetchedAt: computed(() => 123),
  } as Parameters<typeof useMultiplyCowSwap>[0]
  return { ...useMultiplyCowSwap(options), input: options.multiplyInputAmount, output: outputAmount }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getNewSubAccount.mockResolvedValue(subAccount)
  mocks.approvalSteps.mockReturnValue({ steps: [], nextIndex: 1 })
  mocks.readContract.mockResolvedValue(0n)
  vi.stubGlobal('valueToNano', valueToNano)
  vi.stubGlobal('useWagmi', () => ({ address: ref(address) }))
  vi.stubGlobal('useRouter', () => ({}))
  vi.stubGlobal('useRpcClient', () => ({ client: ref({ readContract: mocks.readContract }) }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useEulerAccount', () => ({ refreshAllPositions: vi.fn() }))
})
afterEach(() => vi.unstubAllGlobals())

describe('CoW multiply supply capacity', () => {
  it.each([6, 18])('blocks the combined deposits exceeding remaining capacity (%i decimals)', async (decimals) => {
    await createForm('60', '60', parseUnits('1000', decimals), decimals).submitCowSwapMultiply()
    expect(mocks.error).toHaveBeenCalledWith('Long vault supply cap would be exceeded')
    expect(mocks.getNewSubAccount).not.toHaveBeenCalled()
  })

  it.each(['39', '40'])('allows combined deposits below or at the cap (output %s)', async (output) => {
    await createForm('60', output, parseUnits('1000', 6), 6).submitCowSwapMultiply()
    expect(mocks.error).not.toHaveBeenCalledWith('Long vault supply cap would be exceeded')
    expect(mocks.getNewSubAccount).toHaveBeenCalledOnce()
  })

  it.each([0n, maxUint256])('preserves unlimited cap behavior (%s)', async (cap) => {
    await createForm('60', '60', cap, 6).submitCowSwapMultiply()
    expect(mocks.error).not.toHaveBeenCalledWith('Long vault supply cap would be exceeded')
    expect(mocks.getNewSubAccount).toHaveBeenCalledOnce()
  })
})

it.each(['sub-account', 'allowance'])('keeps the captured deposit in review while %s lookup is pending', async (pendingStage) => {
  let resolve!: () => void
  const gate = new Promise<void>((done) => {
    resolve = done
  })
  if (pendingStage === 'sub-account') {
    mocks.getNewSubAccount.mockImplementationOnce(async () => {
      await gate
      return subAccount
    })
  }
  else {
    mocks.readContract.mockImplementationOnce(async () => {
      await gate
      return 0n
    })
  }
  const form = createForm('60', '20', parseUnits('1000', 6), 6)
  const submitted = form.submitCowSwapMultiply()
  await vi.waitFor(() => expect(pendingStage === 'sub-account' ? mocks.getNewSubAccount : mocks.readContract).toHaveBeenCalled())
  form.input.value = '1'
  form.output.value = ''
  resolve()
  await submitted

  expect(mocks.showReview).toHaveBeenCalledOnce()
  const review = mocks.showReview.mock.calls[0][1]
  expect(review.executeParams.collateralAmount).toBe(parseUnits('60', 6))
  expect(review.executeParams.swapQuote.amountOut).toBe(parseUnits('20', 6).toString())
  expect(review.wrapperSteps).toContainEqual(expect.objectContaining({
    label: 'Swap', toAssetInfo: expect.objectContaining({ amount: '20' }),
  }))
  expect(review.wrapperSteps).toContainEqual(expect.objectContaining({
    label: 'Supply', assetInfo: expect.objectContaining({ amount: '60' }),
  }))
  expect(mocks.approvalSteps).toHaveBeenCalledWith(expect.objectContaining({
    label: 'Approve for deposit', requiredAmount: parseUnits('60', 6),
    assetInfo: expect.objectContaining({ amount: '60' }),
  }))
})
