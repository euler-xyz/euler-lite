import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'

import { hasPermit2Signature, hasPermit2TokenApproval } from '~/utils/transactionPlanApprovals'

const owner = '0x0000000000000000000000000000000000000001' as Address
const token = '0x0000000000000000000000000000000000000002' as Address
const vault = '0x0000000000000000000000000000000000000003' as Address
const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address
const amount = 100n

type RequiredApproval = Extract<TransactionPlan[number], { type: 'requiredApproval' }>

const approvalPlan = (resolved: RequiredApproval['resolved']): TransactionPlan => [{
  type: 'requiredApproval',
  token,
  owner,
  spender: vault,
  amount,
  resolved,
}]

describe('transaction plan approval helpers', () => {
  it('does not treat a Permit2 signature-only plan as an infinite token approval', () => {
    const plan = approvalPlan([{
      type: 'permit2',
      token,
      owner,
      spender: vault,
      amount,
    }])

    expect(hasPermit2Signature(plan)).toBe(true)
    expect(hasPermit2TokenApproval(plan, permit2)).toBe(false)
  })

  it('detects the ERC20 token approval to Permit2', () => {
    const plan = approvalPlan([
      {
        type: 'approve',
        token,
        owner,
        spender: permit2,
        amount: 2n ** 256n - 1n,
        data: '0x',
      },
      {
        type: 'permit2',
        token,
        owner,
        spender: vault,
        amount,
      },
    ])

    expect(hasPermit2Signature(plan)).toBe(true)
    expect(hasPermit2TokenApproval(plan, permit2)).toBe(true)
    expect(hasPermit2TokenApproval(plan)).toBe(true)
  })

  it('ignores direct vault approval transactions', () => {
    const plan = approvalPlan([{
      type: 'approve',
      token,
      owner,
      spender: vault,
      amount,
      data: '0x',
    }])

    expect(hasPermit2Signature(plan)).toBe(false)
    expect(hasPermit2TokenApproval(plan, permit2)).toBe(false)
  })
})
