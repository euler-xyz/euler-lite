import { getAddress, isHash, type Hash } from 'viem'
import type { EoaRequest, SafeCall } from '../domain/template'
import type { EoaAdapterClient, EoaReceipt, EoaSubmittedTransaction } from './eoa'
import type { SafeAdapterClient, SafeCallsStatus } from './safe'
import type { EoaReconciliationClient, SafeReconciliationClient } from '../coordinator/reconcilers'
import type { WalletProviderLike } from '~/utils/safeWalletTransactions'

interface PublicTransactionClient {
  getBlockNumber(): Promise<bigint>
  getTransactionCount(args: { address: `0x${string}`, blockTag: 'pending' }): Promise<number>
  getTransaction(args: { hash: Hash }): Promise<{
    hash: Hash
    from: `0x${string}`
    to: `0x${string}` | null
    input: `0x${string}`
    value: bigint
    chainId?: number
    nonce: number
  }>
  waitForTransactionReceipt(args: { hash: Hash }): Promise<{ transactionHash: Hash, status: 'success' | 'reverted' }>
  getTransactionReceipt(args: { hash: Hash }): Promise<{ transactionHash: Hash, status: 'success' | 'reverted' }>
  getBlock(args: { blockNumber: bigint, includeTransactions: true }): Promise<{ transactions: readonly ({
    hash: Hash
    from: `0x${string}`
    to: `0x${string}` | null
    input: `0x${string}`
    value: bigint
    chainId?: number
    nonce: number
  } | Hash)[] }>
}

const normalizeTransaction = (transaction: Awaited<ReturnType<PublicTransactionClient['getTransaction']>>): EoaSubmittedTransaction => ({
  hash: transaction.hash,
  from: getAddress(transaction.from),
  to: transaction.to ? getAddress(transaction.to) : null,
  input: transaction.input,
  value: transaction.value,
  ...(transaction.chainId === undefined ? {} : { chainId: transaction.chainId }),
  nonce: transaction.nonce,
})

const receipt = (value: { transactionHash: Hash, status: 'success' | 'reverted' }): EoaReceipt => ({
  transactionHash: value.transactionHash,
  status: value.status,
})

export const createAppEoaClients = ({
  publicClient,
  send,
  maximumRecoveryBlocks = 128n,
}: {
  publicClient: PublicTransactionClient
  send(request: EoaRequest): Promise<Hash>
  maximumRecoveryBlocks?: bigint
}): { adapter: EoaAdapterClient, recovery: EoaReconciliationClient } => ({
  adapter: {
    getBlockNumber: () => publicClient.getBlockNumber(),
    getTransactionCount: account => publicClient.getTransactionCount({ address: account, blockTag: 'pending' }),
    sendTransaction: send,
    getTransaction: async hash => normalizeTransaction(await publicClient.getTransaction({ hash })),
    waitForTransactionReceipt: async hash => receipt(await publicClient.waitForTransactionReceipt({ hash })),
  },
  recovery: {
    getTransaction: async hash => publicClient.getTransaction({ hash }).then(normalizeTransaction).catch(() => undefined),
    getTransactionReceipt: async hash => publicClient.getTransactionReceipt({ hash }).then(receipt).catch(() => undefined),
    async findTransaction({ account, nonce, startBlock }) {
      const current = await publicClient.getBlockNumber()
      if (current < startBlock || current - startBlock > maximumRecoveryBlocks) return undefined
      for (let blockNumber = startBlock; blockNumber <= current; blockNumber++) {
        const block = await publicClient.getBlock({ blockNumber, includeTransactions: true })
        for (const candidate of block.transactions) {
          const transaction = typeof candidate === 'string' ? await publicClient.getTransaction({ hash: candidate }) : candidate
          if (getAddress(transaction.from) === getAddress(account) && transaction.nonce === nonce) return normalizeTransaction(transaction)
        }
      }
      return undefined
    },
  },
})

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const parseStatus = (value: unknown): number | undefined => {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  if (value === 'success') return 200
  if (value === 'pending') return 100
  if (value === 'failure') return 500
  return undefined
}

const parseCalls = (value: unknown): readonly { to: `0x${string}`, data: `0x${string}`, value: bigint }[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const calls: { to: `0x${string}`, data: `0x${string}`, value: bigint }[] = []
  for (const call of value) {
    const item = record(call)
    if (!item || typeof item.to !== 'string' || typeof item.data !== 'string') return undefined
    try {
      calls.push({ to: getAddress(item.to), data: item.data as `0x${string}`, value: BigInt(item.value as string | number | bigint ?? 0) })
    }
    catch {
      return undefined
    }
  }
  return calls
}

const statusFrom = (raw: unknown): SafeCallsStatus | undefined => {
  const value = record(raw)
  const status = parseStatus(value?.status)
  if (!value || status === undefined) return undefined
  const receipts = Array.isArray(value.receipts) ? value.receipts.map(record).filter(Boolean) : []
  const executionHash = receipts.flatMap(candidate => [candidate!.transactionHash, candidate!.hash]).find(isHash)
  return { status, ...(executionHash ? { executionHash } : {}) }
}

/**
 * Safe proposal equality requires the wallet status response to expose the
 * proposed call vector. Providers that omit it fail closed into recovery.
 */
export const createAppSafeClients = ({
  provider,
  publicClient,
  send,
}: {
  provider: WalletProviderLike
  publicClient: PublicTransactionClient
  send(calls: readonly SafeCall[]): Promise<string>
}): { adapter: SafeAdapterClient, recovery: SafeReconciliationClient } => {
  const statusCache = new Map<string, unknown>()
  const readStatus = async (callsId: string) => {
    const value = await provider.request({ method: 'wallet_getCallsStatus', params: [callsId] })
    statusCache.set(callsId, value)
    return value
  }
  const proposed = async (callsId: string) => {
    const value = statusCache.get(callsId) ?? await readStatus(callsId)
    const body = record(value)
    return parseCalls(body?.calls ?? record(body?.capabilities)?.calls)
  }
  const getReceipt = async (hash: Hash) => publicClient.getTransactionReceipt({ hash })
    .then(value => ({ status: value.status }))
    .catch(() => undefined)
  return {
    adapter: {
      sendCalls: send,
      getProposedCalls: async (callsId) => {
        const calls = await proposed(callsId)
        if (!calls) throw new Error('Safe provider did not expose the proposed call vector')
        return calls
      },
      waitForCallsStatus: async (callsId) => {
        const status = statusFrom(await readStatus(callsId))
        if (!status) throw new Error('Safe provider returned malformed call status')
        return status
      },
      getExecutionReceipt: async (hash) => {
        const value = await getReceipt(hash)
        if (!value) throw new Error('Safe execution receipt is unavailable')
        return value
      },
    },
    recovery: {
      getProposedCalls: proposed,
      getCallsStatus: async callsId => statusFrom(await readStatus(callsId).catch(() => undefined)),
      getExecutionReceipt: getReceipt,
    },
  }
}
