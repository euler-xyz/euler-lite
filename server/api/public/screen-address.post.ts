import { createError, readBody } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { deriveVpnIsUsed, isValidScreeningAddress, screenAddressUpstream } from '~/server/utils/screening'

// Screening endpoint for first-party Euler SPAs that have no server of their
// own (create/redemptions/maglev). Browser access is limited to
// *.euler.finance origins by server/middleware/cors.ts; the contract is
// documented in docs/public-api.md.
const rateLimiter = createRateLimiter({
  max: 10,
  windowMs: 60_000,
  label: 'public-screen-address',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const body = await readBody(event)

  if (!body || !isValidScreeningAddress(body.address)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid address' })
  }

  return screenAddressUpstream(body.address, deriveVpnIsUsed(event), 'public-screen-address')
})
