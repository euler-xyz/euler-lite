import type { Hash, Transaction, TransactionReceipt } from 'viem'

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
  receipts?: SafeCallsStatusReceipt[]
}

export interface SafeTransactionExecution {
  hash: Hash
  receipt: TransactionReceipt
}

export class SafeTransactionStatusUnknownError extends Error {
  readonly submittedHash: Hash

  constructor(submittedHash: Hash, reason: 'timeout' | 'aborted') {
    super(reason === 'timeout'
      ? 'Safe transaction confirmation timed out. Its execution status is unknown; verify it in Safe before retrying.'
      : 'Safe transaction confirmation was interrupted. Its execution status is unknown; verify it in Safe before retrying.')
    this.name = 'SafeTransactionStatusUnknownError'
    this.submittedHash = submittedHash
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
  return { status, receipts }
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
 * Wait for a Safe transaction and resolve its Safe hash to the real execution
 * hash. Safe returns a Safe transaction hash while confirmations are pending;
 * a normal chain RPC can never find a receipt under that hash.
 */
export const waitForSafeTransactionExecution = async ({
  submittedHash,
  walletProvider,
  publicClient,
  pollingIntervalMs = SAFE_STATUS_POLL_INTERVAL_MS,
  timeoutMs = SAFE_STATUS_POLL_TIMEOUT_MS,
  signal,
}: {
  submittedHash: Hash
  walletProvider: WalletProviderLike
  publicClient: ReceiptClientLike
  pollingIntervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<SafeTransactionExecution> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Safe transaction polling timeout must be a positive finite number')
  }

  let executionHash = submittedHash
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
  const statusUnknownError = () => new SafeTransactionStatusUnknownError(submittedHash, stopReason)
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

      const receipt = await withStopSignal(getPublicReceipt(publicClient, executionHash))
      if (receipt) return { hash: executionHash, receipt }

      if (callsStatusSupported) {
        try {
          const rawStatus = await withStopSignal(walletProvider.request({
            method: 'wallet_getCallsStatus',
            params: [submittedHash],
          }))
          const callsStatus = parseCallsStatus(rawStatus)
          const status = parseStatus(callsStatus?.status)

          // Failed EIP-5792 states can still include a mined execution hash.
          // Resolve that receipt before classifying the transaction as terminal;
          // it may have consumed the Safe nonce and must never become retryable.
          const resolvedHash = callsStatus?.receipts
            ?.map(item => item.transactionHash)
            .find(isHash)
          if (resolvedHash) executionHash = resolvedHash

          if (status === 400) {
            throw new Error('Safe transaction was cancelled')
          }
        }
        catch (error) {
          if (error instanceof SafeTransactionStatusUnknownError) throw error
          if (error instanceof Error && error.message === 'Safe transaction was cancelled') {
            throw error
          }
          if (isUnsupportedMethodError(error)) callsStatusSupported = false
          // Safe's gateway can briefly report "Transaction not found" before it
          // indexes a newly submitted Safe hash. Treat that as pending.
        }
      }

      if (!callsStatusSupported) {
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
