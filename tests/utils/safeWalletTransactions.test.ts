import type { Hash, TransactionReceipt } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  getSafeWalletProvider,
  getSafeAtomicCapability,
  sendSafeAtomicCalls,
  SafeTransactionStatusUnknownError,
  waitForSafeTransactionExecution,
  type ReceiptClientLike,
  type WalletProviderLike,
} from '~/utils/safeWalletTransactions'

const SAFE_HASH = `0x${'11'.repeat(32)}` as Hash
const EXECUTION_HASH = `0x${'22'.repeat(32)}` as Hash
const BLOCK_HASH = `0x${'33'.repeat(32)}` as Hash

const receipt = (hash: Hash, status: TransactionReceipt['status'] = 'success') => ({
  transactionHash: hash,
  status,
} as TransactionReceipt)

describe('getSafeWalletProvider', () => {
  it('recognizes the direct Safe connector', async () => {
    const provider = { request: vi.fn() }
    await expect(getSafeWalletProvider({
      id: 'safe',
      name: 'Safe',
      getProvider: async () => provider,
    })).resolves.toBe(provider)
  })

  it('recognizes Safe connected through WalletConnect peer metadata', async () => {
    const provider = {
      request: vi.fn(),
      session: {
        peer: {
          metadata: {
            name: 'Safe{Wallet}',
            url: 'https://app.safe.global',
          },
        },
      },
    }
    await expect(getSafeWalletProvider({
      id: 'walletConnect',
      name: 'WalletConnect',
      getProvider: async () => provider,
    })).resolves.toBe(provider)
  })

  it('does not treat another WalletConnect peer as Safe', async () => {
    const provider = {
      request: vi.fn(),
      session: { peer: { metadata: { name: 'Example Wallet', url: 'https://example.com' } } },
    }
    await expect(getSafeWalletProvider({
      id: 'walletConnect',
      name: 'WalletConnect',
      getProvider: async () => provider,
    })).resolves.toBeUndefined()
  })
})

describe('getSafeAtomicCapability', () => {
  it.each(['supported', 'ready'] as const)('accepts per-chain atomic status %s', async (status) => {
    const provider: WalletProviderLike = {
      request: vi.fn().mockResolvedValue({ '0x1': { atomic: { status } } }),
    }
    await expect(getSafeAtomicCapability(provider, SAFE_HASH.slice(0, 42) as `0x${string}`, 1)).resolves.toEqual({ status })
  })

  it('rejects missing or unsupported atomic capability before review', async () => {
    const provider: WalletProviderLike = {
      request: vi.fn().mockResolvedValue({ '0x1': { atomic: { status: 'unsupported' } } }),
    }
    await expect(getSafeAtomicCapability(provider, SAFE_HASH.slice(0, 42) as `0x${string}`, 1)).rejects.toThrow(/unsupported/)
  })

  it('rejects a global-only atomic capability because atomic support is chain-specific', async () => {
    const provider: WalletProviderLike = {
      request: vi.fn().mockResolvedValue({
        '0x0': { atomic: { status: 'supported' } },
        '0x1': { paymasterService: { supported: true } },
      }),
    }
    await expect(getSafeAtomicCapability(provider, SAFE_HASH.slice(0, 42) as `0x${string}`, 1)).rejects.toThrow(/does not advertise atomic execution/)
  })
})

describe('sendSafeAtomicCalls', () => {
  it('serializes the complete sealed EIP-5792 envelope without injected capabilities', async () => {
    const account = SAFE_HASH.slice(0, 42) as `0x${string}`
    const target = EXECUTION_HASH.slice(0, 42) as `0x${string}`
    const request = vi.fn().mockResolvedValue({ id: SAFE_HASH })

    await expect(sendSafeAtomicCalls({ request }, {
      schemaVersion: 1,
      version: '2.0.0',
      from: account,
      chainId: 1,
      atomicRequired: true,
      calls: [{ to: target, data: '0x1234', value: 0n }],
      capabilities: {},
      atomicCapability: { status: 'supported' },
    })).resolves.toBe(SAFE_HASH)

    expect(request).toHaveBeenCalledWith({
      method: 'wallet_sendCalls',
      params: [{
        version: '2.0.0',
        from: account,
        chainId: '0x1',
        atomicRequired: true,
        calls: [{ to: target, data: '0x1234', value: '0x0' }],
        capabilities: {},
      }],
    })
  })
})

describe('waitForSafeTransactionExecution', () => {
  it('returns an immediately mined on-chain hash without Safe status data', async () => {
    const walletProvider: WalletProviderLike = { request: vi.fn() }
    const publicClient: ReceiptClientLike = {
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt(SAFE_HASH)),
    }

    await expect(waitForSafeTransactionExecution({
      submittedHash: SAFE_HASH,
      walletProvider,
      publicClient,
      pollingIntervalMs: 0,
    })).resolves.toEqual({ hash: SAFE_HASH, receipt: receipt(SAFE_HASH) })
    expect(walletProvider.request).not.toHaveBeenCalled()
  })

  it('resolves a pending Safe hash to its on-chain execution hash', async () => {
    const walletProvider: WalletProviderLike = {
      request: vi.fn()
        .mockResolvedValueOnce({ status: 100 })
        .mockResolvedValueOnce({
          status: 200,
          receipts: [{ transactionHash: EXECUTION_HASH }],
        }),
    }
    const publicClient: ReceiptClientLike = {
      getTransactionReceipt: vi.fn(async ({ hash }) => {
        if (hash === EXECUTION_HASH) return receipt(EXECUTION_HASH)
        throw new Error('Transaction receipt not found')
      }),
    }

    await expect(waitForSafeTransactionExecution({
      submittedHash: SAFE_HASH,
      walletProvider,
      publicClient,
      pollingIntervalMs: 0,
    })).resolves.toEqual({
      hash: EXECUTION_HASH,
      receipt: receipt(EXECUTION_HASH),
    })
    expect(walletProvider.request).toHaveBeenCalledWith({
      method: 'wallet_getCallsStatus',
      params: [SAFE_HASH],
    })
  })

  it('requires confirmed atomic status for a reviewed Safe batch', async () => {
    const walletProvider: WalletProviderLike = {
      request: vi.fn().mockResolvedValue({
        status: 200,
        atomic: true,
        receipts: [{ transactionHash: EXECUTION_HASH }],
      }),
    }
    const publicClient: ReceiptClientLike = {
      getTransactionReceipt: vi.fn(async ({ hash }) => {
        if (hash === EXECUTION_HASH) return receipt(EXECUTION_HASH)
        throw new Error('Transaction receipt not found')
      }),
    }

    await expect(waitForSafeTransactionExecution({
      submittedHash: SAFE_HASH,
      walletProvider,
      publicClient,
      pollingIntervalMs: 0,
      requireAtomic: true,
    })).resolves.toEqual({ hash: EXECUTION_HASH, receipt: receipt(EXECUTION_HASH), atomic: true })
  })

  it('rejects a confirmed non-atomic Safe batch', async () => {
    const walletProvider: WalletProviderLike = {
      request: vi.fn().mockResolvedValue({ status: 200, atomic: false }),
    }
    const publicClient: ReceiptClientLike = {
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error('Transaction receipt not found')),
    }

    await expect(waitForSafeTransactionExecution({
      submittedHash: SAFE_HASH,
      walletProvider,
      publicClient,
      pollingIntervalMs: 0,
      requireAtomic: true,
    })).rejects.toThrow(/not atomic/)
  })

  it('retries while Safe has not indexed the submitted hash yet', async () => {
    const walletProvider: WalletProviderLike = {
      request: vi.fn()
        .mockRejectedValueOnce(new Error('Transaction not found'))
        .mockResolvedValueOnce({
          status: 200,
          receipts: [{ transactionHash: EXECUTION_HASH }],
        }),
    }
    const publicClient: ReceiptClientLike = {
      getTransactionReceipt: vi.fn(async ({ hash }) => {
        if (hash === EXECUTION_HASH) return receipt(EXECUTION_HASH)
        throw new Error('Transaction receipt not found')
      }),
    }

    await expect(waitForSafeTransactionExecution({
      submittedHash: SAFE_HASH,
      walletProvider,
      publicClient,
      pollingIntervalMs: 0,
    })).resolves.toMatchObject({ hash: EXECUTION_HASH })
  })

  it('falls back to the Safe receipt when calls status is unavailable', async () => {
    const walletProvider: WalletProviderLike = {
      request: vi.fn(async ({ method }) => {
        if (method === 'wallet_getCallsStatus') {
          throw Object.assign(new Error('Method not found'), { code: -32601 })
        }
        return {
          transactionHash: SAFE_HASH,
          blockHash: BLOCK_HASH,
          transactionIndex: '0x1',
        }
      }),
    }
    const publicClient: ReceiptClientLike = {
      getTransactionReceipt: vi.fn(async ({ hash }) => {
        if (hash === EXECUTION_HASH) return receipt(EXECUTION_HASH)
        throw new Error('Transaction receipt not found')
      }),
      getTransaction: vi.fn().mockResolvedValue({ hash: EXECUTION_HASH }),
    }

    await expect(waitForSafeTransactionExecution({
      submittedHash: SAFE_HASH,
      walletProvider,
      publicClient,
      pollingIntervalMs: 0,
    })).resolves.toMatchObject({ hash: EXECUTION_HASH })
    expect(publicClient.getTransaction).toHaveBeenCalledWith({
      blockHash: BLOCK_HASH,
      index: 1,
    })
  })

  it.each([
    [400, 'Safe transaction was cancelled'],
    [500, 'Safe transaction failed'],
    [600, 'Safe transaction failed'],
  ])('stops on terminal Safe status %s', async (status, message) => {
    const walletProvider: WalletProviderLike = {
      request: vi.fn().mockResolvedValue({ status }),
    }
    const publicClient: ReceiptClientLike = {
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error('Transaction receipt not found')),
    }

    await expect(waitForSafeTransactionExecution({
      submittedHash: SAFE_HASH,
      walletProvider,
      publicClient,
      pollingIntervalMs: 0,
    })).rejects.toThrow(message)
  })

  it('stops with an unknown status when neither provider returns a receipt', async () => {
    vi.useFakeTimers()
    const walletProvider: WalletProviderLike = {
      request: vi.fn().mockResolvedValue({ status: 100 }),
    }
    const publicClient: ReceiptClientLike = {
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error('Transaction receipt not found')),
    }

    try {
      const pending = waitForSafeTransactionExecution({
        submittedHash: SAFE_HASH,
        walletProvider,
        publicClient,
        pollingIntervalMs: 1_000,
        timeoutMs: 5_000,
      })
      const rejection = expect(pending).rejects.toBeInstanceOf(SafeTransactionStatusUnknownError)

      await vi.advanceTimersByTimeAsync(5_000)
      await rejection
    }
    finally {
      vi.useRealTimers()
    }
  })
})
