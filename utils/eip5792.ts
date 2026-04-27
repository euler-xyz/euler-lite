import { encodeFunctionData, type Hex } from 'viem'
import type { TxStep } from '~/entities/txPlan'

export interface WalletCall {
  to: TxStep['to']
  data: Hex
  value?: bigint
}

export const toWalletCall = (step: TxStep): WalletCall => {
  const call: WalletCall = {
    to: step.to,
    data: encodeFunctionData({
      abi: step.abi,
      functionName: step.functionName,
      args: step.args,
    }),
  }

  if (step.value && step.value > 0n) {
    call.value = step.value
  }

  return call
}

export const supportsAtomicBatching = (capabilities: unknown, chainId?: number): boolean => {
  if (!capabilities || typeof capabilities !== 'object') return false

  const directAtomic = (capabilities as { atomic?: { status?: string } }).atomic
  if (directAtomic?.status === 'ready' || directAtomic?.status === 'supported') {
    return true
  }

  if (!chainId) return false

  const byChain = capabilities as Record<string | number, unknown>
  const chainCapabilities = byChain[chainId] ?? byChain[String(chainId)]
  if (!chainCapabilities || typeof chainCapabilities !== 'object') return false

  const atomic = (chainCapabilities as { atomic?: { status?: string } }).atomic
  return atomic?.status === 'ready' || atomic?.status === 'supported'
}

export const supportsPaymaster = (capabilities: unknown, chainId?: number): boolean => {
  if (!capabilities || typeof capabilities !== 'object') return false

  const directPaymaster = (capabilities as { paymasterService?: { supported?: boolean } }).paymasterService
  if (directPaymaster?.supported === true) return true

  if (!chainId) return false

  const byChain = capabilities as Record<string | number, unknown>
  const chainCapabilities = byChain[chainId] ?? byChain[String(chainId)]
  if (!chainCapabilities || typeof chainCapabilities !== 'object') return false

  return (chainCapabilities as { paymasterService?: { supported?: boolean } }).paymasterService?.supported === true
}

export const shouldUseAtomicCalls = (params: {
  stepCount: number
  capabilities: unknown
  chainId?: number
}): boolean =>
  params.stepCount > 1 && supportsAtomicBatching(params.capabilities, params.chainId)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isUserRejectedRequestError = (error: unknown): boolean => {
  let current: unknown = error

  for (let i = 0; i < 8 && current != null; i += 1) {
    if (isObject(current)) {
      if (current.code === 4001) return true
      if (current.name === 'UserRejectedRequestError') return true
      current = current.cause
      continue
    }

    break
  }

  const message = error instanceof Error ? error.message : String(error)
  return /user rejected|rejected request|request rejected|user denied/i.test(message)
}

export const extractCallsStatusHash = (status: unknown): Hex | undefined => {
  if (!status || typeof status !== 'object') return undefined

  const receipts = (status as { receipts?: unknown[] }).receipts
  if (!Array.isArray(receipts)) return undefined

  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== 'object') continue
    const hash = (receipt as { transactionHash?: unknown }).transactionHash
    if (typeof hash === 'string' && hash.startsWith('0x')) return hash as Hex
  }

  return undefined
}
