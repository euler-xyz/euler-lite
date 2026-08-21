import { createError, readBody } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { deriveVpnIsUsed, isValidScreeningAddress, screenAddressUpstream } from '~/server/utils/screening'

const rateLimiter = createRateLimiter({
  max: 10,
  windowMs: 60_000,
  label: 'screen-address',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const body = await readBody(event)

  if (!body || !isValidScreeningAddress(body.address)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid address' })
  }

  return screenAddressUpstream(body.address, deriveVpnIsUsed(event), 'screen-address')
})
