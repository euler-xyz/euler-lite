import { createError, getQuery, setResponseHeader } from 'h3'
import { getAddress, isAddress } from 'viem'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveRpcUrl } from '~/server/utils/rpc'
import { getVerifiedAddressSnapshot, getVerifiedAddressCacheControl } from '~/server/utils/verified-vaults'
import { logger } from '~/server/utils/logger'

const MAX_ADDRESSES = 100

const rateLimiter = createRateLimiter({
  max: 100,
  windowMs: 60_000,
  label: 'public-is-known',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const query = getQuery(event)

  const chainId = Number(query.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }
  if (!resolveRpcUrl(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported chainId' })
  }

  const rawInput = query.addresses
  const raw = Array.isArray(rawInput)
    ? rawInput.filter((v): v is string => typeof v === 'string').join(',')
    : typeof rawInput === 'string' ? rawInput : ''
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length > MAX_ADDRESSES) {
    throw createError({ statusCode: 400, statusMessage: `Too many addresses (max ${MAX_ADDRESSES})` })
  }

  const checksumed: string[] = []
  for (const addr of parts) {
    if (!isAddress(addr)) {
      throw createError({ statusCode: 400, statusMessage: `Invalid address: ${addr}` })
    }
    checksumed.push(getAddress(addr))
  }

  let verifiedSnapshot: Awaited<ReturnType<typeof getVerifiedAddressSnapshot>>
  try {
    verifiedSnapshot = await getVerifiedAddressSnapshot(chainId)
  }
  catch (err) {
    logger.warn({ ctx: 'public-is-known', chainId, err }, 'verified-address lookup failed')
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }

  // A hosted verdict's response cache cannot outlive its V3 read.
  const cacheControl = getVerifiedAddressCacheControl(verifiedSnapshot)
  setResponseHeader(event, 'Cache-Control', cacheControl)
  if (verifiedSnapshot.source === 'v3') {
    const cdnCacheControl = cacheControl.replace('max-age=', 's-maxage=')
    setResponseHeader(event, 'CDN-Cache-Control', cdnCacheControl)
    setResponseHeader(event, 'Cloudflare-CDN-Cache-Control', cdnCacheControl)
  }
  const verifiedSet = verifiedSnapshot.addresses

  const response: Record<string, boolean> = {}

  // No addresses supplied → list mode: emit the full known set as an object
  // with `true` values, preserving the lookup-mode response shape so callers
  // don't need to branch on input.
  if (checksumed.length === 0) {
    for (const addr of verifiedSet) response[addr] = true
    return response
  }

  for (const addr of checksumed) {
    response[addr] = verifiedSet.has(addr)
  }
  return response
})
