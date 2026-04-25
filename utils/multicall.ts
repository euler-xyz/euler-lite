import { encodeFunctionData, decodeFunctionResult, zeroAddress, type Address, type Hex, type Abi } from 'viem'
import { EVC_ABI, type BatchItem, type BatchItemResult } from '~/abis/evc'
import { getPublicClient } from '~/utils/public-client'
import { isTransportError } from '~/utils/viem-errors'
import { logger } from '~/utils/logger'

export type MulticallResult<T = unknown> = {
  success: boolean
  result: T | null
  error?: Error
}

export type BatchLensResult<T = unknown> = {
  success: boolean
  result: T | null
  /** True when the entire RPC request failed (e.g. 403, network error) vs individual call revert */
  transportError?: boolean
}

/**
 * Execute multiple contract calls in a single RPC request using EVC batchSimulation.
 * This is more reliable than Multicall3 as EVC is guaranteed to exist on all Euler chains.
 *
 * When batch items carry value (e.g. Pyth update fees), the total is automatically
 * summed for msg.value and a balance state override is added for the caller.
 *
 * @param evcAddress - EVC contract address
 * @param items - Array of batch items (target, data, value)
 * @param rpcUrl - JSON-RPC URL
 * @returns Array of BatchItemResult in same order as items
 */
export const evcBatchCall = async (
  evcAddress: string,
  items: BatchItem[],
  rpcUrl: string,
): Promise<BatchItemResult[]> => {
  if (items.length === 0) {
    return []
  }

  const client = getPublicClient(rpcUrl)
  const totalValue = items.reduce((sum, item) => sum + item.value, 0n)

  // Errors (403, network failures, timeouts) propagate to callers so they can
  // distinguish "RPC is down" from "individual call reverted on-chain".
  const callData = encodeFunctionData({
    abi: EVC_ABI,
    functionName: 'batchSimulation',
    args: [items],
  })

  const result = await client.call({
    to: evcAddress as Address,
    data: callData,
    value: totalValue,
    ...(totalValue > 0n ? { stateOverride: [{ address: zeroAddress as `0x${string}`, balance: totalValue }] } : {}),
  })

  if (!result.data) {
    return items.map(() => ({
      success: false,
      result: '0x',
    }))
  }

  const decoded = decodeFunctionResult({
    abi: EVC_ABI,
    functionName: 'batchSimulation',
    data: result.data,
  })

  const batchResults = decoded[0] as unknown as BatchItemResult[]
  return batchResults
}

/**
 * Build a batch item for a contract call.
 */
export const buildBatchItem = (
  targetContract: string,
  callData: string,
  value: bigint = 0n,
): BatchItem => ({
  targetContract: targetContract as `0x${string}`,
  onBehalfOfAccount: zeroAddress,
  value,
  data: callData as `0x${string}`,
})

/**
 * Execute a single chunk of lens calls via EVC batchSimulation.
 */
const executeLensChunk = async <T>(
  evcAddress: string,
  lensAddress: string,
  lensAbi: Abi | readonly unknown[],
  calls: Array<{ functionName: string, args: unknown[] }>,
  rpcUrl: string,
): Promise<Array<BatchLensResult<T>>> => {
  const items: BatchItem[] = calls.map((call) => {
    const callData = encodeFunctionData({
      abi: lensAbi as Abi,
      functionName: call.functionName,
      args: call.args,
    })
    return buildBatchItem(lensAddress, callData)
  })

  let batchResults: BatchItemResult[]
  try {
    batchResults = await evcBatchCall(evcAddress, items, rpcUrl)
  }
  catch (err) {
    if (isTransportError(err)) {
      return calls.map(() => ({ success: false, result: null, transportError: true }))
    }
    // On-chain revert of the whole batch (e.g. out of gas) — let caller retry individually
    return calls.map(() => ({ success: false, result: null }))
  }

  return batchResults.map((result, index) => {
    if (!result.success) {
      return { success: false, result: null }
    }

    try {
      const decoded = decodeFunctionResult({
        abi: lensAbi as Abi,
        functionName: calls[index].functionName,
        data: result.result as Hex,
      })
      return { success: true, result: decoded as T }
    }
    catch (err) {
      logger.warn(
        { ctx: 'batchLensCalls', fn: calls[index].functionName, err },
        'failed to decode batch result',
      )
      return { success: false, result: null }
    }
  })
}

/**
 * Batch multiple lens calls using EVC batchSimulation.
 * Automatically chunks into sub-batches to stay within gas limits.
 *
 * @param evcAddress - EVC contract address
 * @param lensAddress - Lens contract address
 * @param lensAbi - ABI for the lens contract
 * @param calls - Array of { functionName, args } to call
 * @param rpcUrl - JSON-RPC URL
 * @param batchSize - Max calls per batchSimulation (default 25)
 * @returns Array of decoded results (or null for failed calls)
 */
export const batchLensCalls = async <T>(
  evcAddress: string,
  lensAddress: string,
  lensAbi: Abi | readonly unknown[],
  calls: Array<{ functionName: string, args: unknown[] }>,
  rpcUrl: string,
  batchSize = 25,
): Promise<Array<BatchLensResult<T>>> => {
  if (calls.length === 0) {
    return []
  }

  if (calls.length <= batchSize) {
    return executeLensChunk<T>(evcAddress, lensAddress, lensAbi, calls, rpcUrl)
  }

  const allResults: Array<BatchLensResult<T>> = []
  for (let i = 0; i < calls.length; i += batchSize) {
    const chunk = calls.slice(i, i + batchSize)
    const chunkResults = await executeLensChunk<T>(evcAddress, lensAddress, lensAbi, chunk, rpcUrl)
    allResults.push(...chunkResults)

    // Stop processing further chunks if the RPC endpoint itself is failing
    if (chunkResults.some(r => r.transportError)) {
      // Mark remaining calls as transport errors
      const remaining = calls.length - (i + chunk.length)
      for (let j = 0; j < remaining; j++) {
        allResults.push({ success: false, result: null, transportError: true })
      }
      break
    }
  }
  return allResults
}
