import { describe, expect, it, vi } from 'vitest'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { allowanceReadIssues, approvalAssetsWithSpenders, fetchWalletForApprovals } from '~/features/reviewed-execution/planning/approval-reads'

const token = '0x0000000000000000000000000000000000000021'
const vault = '0x0000000000000000000000000000000000000011'
const other = '0x0000000000000000000000000000000000000012'
const owner = '0x0000000000000000000000000000000000000002'

describe('approval reads', () => {
  it('collects one spender list per token from the plan', () => {
    const plan = [
      { type: 'requiredApproval', token, owner, spender: vault, amount: 1n },
      { type: 'requiredApproval', token: token.toUpperCase().replace('0X', '0x'), owner, spender: other, amount: 1n },
      { type: 'requiredApproval', token, owner, spender: vault, amount: 2n },
    ] as unknown as TransactionPlan
    expect(approvalAssetsWithSpenders(plan)).toEqual([{ asset: token, spenders: [vault, other] }])
  })

  it('keeps only allowance read failures', () => {
    expect(allowanceReadIssues([
      { source: 'erc20.allowance', message: 'a' },
      { source: 'permit2.allowance', message: 'b' },
      { source: 'erc20.balanceOf', message: 'c' },
      { message: 'd' },
    ]).map(issue => issue.message)).toEqual(['a', 'b'])
  })

  it('retries once after a failed allowance read and reports a persistent failure', async () => {
    const failed = { result: 'first', errors: [{ source: 'erc20.allowance', message: 'Failed to fetch Permit2 allowance approval; defaulted to 0.' }] }
    const clean = { result: 'second', errors: [] }
    const fetchWallet = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(clean)
    const wait = vi.fn().mockResolvedValue(undefined)
    expect(await fetchWalletForApprovals(fetchWallet, wait)).toEqual({ wallet: 'second', allowanceIssues: [] })
    expect(fetchWallet).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)

    const stillFailing = vi.fn().mockResolvedValue(failed)
    const outcome = await fetchWalletForApprovals(stillFailing, wait)
    expect(outcome.wallet).toBe('first')
    expect(outcome.allowanceIssues.map(issue => issue.message)).toEqual([failed.errors[0].message])
    expect(stillFailing).toHaveBeenCalledTimes(2)
  })

  it('does not retry when the reads succeeded', async () => {
    const fetchWallet = vi.fn().mockResolvedValue({ result: 'ok', errors: [{ source: 'erc20.balanceOf', message: 'ignored' }] })
    const wait = vi.fn()
    expect(await fetchWalletForApprovals(fetchWallet, wait)).toEqual({ wallet: 'ok', allowanceIssues: [] })
    expect(fetchWallet).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })
})
