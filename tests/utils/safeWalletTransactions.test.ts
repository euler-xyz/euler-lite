import type { Hash, TransactionReceipt } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  getSafeWalletProvider,
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

  it('stops on an off-chain Safe cancellation', async () => {
    const walletProvider: WalletProviderLike = {
      request: vi.fn().mockResolvedValue({ status: 400 }),
    }
    const publicClient: ReceiptClientLike = {
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error('Transaction receipt not found')),
    }

    await expect(waitForSafeTransactionExecution({
      submittedHash: SAFE_HASH,
      walletProvider,
      publicClient,
      pollingIntervalMs: 0,
    })).rejects.toThrow('Safe transaction was cancelled')
  })

  it.each([500, 600])('resolves the reverted receipt from terminal Safe status %s', async (status) => {
    const walletProvider: WalletProviderLike = {
      request: vi.fn().mockResolvedValue({
        status,
        receipts: [{ transactionHash: EXECUTION_HASH }],
      }),
    }
    const publicClient: ReceiptClientLike = {
      getTransactionReceipt: vi.fn(async ({ hash }) => {
        if (hash === EXECUTION_HASH) return receipt(EXECUTION_HASH, 'reverted')
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
      receipt: receipt(EXECUTION_HASH, 'reverted'),
    })
  })

  it('keeps a failed Safe status unresolved when no execution hash is available', async () => {
    vi.useFakeTimers()
    const walletProvider: WalletProviderLike = {
      request: vi.fn().mockResolvedValue({ status: 500 }),
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
