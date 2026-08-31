import { numberToHex, type Address, type Hash, type Transaction, type TransactionReceipt } from 'viem'
import type { SafeAtomicCapabilityStatus, SafeTransportEnvelope } from '~/features/reviewed-execution/domain/reviewed-execution'
import { isSafeCallsId } from '~/utils/safe-calls-id'

const SAFE_STATUS_POLL_INTERVAL_MS = 2_000
const SAFE_STATUS_POLL_TIMEOUT_MS = 5 * 60_000

interface ProviderRequest {
  method: string
  params?: readonly unknown[]
}

export interface WalletProviderLike {
  request: (request: ProviderRequest) => Promise<unknown>
  session?: unknown
}

export interface WalletConnectorLike {
  id?: string
  name?: string
  getProvider?: () => Promise<unknown>
}

export interface ReceiptClientLike {
  getTransactionReceipt: (parameters: { hash: Hash }) => Promise<TransactionReceipt>
  getTransaction?: (parameters: { blockHash: Hash, index: number }) => Promise<Transaction>
}

interface SafeCallsStatusReceipt {
  transactionHash?: Hash
}

interface SafeCallsStatus {
  status?: number | string
  atomic?: boolean
  receipts?: SafeCallsStatusReceipt[]
}

export interface SafeTransactionExecution {
  hash: Hash
  receipt: TransactionReceipt
  atomic?: true
}

export type SafeTransactionReconciliation
  = | { state: 'pending' | 'unknown' }
    | { state: 'cancelled' | 'failed' }
    | { state: 'success' | 'reverted', hash: Hash, atomic: true }

export class SafeTransactionStatusUnknownError extends Error {
  readonly submittedId: string

  constructor(submittedId: string, reason: 'timeout' | 'aborted') {
    super(reason === 'timeout'
      ? 'Safe transaction confirmation timed out. Its execution status is unknown; verify it in Safe before retrying.'
      : 'Safe transaction confirmation was interrupted. Its execution status is unknown; verify it in Safe before retrying.')
    this.name = 'SafeTransactionStatusUnknownError'
    this.submittedId = submittedId
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object'

const isHash = (value: unknown): value is Hash =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)

const compactWalletName = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '')

const isSafeWalletName = (value: string) => {
  const compact = compactWalletName(value)
  return compact === 'safe' || compact === 'safewallet'
}

const isSafeWalletUrl = (value: unknown) => {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).hostname.toLowerCase() === 'app.safe.global'
  }
  catch {
    return false
  }
}

const hasRequest = (value: unknown): value is WalletProviderLike =>
  isRecord(value) && typeof value.request === 'function'

/**
 * Synchronous check: the connector itself is identifiably Safe (wagmi's
 * iframe `safe` connector id or a Safe wallet name), before and without
 * provider acquisition. Safe-via-WalletConnect is NOT covered — that
 * identification needs the provider's peer metadata.
 */
export const isSafeConnectorIdentity = (
  connector?: Pick<WalletConnectorLike, 'id' | 'name'>,
): boolean => {
  const id = connector?.id?.toLowerCase() ?? ''
  return id === 'safe' || isSafeWalletName(connector?.name ?? '')
}

/**
 * Return the connector provider only when the connected wallet is Safe.
 *
 * Safe can arrive either through wagmi's iframe connector or through a
 * WalletConnect session. The latter still reports the generic WalletConnect
 * connector, so identify it from Safe's official peer metadata.
 */
export const getSafeWalletProvider = async (
  connector?: WalletConnectorLike,
): Promise<WalletProviderLike | undefined> => {
  if (!connector?.getProvider) return undefined

  const connectorIsSafe = isSafeConnectorIdentity(connector)
  const connectorIsWalletConnect = connector.id?.toLowerCase() === 'walletconnect'
  if (!connectorIsSafe && !connectorIsWalletConnect) return undefined

  let provider: unknown
  try {
    provider = await connector.getProvider()
  }
  catch {
    return undefined
  }
  if (!hasRequest(provider)) return undefined
  if (connectorIsSafe) return provider

  const session = isRecord(provider.session) ? provider.session : undefined
  const peer = session && isRecord(session.peer) ? session.peer : undefined
  const metadata = peer && isRecord(peer.metadata) ? peer.metadata : undefined
  const peerName = typeof metadata?.name === 'string' ? metadata.name : ''

  return isSafeWalletName(peerName) || isSafeWalletUrl(metadata?.url)
    ? provider
    : undefined
}

export const getSafeAtomicCapability = async (
  provider: WalletProviderLike,
  account: Address,
  chainId: number,
): Promise<Readonly<{ status: SafeAtomicCapabilityStatus }>> => {
  const raw = await provider.request({
    method: 'wallet_getCapabilities',
    params: [account, [numberToHex(chainId)]],
  })
  if (!isRecord(raw)) throw new Error('Safe wallet returned invalid capability data')
  const entries = Object.entries(raw)
  const chainCapabilities = entries.find(([key]) => Number(key) === chainId)?.[1]
  const atomic = isRecord(chainCapabilities) && isRecord(chainCapabilities.atomic)
    ? chainCapabilities.atomic
    : undefined
  if (!atomic) {
    throw new Error(`Safe wallet does not advertise atomic execution on chain ${chainId}`)
  }
  const status = atomic.status
  if (status !== 'supported' && status !== 'ready') {
    throw new Error(`Safe wallet atomic execution is unsupported on chain ${chainId}`)
  }
  return { status }
}

export const sendSafeAtomicCalls = async (
  provider: WalletProviderLike,
  envelope: SafeTransportEnvelope,
): Promise<string> => {
  const result = await provider.request({
    method: 'wallet_sendCalls',
    params: [{
      version: envelope.version,
      from: envelope.from,
      chainId: numberToHex(envelope.chainId),
      atomicRequired: envelope.atomicRequired,
      calls: envelope.calls.map(call => ({
        to: call.to,
        data: call.data,
        value: numberToHex(call.value),
      })),
      capabilities: envelope.capabilities,
    }],
  })
  const callsId = typeof result === 'string'
    ? result
    : isRecord(result) ? result.id : undefined
  if (isSafeCallsId(callsId)) return callsId
  throw new Error('Safe returned no valid calls ID')
}

const parseStatus = (value: number | string | undefined): number | undefined => {
  if (typeof value === 'number') return value
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const parseCallsStatus = (value: unknown): SafeCallsStatus | undefined => {
  if (!isRecord(value)) return undefined
  const receipts = Array.isArray(value.receipts)
    ? value.receipts.filter(isRecord).map(receipt => ({
        transactionHash: isHash(receipt.transactionHash) ? receipt.transactionHash : undefined,
      }))
    : undefined
  const status = typeof value.status === 'number' || typeof value.status === 'string'
    ? value.status
    : undefined
  const atomic = typeof value.atomic === 'boolean' ? value.atomic : undefined
  return { status, atomic, receipts }
}

const isUnsupportedMethodError = (error: unknown) => {
  if (!isRecord(error)) return false
  if (error.code === -32601 || error.code === 4200) return true
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : ''
  return message.includes('method not found')
    || message.includes('method not supported')
    || message.includes('unsupported method')
}

const getPublicReceipt = async (
  publicClient: ReceiptClientLike,
  hash: Hash,
): Promise<TransactionReceipt | undefined> => {
  try {
    return await publicClient.getTransactionReceipt({ hash })
  }
  catch {
    return undefined
  }
}

const getExecutionHashFromWalletReceipt = async (
  value: unknown,
  submittedHash: Hash,
  publicClient: ReceiptClientLike,
): Promise<Hash | undefined> => {
  if (!isRecord(value)) return undefined
  if (isHash(value.transactionHash) && value.transactionHash !== submittedHash) {
    return value.transactionHash
  }

  // Older Safe App providers deliberately replace transactionHash with the
  // Safe hash. Recover the real on-chain transaction by block position.
  if (!publicClient.getTransaction || !isHash(value.blockHash)) return undefined
  const rawIndex = value.transactionIndex
  const index = typeof rawIndex === 'number' ? rawIndex : Number(rawIndex)
  if (!Number.isInteger(index) || index < 0) return undefined
  try {
    return (await publicClient.getTransaction({
      blockHash: value.blockHash,
      index,
    })).hash
  }
  catch {
    return undefined
  }
}

const waitForNextPoll = (pollingIntervalMs: number) =>
  pollingIntervalMs > 0
    ? new Promise(resolve => setTimeout(resolve, pollingIntervalMs))
    : Promise.resolve()

/**
 * Perform one non-blocking reconciliation pass for a persisted Safe calls ID.
 * Only conclusive terminal evidence is returned as terminal; gateway errors,
 * indexing lag, and missing atomic evidence remain locked as unknown/pending.
 */
export const reconcileSafeTransactionExecution = async ({
  callsId,
  walletProvider,
  publicClient,
}: {
  callsId: string
  walletProvider: WalletProviderLike
  publicClient: ReceiptClientLike
}): Promise<SafeTransactionReconciliation> => {
  const submittedHash = isHash(callsId) ? callsId : undefined
  let executionHash = submittedHash
  const directReceipt = submittedHash
    ? await getPublicReceipt(publicClient, submittedHash)
    : undefined

  try {
    const rawStatus = await walletProvider.request({
      method: 'wallet_getCallsStatus',
      params: [callsId],
    })
    const callsStatus = parseCallsStatus(rawStatus)
    const status = parseStatus(callsStatus?.status)
    if (status === 400) return { state: 'cancelled' }
    if (status !== undefined && status >= 500) return { state: 'failed' }
    if (callsStatus?.atomic === false) return { state: 'failed' }

    const resolvedHash = callsStatus?.receipts?.map(item => item.transactionHash).find(isHash)
    if (resolvedHash) executionHash = resolvedHash
    const receipt = resolvedHash
      ? await getPublicReceipt(publicClient, resolvedHash)
      : directReceipt
    if (receipt && callsStatus?.atomic === true) {
      return {
        state: receipt.status === 'success' ? 'success' : 'reverted',
        hash: executionHash!,
        atomic: true,
      }
    }
    return status !== undefined && status >= 100 && status < 300
      ? { state: 'pending' }
      : { state: 'unknown' }
  }
  catch (error) {
    if (!isUnsupportedMethodError(error)) return { state: 'unknown' }
  }

  if (!submittedHash) return { state: 'unknown' }

  try {
    const walletReceipt = await walletProvider.request({
      method: 'eth_getTransactionReceipt',
      params: [submittedHash],
    })
    const resolvedHash = await getExecutionHashFromWalletReceipt(walletReceipt, submittedHash, publicClient)
    if (!resolvedHash) return { state: directReceipt ? 'unknown' : 'pending' }
    // The legacy receipt path cannot prove atomic wallet_sendCalls semantics;
    // retain the lock instead of clearing on incomplete evidence.
    return { state: 'unknown' }
  }
  catch {
    return { state: 'unknown' }
  }
}

/**
 * Wait for Safe calls and resolve the opaque calls ID to the on-chain execution
 * hash. Calls status is authoritative; receipt fallback is available only when
 * the calls ID itself has transaction-hash shape.
 */
export const waitForSafeTransactionExecution = async ({
  callsId,
  walletProvider,
  publicClient,
  pollingIntervalMs = SAFE_STATUS_POLL_INTERVAL_MS,
  timeoutMs = SAFE_STATUS_POLL_TIMEOUT_MS,
  requireAtomic = false,
  signal,
}: {
  callsId: string
  walletProvider: WalletProviderLike
  publicClient: ReceiptClientLike
  pollingIntervalMs?: number
  timeoutMs?: number
  requireAtomic?: boolean
  signal?: AbortSignal
}): Promise<SafeTransactionExecution> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Safe transaction polling timeout must be a positive finite number')
  }

  const submittedHash = isHash(callsId) ? callsId : undefined
  let executionHash = submittedHash
  let atomicConfirmed = !requireAtomic
  let callsStatusSupported = true
  let stopReason: 'timeout' | 'aborted' = 'timeout'
  const deadlineAt = Date.now() + timeoutMs
  const stopController = new AbortController()
  const onExternalAbort = () => {
    stopReason = 'aborted'
    stopController.abort()
  }
  if (signal?.aborted) onExternalAbort()
  else signal?.addEventListener('abort', onExternalAbort, { once: true })

  const timeoutId = setTimeout(() => {
    stopReason = 'timeout'
    stopController.abort()
  }, timeoutMs)
  const statusUnknownError = () => new SafeTransactionStatusUnknownError(callsId, stopReason)
  const withStopSignal = <T>(promise: Promise<T>): Promise<T> => {
    if (stopController.signal.aborted) return Promise.reject(statusUnknownError())

    return new Promise<T>((resolve, reject) => {
      const onStop = () => {
        cleanup()
        reject(statusUnknownError())
      }
      const cleanup = () => stopController.signal.removeEventListener('abort', onStop)
      stopController.signal.addEventListener('abort', onStop, { once: true })
      promise.then(
        (value) => {
          cleanup()
          resolve(value)
        },
        (error) => {
          cleanup()
          reject(error)
        },
      )
    })
  }

  try {
    while (true) {
      if (Date.now() >= deadlineAt) {
        stopReason = 'timeout'
        stopController.abort()
        throw statusUnknownError()
      }

      const receipt = executionHash
        ? await withStopSignal(getPublicReceipt(publicClient, executionHash))
        : undefined
      if (receipt && atomicConfirmed) {
        return { hash: executionHash, receipt, ...(requireAtomic ? { atomic: true as const } : {}) }
      }

      if (callsStatusSupported) {
        try {
          const rawStatus = await withStopSignal(walletProvider.request({
            method: 'wallet_getCallsStatus',
            params: [callsId],
          }))
          const callsStatus = parseCallsStatus(rawStatus)
          const status = parseStatus(callsStatus?.status)

          const resolvedHash = callsStatus?.receipts
            ?.map(item => item.transactionHash)
            .find(isHash)
          if (resolvedHash) executionHash = resolvedHash

          if (status === 400) {
            throw new Error('Safe transaction was cancelled')
          }
          if (requireAtomic && callsStatus?.atomic === false) {
            throw new Error('Safe call batch was not atomic')
          }
          if (requireAtomic && status !== undefined && status >= 200 && status < 300 && callsStatus?.atomic === true) {
            atomicConfirmed = true
          }
          if (status !== undefined && status >= 500) {
            throw new Error('Safe transaction failed')
          }
        }
        catch (error) {
          if (error instanceof SafeTransactionStatusUnknownError) throw error
          if (error instanceof Error && (
            error.message === 'Safe transaction was cancelled'
            || error.message === 'Safe transaction failed'
            || error.message === 'Safe call batch was not atomic'
          )) {
            throw error
          }
          if (isUnsupportedMethodError(error)) callsStatusSupported = false
          // Safe's gateway can briefly report "Transaction not found" before it
          // indexes a newly submitted calls ID. Treat that as pending.
        }
      }

      if (!callsStatusSupported && submittedHash) {
        try {
          const walletReceipt = await withStopSignal(walletProvider.request({
            method: 'eth_getTransactionReceipt',
            params: [submittedHash],
          }))
          const resolvedHash = await withStopSignal(getExecutionHashFromWalletReceipt(
            walletReceipt,
            submittedHash,
            publicClient,
          ))
          if (resolvedHash) executionHash = resolvedHash
        }
        catch (error) {
          if (error instanceof SafeTransactionStatusUnknownError) throw error
          // Still pending, or the connector does not expose receipt lookup.
        }
      }

      await withStopSignal(waitForNextPoll(pollingIntervalMs))
    }
  }
  finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}
