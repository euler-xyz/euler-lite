import { ref } from 'vue'
import { getAddress, type Address } from 'viem'
import { Account, type IHasVaultAddress, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getEulerSdkForChain, getEulerSdkFresh } from '~/composables/useEulerSdk'
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

describe('post-confirmation planner boundary', () => {
  it('rejects an explicitly provided stale account before calling the SDK planner', async () => {
    const { requireFreshPlanningAccount, readFreshPlanningAccount } = await import('~/utils/planning-account-freshness')
    const { assertRuntimeAccountContext } = await import('~/features/reviewed-execution/planning/app-snapshot')
    const stale = new Account<IHasVaultAddress>({ chainId: 1, owner: OWNER, subAccounts: {} })
    const planDeposit = vi.fn().mockResolvedValue([])
    vi.mocked(getEulerSdkFresh).mockResolvedValue({ executionService: { planDeposit } } as never)
    vi.stubGlobal('useWagmi', () => ({ address: ref(OWNER), chainId: ref(1) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false), spyAddress: ref(undefined) }))
    vi.stubGlobal('useSignaturePreference', () => ({ signaturesEnabled: ref(true) }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    requireFreshPlanningAccount(1, 100n, async () => {})
    await expect(useEulerTx().planDeposit({ vaultAddress: TOKEN, assetAddress: TOKEN, amount: 1n, account: stale }))
      .rejects.toThrow('Account is updating')
    expect(() => assertRuntimeAccountContext(stale, OWNER, 1)).toThrow('Account is updating')
    expect(planDeposit).not.toHaveBeenCalled()
    const fresh = await readFreshPlanningAccount(1, async () => new Account<IHasVaultAddress>({ chainId: 1, owner: OWNER, subAccounts: {} }))
    await useEulerTx().planDeposit({ vaultAddress: TOKEN, assetAddress: TOKEN, amount: 1n, account: fresh })
    expect(planDeposit).toHaveBeenCalledWith(expect.objectContaining({ account: fresh }))
  })
})
