import { describe, expect, it } from 'vitest'
import { stringToHex } from 'viem'
import { bytes32ToString } from '~/utils/erc20-metadata'

describe('bytes32ToString', () => {
  it('decodes a right-NUL-padded bytes32 name to its string (e.g. MKR returns bytes32 "Maker")', () => {
    expect(bytes32ToString(stringToHex('Maker', { size: 32 }))).toBe('Maker')
  })

  it('decodes a bytes32 symbol', () => {
    expect(bytes32ToString(stringToHex('MKR', { size: 32 }))).toBe('MKR')
  })

  it('returns an empty string for an all-zero bytes32', () => {
    expect(bytes32ToString(stringToHex('', { size: 32 }))).toBe('')
  })
})
