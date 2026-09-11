import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { maxUint256, parseUnits } from 'viem'
import type { EVault, SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { useMultiplyCowSwap } from '~/composables/borrow/useMultiplyCowSwap'
import { valueToNano } from '~/utils/crypto-utils'

const mocks = vi.hoisted(() => ({ error: vi.fn(), getNewSubAccount: vi.fn() }))
vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({ error: mocks.error }) }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ close: vi.fn() }) }))
vi.mock('~/composables/useSubAccounts', () => ({ getNewSubAccount: mocks.getNewSubAccount }))
vi.mock('~/utils/moooler-sound', () => ({ prepareMooolerSound: vi.fn(), playMooolerSound: vi.fn() }))
vi.mock('~/composables/cowswap', () => ({
  useCowSwapOpenPositionExecution: () => ({ reset: vi.fn(), status: ref('idle'), orderUid: ref(null) }),
  useCowSwapOrderStatus: () => ({ orderStatus: ref(null) }),
  openCowSwapReviewModal: vi.fn(), buildApprovalSignSteps: vi.fn(),
}))

const address = '0x0000000000000000000000000000000000000001'
const subAccount = '0x0000000000000000000000000000000000000002'
const createForm = (deposit: string, output: string, cap: bigint, decimals: number) => {
  const vault = { address, asset: { address, decimals }, caps: { supplyCap: cap }, totalAssets: parseUnits('900', decimals) } as unknown as EVault
  const quote = { amountOut: parseUnits(output, decimals).toString(), accountIn: subAccount, accountOut: subAccount } as unknown as SwapQuote
  const options = {
    multiplySupplyVault: computed(() => vault), multiplyLongVault: computed(() => vault), multiplyShortVault: computed(() => vault),
    multiplyInputAmount: ref(deposit), multiplyDebtAmountNano: computed(() => 1n), multiplyErrorText: computed(() => null),
    multiplySelectedQuote: computed(() => quote), multiplySelectedProvider: computed(() => null), multiplyEffectiveQuote: computed(() => quote),
    account: computed(() => undefined),
  } as Parameters<typeof useMultiplyCowSwap>[0]
  return useMultiplyCowSwap(options)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getNewSubAccount.mockResolvedValue(subAccount)
  vi.stubGlobal('valueToNano', valueToNano)
  vi.stubGlobal('useWagmi', () => ({ address: ref(address) }))
  vi.stubGlobal('useRouter', () => ({}))
  vi.stubGlobal('useRpcClient', () => ({ client: ref(null) }))
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
