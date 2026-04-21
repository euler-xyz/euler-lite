import { describe, expect, it } from 'vitest'
import {
  compactSignatureToSignature,
  serializeCompactSignature,
  serializeSignature,
  type Hex,
} from 'viem'
import { normalizeCowSignature } from '~/entities/cowswap/signature'

describe('normalizeCowSignature', () => {
  it('preserves standard 65-byte signatures', () => {
    const signature = serializeSignature({
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
      v: 27n,
    }) as Hex

    expect(normalizeCowSignature(signature)).toBe(signature)
  })

  it('expands compact signatures to standard 65-byte form', () => {
    const compact = serializeCompactSignature({
      r: `0x${'33'.repeat(32)}`,
      yParityAndS: `0x${'44'.repeat(32)}`,
    }) as Hex

    const expected = serializeSignature(compactSignatureToSignature({
      r: `0x${'33'.repeat(32)}`,
      yParityAndS: `0x${'44'.repeat(32)}`,
    })) as Hex

    expect(normalizeCowSignature(compact)).toBe(expected)
  })
})
