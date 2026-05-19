import { BaseError, ContractFunctionRevertedError, decodeAbiParameters, formatUnits, type Hex } from 'viem'
import { decodeSmartContractErrors } from '@eulerxyz/euler-v2-sdk'
import type { DecodedSmartContractError, SimulateBatchResult, SimulationInsufficientRequirement, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { ERROR_MESSAGE_MAP, ERROR_SIGNATURE_MAP, NON_BLOCKING_SIMULATION_ERRORS } from '~/entities/constants'
import { getOperationMeta } from '~/utils/operationGuardRegistry'
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

export const isNonBlockingSimulationError = (error: unknown) => {
  const code = extractErrorCode(error)
  return code ? NON_BLOCKING_SIMULATION_ERRORS.has(code) : false
}

const isInsufficientBalanceError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('exceeds the balance of the account')
    || message.includes('insufficient funds')
}

// ---------------------------------------------------------------------------
// SDK SimulateBatchResult → human-readable error string
//
// The SDK gives us structured failure data: insufficiency requirements,
// per-batch-item reverts (with chained DecodedSmartContractError entries),
// EVC-level simulation errors, and post-batch account/vault status check
// failures. This formatter walks those in priority order and renders the
// most actionable signal — preserving signature + params rather than the
// bare signature string we used to surface.
// ---------------------------------------------------------------------------

const shortenAddress = (addr: string) =>
  addr.length === 42 && addr.startsWith('0x') ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr

const formatDecodedParam = (value: unknown): string => {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value.startsWith('0x') ? shortenAddress(value) : value
  if (Array.isArray(value)) return `[${value.map(formatDecodedParam).join(', ')}]`
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v)
    }
    catch {
      return String(value)
    }
  }
  return String(value)
}

const formatDecodedError = (decoded: DecodedSmartContractError): string => {
  const name = decoded.signature.split('(')[0] ?? decoded.signature
  if (!decoded.params.length) return `${name}()`
  return `${name}(${decoded.params.map(formatDecodedParam).join(', ')})`
}

// The SDK returns the decoded chain in nesting order (outer wrapper first,
// inner cause last). For UX we want the most specific entry surfaced, then
// the outer wrapper as context so EVC-level reverts (BatchPanic etc.) don't
// hide the underlying vault error.
const formatDecodedChain = (chain: readonly DecodedSmartContractError[]): string => {
  if (!chain.length) return ''
  if (chain.length === 1) return formatDecodedError(chain[0])
  const inner = formatDecodedError(chain[chain.length - 1])
  const outer = formatDecodedError(chain[0])
  return inner === outer ? inner : `${inner}  (wrapped by ${outer})`
}

const formatInsufficiency = (
  label: string,
  reqs: SimulationInsufficientRequirement[] | undefined,
): string | null => {
  if (!reqs?.length) return null
  const parts = reqs.map(r => `${r.amount.toString()} of ${shortenAddress(r.token)}`)
  return `${label}: ${parts.join('; ')}`
}

export const formatSimulationFailure = <T extends VaultEntity>(
  result: SimulateBatchResult<T>,
): string => {
  // 1. Insufficiency diagnostics — most actionable for the user.
  const insufficientWallet = formatInsufficiency('Insufficient wallet balance', result.insufficientWalletAssets)
  if (insufficientWallet) return insufficientWallet
  const insufficientPermit2 = formatInsufficiency('Insufficient Permit2 allowance', result.insufficientPermit2Allowances)
  if (insufficientPermit2) return insufficientPermit2
  const insufficientDirect = formatInsufficiency('Insufficient token allowance', result.insufficientDirectAllowances)
  if (insufficientDirect) return insufficientDirect

  // 2. Per-batch-item revert: SDK has already attempted to decode the chain.
  const firstFailed = result.failedBatchItems?.[0]
  if (firstFailed) {
    const decoded = formatDecodedChain(firstFailed.decodedError)
    return decoded || `Batch item ${firstFailed.index} failed`
  }

  // 3. EVC-level simulation error (couldn't decode the batch at all).
  if (result.simulationError) {
    const decoded = formatDecodedChain(result.simulationError.decoded)
    return decoded || 'EVC simulation reverted'
  }

  // 4. Post-batch account / vault status check failures.
  const acctErr = result.accountStatusErrors?.[0]
  if (acctErr) {
    const decoded = formatDecodedChain(acctErr.decoded)
    return decoded
      ? `Account check ${shortenAddress(acctErr.account)}: ${decoded}`
      : `Account check failed for ${shortenAddress(acctErr.account)}`
  }
  const vaultErr = result.vaultStatusErrors?.[0]
  if (vaultErr) {
    const decoded = formatDecodedChain(vaultErr.decoded)
    return decoded
      ? `Vault check ${shortenAddress(vaultErr.vault)}: ${decoded}`
      : `Vault check failed for ${shortenAddress(vaultErr.vault)}`
  }

  return 'Simulation failed'
}

// SDK decoder fallback. The local ERROR_SIGNATURE_MAP covers known protocol
// errors; this catches selectors we haven't mapped — e.g. new aggregator or
// CowSwap reverts — by going through OpenChain/Sourcify signature lookup.
// Returns a code string (e.g. "NotAuthorized") when the SDK can name the
// outermost error, otherwise undefined.
const decodeUnknownErrorCode = async (error: unknown): Promise<string | undefined> => {
  try {
    const decoded = await decodeSmartContractErrors(error)
    const first = decoded[0]
    if (!first?.signature) return undefined
    return first.signature.split('(')[0] || undefined
  }
  catch {
    return undefined
  }
}

export const getTxErrorMessage = async (error: unknown): Promise<string> => {
  if (isInsufficientBalanceError(error)) {
    const keyringMeta = getOperationMeta('keyring').value
    const cost = keyringMeta?.credentialCost as number | undefined
    const cid = keyringMeta?.chainId as number | undefined
    if (cost !== undefined) {
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

  const localCode = extractErrorCode(error)
  if (localCode) {
    const base = ERROR_MESSAGE_MAP[localCode] || `Transaction simulation failed: ${formatErrorCode(localCode)}`
    if (localCode === 'Swapper_SwapError') {
      const innerReason = decodeSwapperInnerReason(getRawRevertData(error))
      if (innerReason) return `${base} (${innerReason})`
    }
    return base
  }

  // Local lookups missed — fall back to the SDK decoder, which can resolve
  // unknown selectors via OpenChain/Sourcify before we give up.
  const sdkCode = await decodeUnknownErrorCode(error)
  if (sdkCode) {
    return ERROR_MESSAGE_MAP[sdkCode] || `Transaction simulation failed: ${formatErrorCode(sdkCode)}`
  }
  return 'Transaction simulation failed.'
}
