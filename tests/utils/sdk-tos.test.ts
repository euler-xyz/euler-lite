import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import {
  assertPreparedPlanLiteTosContextCurrent,
  bindLiteTosContextToPreparedPlan,
  clearLiteTosSignature,
  getLiteTosContextVersion,
  setLiteTosSignature,
} from '~/utils/sdk-tos'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'

const ACCOUNT = getAddress('0x00000000000000000000000000000000000000a1')
const TOS_HASH = `0x${'11'.repeat(32)}` as const

describe('SDK TOS context version', () => {
  it('changes only when the effective signature store changes', () => {
    clearLiteTosSignature({ chainId: 1, account: ACCOUNT })
    const initial = getLiteTosContextVersion()

    setLiteTosSignature({
      chainId: 1,
      account: ACCOUNT,
      tosMessage: 'current terms',
      tosMessageHash: TOS_HASH,
    })
    expect(getLiteTosContextVersion()).toBe(initial + 1)

    setLiteTosSignature({
      chainId: 1,
      account: ACCOUNT,
      tosMessage: 'current terms',
      tosMessageHash: TOS_HASH,
    })
    expect(getLiteTosContextVersion()).toBe(initial + 1)

    clearLiteTosSignature({ chainId: 1, account: ACCOUNT })
    expect(getLiteTosContextVersion()).toBe(initial + 2)
  })

  it('rejects a tracked prepared plan after the signature store changes', () => {
    clearLiteTosSignature({ chainId: 1, account: ACCOUNT })
    const prepared = {} as TransactionPlanPrepared
    bindLiteTosContextToPreparedPlan(prepared)
    expect(() => assertPreparedPlanLiteTosContextCurrent(prepared)).not.toThrow()

    setLiteTosSignature({
      chainId: 1,
      account: ACCOUNT,
      tosMessage: 'current terms',
      tosMessageHash: TOS_HASH,
    })
    expect(() => assertPreparedPlanLiteTosContextCurrent(prepared))
      .toThrow('Terms of Use context changed')

    clearLiteTosSignature({ chainId: 1, account: ACCOUNT })
  })
})
