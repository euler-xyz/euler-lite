import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time string comparison for secrets carried in headers/cookies.
 * Compares byte lengths, not string lengths: a multibyte value can match
 * the character count while timingSafeEqual throws on unequal buffers.
 */
export function timingSafeEqualStrings(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  if (providedBuffer.length !== expectedBuffer.length) {
    return false
  }
  return timingSafeEqual(providedBuffer, expectedBuffer)
}
