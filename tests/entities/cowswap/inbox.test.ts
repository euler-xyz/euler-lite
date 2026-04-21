import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { buildInboxSignature } from '~/entities/cowswap/inbox'

describe('buildInboxSignature', () => {
  it('concatenates the owner signature and encoded order without a prepended verifier address', () => {
    const ecdsaSignature = `0x${'aa'.repeat(65)}` as Hex
    const orderEncodeData = `0x${'bb'.repeat(384)}` as Hex

    const result = buildInboxSignature(ecdsaSignature, orderEncodeData)

    expect(result.startsWith(ecdsaSignature.slice(0, 12))).toBe(true)
    expect(result.slice(2, 2 + 130)).toBe(ecdsaSignature.slice(2))
    expect(result.endsWith(orderEncodeData.slice(2))).toBe(true)
  })
})
