import { decodeFunctionResult, encodeFunctionData } from 'viem'
import { fetchWithTimeout } from './fetchWithTimeout'
import { INTERNAL_FETCH_HEADERS } from './internal-headers'
import { resolveRpcUrl } from './rpc'

const VERIFIED_ARRAY_ABI = [{
  type: 'function',
  name: 'verifiedArray',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'address[]' }],
}] as const

interface EulerChainConfig {
  chainId?: unknown
  addresses?: {
    peripheryAddrs?: {
      escrowedCollateralPerspective?: unknown
    }
  }
}

async function fetchEulerChains(): Promise<EulerChainConfig[]> {
  const data = await $fetch<unknown>('/api/euler-chains', { headers: INTERNAL_FETCH_HEADERS })
  return Array.isArray(data) ? data as EulerChainConfig[] : []
}

export async function fetchEscrowPerspectiveAddresses(chainId: number): Promise<string[]> {
  const rpcUrl = resolveRpcUrl(chainId)
  if (!rpcUrl) return []

  const chains = await fetchEulerChains()
  const config = chains.find(c => Number(c.chainId) === chainId)
  const perspective = config?.addresses?.peripheryAddrs?.escrowedCollateralPerspective
  if (typeof perspective !== 'string' || !perspective.startsWith('0x')) return []

  const callData = encodeFunctionData({ abi: VERIFIED_ARRAY_ABI, functionName: 'verifiedArray' })
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: perspective, data: callData }, 'latest'],
  })

  const response = await fetchWithTimeout(rpcUrl, 10_000, {
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'application/json' },
  })

  if (!response.ok) throw new Error(`Upstream RPC returned ${response.status}`)

  const parsed = await response.json() as { result?: unknown, error?: unknown }
  if (parsed.error) throw new Error(`Upstream RPC error: ${JSON.stringify(parsed.error)}`)
  const result = parsed.result
  if (typeof result !== 'string' || !result.startsWith('0x')) return []

  const decoded = decodeFunctionResult({
    abi: VERIFIED_ARRAY_ABI,
    functionName: 'verifiedArray',
    data: result as `0x${string}`,
  })
  return [...decoded]
}
