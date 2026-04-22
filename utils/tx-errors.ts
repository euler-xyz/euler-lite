import { BaseError, ContractFunctionRevertedError, decodeAbiParameters, formatUnits, type Hex } from 'viem'
import { ERROR_MESSAGE_MAP, ERROR_SIGNATURE_MAP, NON_BLOCKING_SIMULATION_ERRORS } from '~/entities/constants'
import { hasGuard, getGuardMeta } from '~/utils/operationGuardRegistry'
import { getChainById } from '~/entities/chainRegistry'

const SWAPPER_SWAP_ERROR_SELECTOR = '0x436fa211'
const ERROR_STRING_SELECTOR = '0x08c379a0' // Solidity Error(string)

// Decode raw revert data into a human reason — either a standard Error(string) message
// or the name of a known custom error from ERROR_SIGNATURE_MAP.
const decodeRevertBytes = (raw: Hex | undefined): string | undefined => {
  if (!raw || raw.length < 10) return undefined
  const selector = raw.slice(0, 10).toLowerCase()
  const payload = `0x${raw.slice(10)}` as Hex

  if (selector === ERROR_STRING_SELECTOR) {
    try {
      const [reason] = decodeAbiParameters([{ type: 'string' }], payload)
      return reason
    }
    catch {
      return undefined
    }
  }

  return ERROR_SIGNATURE_MAP[selector]
}

// If raw data is Swapper_SwapError(address,bytes), decode and return the inner revert reason
// (the raw error surfaced by the underlying DEX/aggregator call).
const decodeSwapperInnerReason = (raw: Hex | undefined): string | undefined => {
  if (!raw || !raw.toLowerCase().startsWith(SWAPPER_SWAP_ERROR_SELECTOR)) return undefined
  try {
    const [, innerBytes] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }],
      `0x${raw.slice(10)}` as Hex,
    )
    return decodeRevertBytes(innerBytes)
  }
  catch {
    return undefined
  }
}

const getRawRevertData = (error: unknown): Hex | undefined => {
  if (!(error instanceof BaseError)) return undefined
  const revertError = error.walk(err => err instanceof ContractFunctionRevertedError)
  return revertError instanceof ContractFunctionRevertedError ? revertError.raw : undefined
}

const parseErrorCodeFromMessage = (message: string) => {
  const match = message.match(/execution reverted: (.+)$/i)
  if (match?.[1]) {
    return match[1].trim()
  }
  return undefined
}

const parseErrorSignatureFromMessage = (message: string) => {
  const match = message.match(/signature:\s*(0x[0-9a-fA-F]{8})/i) || message.match(/(0x[0-9a-fA-F]{8})/)
  return match?.[1]?.toLowerCase()
}

const extractErrorCode = (error: unknown) => {
  if (error instanceof BaseError) {
    const revertError = error.walk(err => err instanceof ContractFunctionRevertedError)
    if (
      revertError instanceof ContractFunctionRevertedError
      && revertError.data?.errorName
      && revertError.data.errorName !== 'Error'
    ) {
      return revertError.data.errorName
    }
    if (revertError instanceof ContractFunctionRevertedError && revertError.reason) {
      return revertError.reason
    }
    if (error.shortMessage) {
      const signature = parseErrorSignatureFromMessage(error.shortMessage)
      if (signature && ERROR_SIGNATURE_MAP[signature]) {
        return ERROR_SIGNATURE_MAP[signature]
      }
      return parseErrorCodeFromMessage(error.shortMessage) || error.shortMessage
    }
  }

  if (error instanceof Error) {
    const signature = parseErrorSignatureFromMessage(error.message)
    if (signature && ERROR_SIGNATURE_MAP[signature]) {
      return ERROR_SIGNATURE_MAP[signature]
    }
    return parseErrorCodeFromMessage(error.message) || error.message
  }

  return undefined
}

const formatErrorCode = (code: string) => {
  const trimmed = code.replace(/^(EVC_|E_)/, '')
  const spaced = trimmed
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()

  return spaced || code
}

export const getTxErrorCode = (error: unknown) => {
  return extractErrorCode(error)
}

export const shouldDiscardQuoteOnEstimateGasError = (error: unknown) => {
  const code = extractErrorCode(error)
  return code === 'Swapper_SwapError' || code?.startsWith('SwapVerifier_') === true
}

export const isNonBlockingSimulationError = (error: unknown) => {
  const code = extractErrorCode(error)
  return code ? NON_BLOCKING_SIMULATION_ERRORS.has(code) : false
}

const isInsufficientBalanceError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('exceeds the balance of the account')
    || message.includes('insufficient funds')
}

export const getTxErrorMessage = (error: unknown) => {
  if (isInsufficientBalanceError(error)) {
    if (hasGuard('keyring').value) {
      const meta = getGuardMeta('keyring').value
      const cost = meta?.credentialCost as number | undefined
      const cid = meta?.chainId as number | undefined
      const chain = cid ? getChainById(cid) : undefined
      const symbol = chain?.nativeCurrency?.symbol ?? 'ETH'
      const decimals = chain?.nativeCurrency?.decimals ?? 18
      const feeDisplay = cost
        ? ` of ${parseFloat(formatUnits(BigInt(cost), decimals)).toFixed(6)} ${symbol}`
        : ''
      return `Insufficient balance. This transaction includes a Keyring credential fee${feeDisplay}. Ensure you have enough ${symbol} to cover the fee and gas.`
    }
    return 'Insufficient balance to cover gas fees and transaction value.'
  }

  const code = extractErrorCode(error)
  if (code) {
    const base = ERROR_MESSAGE_MAP[code] || `Transaction simulation failed: ${formatErrorCode(code)}`
    if (code === 'Swapper_SwapError') {
      const innerReason = decodeSwapperInnerReason(getRawRevertData(error))
      if (innerReason) return `${base} (${innerReason})`
    }
    return base
  }
  return 'Transaction simulation failed.'
}
