import { getAddress } from 'viem'

/**
 * Normalize an address to checksummed form, returning empty string on failure.
 * Different from `utils/normalizeAddress.ts` which returns lowercase on failure.
 */
export const normalizeAddressOrEmpty = (value?: string | null): string => {
  if (!value) return ''
  try {
    return getAddress(value)
  }
  catch {
    return ''
  }
}
