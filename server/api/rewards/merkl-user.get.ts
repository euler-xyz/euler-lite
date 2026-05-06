import { createError, getQuery, setResponseHeader } from 'h3'
import { getAddress, isAddress } from 'viem'
import { MERKL_API_BASE_URL } from '~/entities/constants'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveChainId } from '~/server/utils/resolve-chain-id'

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'rewards-merkl-user-proxy',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const chainId = resolveChainId(event)
  const { address } = getQuery(event)
  if (typeof address !== 'string' || !isAddress(address)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid address' })
  }

  const userAddress = getAddress(address)
  const url = new URL(`/v4/users/${userAddress}/rewards`, MERKL_API_BASE_URL)
  url.searchParams.set('chainId', String(chainId))

  const response = await fetch(url)
  if (!response.ok) {
    throw createError({
      statusCode: 502,
      statusMessage: `Merkl upstream returned ${response.status}`,
    })
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return response.json()
})
