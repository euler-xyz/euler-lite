import { createError } from 'h3'

const PRODUCT_ID_MAX_LEN = 100
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

export const parsePublicMetadataProductId = (rawProductId: unknown): string | null => {
  if (Array.isArray(rawProductId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid productId' })
  }

  if (typeof rawProductId !== 'string' || rawProductId.length === 0) {
    return null
  }

  if (rawProductId.length > PRODUCT_ID_MAX_LEN || !PRODUCT_ID_PATTERN.test(rawProductId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid productId' })
  }

  return rawProductId
}
