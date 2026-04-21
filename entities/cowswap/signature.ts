import {
  compactSignatureToSignature,
  parseCompactSignature,
  parseSignature,
  serializeSignature,
  type Hex,
} from 'viem'

const STANDARD_SIGNATURE_HEX_LENGTH = 132
const COMPACT_SIGNATURE_HEX_LENGTH = 130

/** Normalize wallet signatures to 65-byte r||s||v form expected by CoW/Inbox contracts. */
export const normalizeCowSignature = (signature: Hex): Hex => {
  if (signature.length === STANDARD_SIGNATURE_HEX_LENGTH) {
    return serializeSignature(parseSignature(signature))
  }

  if (signature.length === COMPACT_SIGNATURE_HEX_LENGTH) {
    return serializeSignature(compactSignatureToSignature(parseCompactSignature(signature)))
  }

  throw new Error(`Unsupported signature length: ${signature.length}`)
}
