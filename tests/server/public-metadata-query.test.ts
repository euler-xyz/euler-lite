import { describe, expect, it } from 'vitest'
import { parsePublicMetadataProductId } from '~/server/utils/public-metadata-query'

describe('parsePublicMetadataProductId', () => {
  it('returns null when productId is omitted or empty', () => {
    expect(parsePublicMetadataProductId(undefined)).toBe(null)
    expect(parsePublicMetadataProductId('')).toBe(null)
  })

  it('accepts a valid productId', () => {
    expect(parsePublicMetadataProductId('euler-prime')).toBe('euler-prime')
    expect(parsePublicMetadataProductId('Euler_Prime_1')).toBe('Euler_Prime_1')
  })

  it('rejects invalid productId values', () => {
    expect(() => parsePublicMetadataProductId('bad.dot')).toThrow('Invalid productId')
    expect(() => parsePublicMetadataProductId('x'.repeat(101))).toThrow('Invalid productId')
  })

  it('rejects repeated productId query params instead of treating the filter as absent', () => {
    expect(() => parsePublicMetadataProductId(['euler-prime', 'bad.dot'])).toThrow('Invalid productId')
    expect(() => parsePublicMetadataProductId(['bad.dot', 'euler-prime'])).toThrow('Invalid productId')
  })
})
