import { ref } from 'vue'
import { getAddress, type Address } from 'viem'
import type { TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import { useEulerTx } from '~/composables/useEulerTx'

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkForChain: vi.fn(),
  getEulerSdkFresh: vi.fn(),
}))

const OWNER = getAddress('0x1000000000000000000000000000000000000000')
const TOKEN = getAddress('0x3000000000000000000000000000000000000000')

describe('useEulerTx preparation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('useWagmi', () => ({ address: ref<Address | undefined>(OWNER), chainId: ref<number | undefined>(1) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false), spyAddress: ref(undefined) }))
    vi.stubGlobal('useSignaturePreference', () => ({ signaturesEnabled: ref(true) }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  })

  it('prepares a plan with the caller-pinned signature mode', async () => {
    const prepare = vi.fn().mockResolvedValue({ kind: 'prepared' })
    vi.mocked(getEulerSdkForChain).mockResolvedValue({
      executionService: { prepareTransactionPlan: prepare },
    } as never)

    await useEulerTx().prepareTransactionPlan([] as TransactionPlan, { usePermit2: false })

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ usePermit2: false }))
  })

  it('passes migration state overrides through prepared simulation', async () => {
    const simulate = vi.fn().mockResolvedValue({ kind: 'simulated' })
    vi.mocked(getEulerSdkForChain).mockResolvedValue({
      executionService: { simulatePreparedTransactionPlan: simulate },
    } as never)
    const prepared = {
      __prepared: true,
      plan: [],
      chainId: 1,
      account: OWNER,
      usePermit2: false,
      unlimitedApproval: false,
    } as TransactionPlanPrepared
    const overrides = [{ address: TOKEN, stateDiff: [] }]

    await useEulerTx().simulatePreparedPlan(prepared, undefined, overrides as never)

    expect(simulate).toHaveBeenCalledWith(prepared, expect.objectContaining({
      extraStateOverrides: overrides,
    }))
  })

  it('does not expose wallet execution entry points', () => {
    const tx = useEulerTx() as unknown as Record<string, unknown>

    expect(tx.executePlan).toBeUndefined()
    expect(tx.executePreparedPlan).toBeUndefined()
    expect(tx.executePreparedPlanWithPlainCalls).toBeUndefined()
    expect(tx.signMigrationAuthorization).toBeUndefined()
    expect(tx.sendPlainTransactions).toBeUndefined()
  })
})
