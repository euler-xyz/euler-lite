import type { Hash } from 'viem'
import type { EoaRequest } from '../domain/reviewed-execution'
import type { EoaAdapterClient } from './eoa'
import type { SafeAdapterClient } from './safe'
import { getSafeAtomicCapability, sendSafeAtomicCalls, waitForSafeTransactionExecution, type WalletProviderLike } from '~/utils/safeWalletTransactions'

interface PublicTransactionClient {
  getTransactionReceipt(args: { hash: Hash }): Promise<{ transactionHash: Hash, status: 'success' | 'reverted', blockNumber: bigint }>
}

export const createAppEoaClients = ({
  send,
}: {
  send(request: EoaRequest): Promise<Hash>
}): { adapter: EoaAdapterClient } => ({
  adapter: {
    sendTransaction: send,
  },
})

/** Use the established current-session Safe polling and receipt resolution. */
export const createAppSafeClients = ({
  provider,
  publicClient,
}: {
  provider: WalletProviderLike
  publicClient: PublicTransactionClient
}): { adapter: SafeAdapterClient } => {
  return {
    adapter: {
      assertAtomicCapability: async (envelope) => {
        await getSafeAtomicCapability(provider, envelope.from, envelope.chainId)
      },
      sendCalls: envelope => sendSafeAtomicCalls(provider, envelope),
      waitForExecution: async (callsId) => {
        const execution = await waitForSafeTransactionExecution({
          callsId,
          walletProvider: provider,
          publicClient: publicClient as never,
          requireAtomic: true,
        })
        return {
          executionHash: execution.hash,
          receiptStatus: execution.receipt.status,
          confirmedBlockNumber: execution.receipt.blockNumber,
          atomic: execution.atomic === true,
        }
      },
    },
  }
}
