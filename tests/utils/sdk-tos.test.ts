import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import {
  clearLiteTosSignature,
  getLiteTosContextVersion,
  setLiteTosSignature,
} from '~/utils/sdk-tos'

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
})
