import { createError, getMethod, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { decodeAbiParameters, getFunctionSelector, type Hex } from 'viem'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveRpcUrl } from '~/server/utils/rpc'
import { isAbortError } from '~/utils/errorHandling'
import { BATCH_ITEM_COMPONENTS, BATCH_ITEM_RESULT_COMPONENTS } from '~/abis/evc'
import { vaultHexCache, vaultCacheKey } from '~/server/utils/vault-cache-store'

// ---------------------------------------------------------------------------
// Vault cache interception — passively caches vault lens results as they
// flow through the proxy. Never blocks or modifies the response.
// ---------------------------------------------------------------------------

const BATCH_SIMULATION_SELECTOR = getFunctionSelector('batchSimulation((address,address,uint256,bytes)[])')
const GET_VAULT_INFO_FULL_SELECTOR = getFunctionSelector('getVaultInfoFull(address)')
const GET_VAULT_INFO_ERC4626_SELECTOR = getFunctionSelector('getVaultInfoERC4626(address)')

interface ChainAddresses {
  evcAddress: string
  vaultLensAddress: string
  earnLensAddress: string
  utilsLensAddress: string
}

const chainAddressCache = new Map<number, ChainAddresses>()

async function getChainAddresses(chainId: number): Promise<ChainAddresses | undefined> {
  if (chainAddressCache.has(chainId)) return chainAddressCache.get(chainId)!
  try {
    const chains = await $fetch<Array<{
      chainId: number
      addresses: {
        coreAddrs: { evc: string }
        lensAddrs: { vaultLens: string, eulerEarnVaultLens: string, utilsLens: string }
      }
    }>>('/api/euler-chains')
    for (const chain of chains) {
      chainAddressCache.set(chain.chainId, {
        evcAddress: chain.addresses.coreAddrs.evc,
        vaultLensAddress: chain.addresses.lensAddrs.vaultLens,
        earnLensAddress: chain.addresses.lensAddrs.eulerEarnVaultLens,
        utilsLensAddress: chain.addresses.lensAddrs.utilsLens,
      })
    }
  }
  catch { /* euler-chains unavailable — skip caching */ }
  return chainAddressCache.get(chainId)
}

// ABI parameter definitions for decoding (avoids viem strict ABI type issues)
const BATCH_SIMULATION_INPUT_PARAMS = [
  { name: 'items', type: 'tuple[]', components: [...BATCH_ITEM_COMPONENTS] },
] as const

const BATCH_SIMULATION_OUTPUT_PARAMS = [
  { name: 'batchItemsResult', type: 'tuple[]', components: [...BATCH_ITEM_RESULT_COMPONENTS] },
  { name: 'accountsStatusResult', type: 'tuple[]', components: [{ name: 'account', type: 'address' }, { name: 'isValid', type: 'bool' }] },
  { name: 'vaultsStatusResult', type: 'tuple[]', components: [{ name: 'vault', type: 'address' }, { name: 'isValid', type: 'bool' }] },
] as const

const ADDRESS_PARAM = [{ name: 'vault', type: 'address' }] as const

/** Strip 4-byte function selector, return the parameter-encoded portion. */
const stripSelector = (calldata: string): Hex => (`0x${calldata.slice(10)}`) as Hex

function tryCacheSingleEthCall(
  chainId: number,
  to: string,
  data: string,
  resultHex: string,
  addresses: ChainAddresses,
): void {
  const toLower = to.toLowerCase()

  // Pattern 1: EVK vaults via EVC batchSimulation
  if (data.startsWith(BATCH_SIMULATION_SELECTOR) && toLower === addresses.evcAddress.toLowerCase()) {
    const [items] = decodeAbiParameters(BATCH_SIMULATION_INPUT_PARAMS, stripSelector(data))

    const vaultLensCalls: Array<{ index: number, vaultAddress: string }> = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].targetContract.toLowerCase() !== addresses.vaultLensAddress.toLowerCase()) continue
      if (!(items[i].data as string).startsWith(GET_VAULT_INFO_FULL_SELECTOR)) continue
      try {
        const [vaultAddr] = decodeAbiParameters(ADDRESS_PARAM, stripSelector(items[i].data as string))
        vaultLensCalls.push({ index: i, vaultAddress: vaultAddr })
      }
      catch { /* skip */ }
    }

    if (vaultLensCalls.length === 0) return

    const [batchResults] = decodeAbiParameters(BATCH_SIMULATION_OUTPUT_PARAMS, resultHex as Hex)

    for (const { index, vaultAddress } of vaultLensCalls) {
      const item = batchResults[index]
      if (item?.success && item.result) {
        vaultHexCache.set(vaultCacheKey(chainId, vaultAddress), item.result)
      }
    }
    return
  }

  // Patterns 2-4: direct eth_call to individual lens contracts
  let isVaultCall = false

  if (data.startsWith(GET_VAULT_INFO_FULL_SELECTOR)) {
    isVaultCall = toLower === addresses.vaultLensAddress.toLowerCase()
      || toLower === addresses.earnLensAddress.toLowerCase()
  }
  else if (data.startsWith(GET_VAULT_INFO_ERC4626_SELECTOR)) {
    isVaultCall = toLower === addresses.utilsLensAddress.toLowerCase()
  }

  if (!isVaultCall) return

  const [vaultAddress] = decodeAbiParameters(ADDRESS_PARAM, stripSelector(data))
  vaultHexCache.set(vaultCacheKey(chainId, vaultAddress), resultHex)
}

interface JsonRpcResponse {
  id?: unknown
  result?: string
  error?: { data?: string }
}

/** Extract usable hex from a JSON-RPC response (success or batchSimulation revert). */
function extractResultHex(res: JsonRpcResponse): string | undefined {
  return res.result ?? res.error?.data
}

async function tryPopulateVaultCache(
  chainId: number,
  body: unknown,
  responseText: string,
): Promise<void> {
  const addresses = await getChainAddresses(chainId)
  if (!addresses) return

  // JSON-RPC batch request
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = JSON.parse(responseText)
    if (!Array.isArray(responses)) return

    const resultById = new Map<string | number, string>()
    for (const res of responses) {
      if (res.id == null) continue
      const hex = extractResultHex(res)
      if (hex) resultById.set(typeof res.id === 'number' ? res.id : String(res.id), hex)
    }

    for (const req of body as Array<{ method?: string, params?: unknown[], id?: unknown }>) {
      if (req.method !== 'eth_call' || req.id == null) continue
      const callParams = req.params as [{ to?: string, data?: string }] | undefined
      if (!callParams?.[0]?.to || !callParams[0].data) continue

      const key = typeof req.id === 'number' ? req.id : String(req.id)
      const resultHex = resultById.get(key)
      if (!resultHex) continue

      tryCacheSingleEthCall(chainId, callParams[0].to, callParams[0].data, resultHex, addresses)
    }
    return
  }

  // Single JSON-RPC request
  if (typeof body !== 'object' || body === null) return
  const req = body as { method?: string, params?: unknown[] }
  if (req.method !== 'eth_call') return

  const callParams = req.params as [{ to?: string, data?: string }] | undefined
  if (!callParams?.[0]?.to || !callParams[0].data) return

  const parsed: JsonRpcResponse = JSON.parse(responseText)
  const resultHex = extractResultHex(parsed)
  if (!resultHex) return

  tryCacheSingleEthCall(chainId, callParams[0].to, callParams[0].data, resultHex, addresses)
}

// ---------------------------------------------------------------------------

const ALLOWED_METHODS = new Set([
  'eth_call',
  'eth_estimateGas',
  'eth_sendRawTransaction',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getLogs',
  'eth_chainId',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getTransactionCount',
  'net_version',
])

const MAX_BATCH_SIZE = 100
const UPSTREAM_TIMEOUT_MS = 30_000

const rateLimiter = createRateLimiter({
  max: 10_000,
  windowMs: 60_000,
  label: 'rpc',
})

interface JsonRpcRequest {
  jsonrpc?: string
  method?: string
  params?: unknown
  id?: unknown
}

// Validates a JSON-RPC 2.0 request object. Requires `id` to be present,
// which means JSON-RPC 2.0 *notifications* (requests without `id`) are
// intentionally rejected — the proxy only handles request/response patterns.
function validateRpcRequest(req: unknown): req is JsonRpcRequest {
  if (typeof req !== 'object' || req === null) return false
  const r = req as Record<string, unknown>
  if (r.jsonrpc !== '2.0') return false
  if (!('id' in r) || (typeof r.id !== 'number' && typeof r.id !== 'string' && r.id !== null)) return false
  if (!('method' in r)) return false
  return true
}

function validateMethod(method: unknown): method is string {
  return typeof method === 'string' && ALLOWED_METHODS.has(method)
}

export default defineEventHandler(async (event) => {
  const chainIdRaw = event.context.params?.chainId
  const chainId = Number(chainIdRaw)

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  if (getMethod(event) !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  }

  const rpcUrl = resolveRpcUrl(chainId)
  if (!rpcUrl) {
    throw createError({ statusCode: 404, statusMessage: 'RPC not configured' })
  }

  const body = await readBody(event)

  if (body === null || body === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Missing request body' })
  }

  const isBatch = Array.isArray(body)

  if (isBatch) {
    if (body.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Empty batch request' })
    }
    if (body.length > MAX_BATCH_SIZE) {
      throw createError({ statusCode: 400, statusMessage: `Batch size exceeds maximum of ${MAX_BATCH_SIZE}` })
    }
    for (const req of body) {
      if (!validateRpcRequest(req) || !validateMethod(req.method)) {
        throw createError({ statusCode: 403, statusMessage: `Method not allowed: ${(req as JsonRpcRequest)?.method ?? 'unknown'}` })
      }
    }
  }
  else {
    if (!validateRpcRequest(body) || !validateMethod(body.method)) {
      throw createError({ statusCode: 403, statusMessage: `Method not allowed: ${body?.method ?? 'unknown'}` })
    }
  }

  rateLimiter.consume(event)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    })

    setResponseStatus(event, response.status)
    setResponseHeader(event, 'content-type', response.headers.get('content-type') || 'application/json')

    const text = await response.text()

    tryPopulateVaultCache(chainId, body, text).catch(() => {})

    return text
  }
  catch (error: unknown) {
    if (isAbortError(error)) {
      throw createError({ statusCode: 504, statusMessage: 'Upstream RPC timeout' })
    }
    throw createError({ statusCode: 502, statusMessage: 'Upstream RPC error' })
  }
  finally {
    clearTimeout(timeout)
  }
})
