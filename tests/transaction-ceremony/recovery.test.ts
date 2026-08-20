import { getAddress, type Hash } from 'viem'
import { describe, expect, it } from 'vitest'
import { EoaCeremonyAdapter, type EoaAdapterClient } from '~/features/transaction-ceremony/adapters/eoa'
import { SafeCeremonyAdapter } from '~/features/transaction-ceremony/adapters/safe'
import type { CeremonyTransportAdapter } from '~/features/transaction-ceremony/adapters/types'
import { TransactionCeremonyCoordinator } from '~/features/transaction-ceremony/coordinator/coordinator'
import { MutableCeremonyEmergencySwitch } from '~/features/transaction-ceremony/coordinator/emergency-switch'
import { EoaAttemptReconciler, SafeAttemptReconciler } from '~/features/transaction-ceremony/coordinator/reconcilers'
import { CeremonyRecoveryService } from '~/features/transaction-ceremony/coordinator/recovery'
import { MemoryCeremonyJournal } from '~/features/transaction-ceremony/persistence/journal'
import { artifactFor, makeCeremony, materializedExecutorFor, TEST_ACCOUNT, TEST_EVC } from './fixtures'

const HASH = `0x${'ab'.repeat(32)}` as Hash
const unused: CeremonyTransportAdapter = {
  transport: 'safe',
  dispatch: async () => { throw new Error('unused') },
}

describe('durable transport reconciliation', () => {
  it('finds a lost-response EOA transaction and verifies the exact reviewed request', async () => {
    const ceremony = makeCeremony()
    const request = ceremony.template.requests[0]!
    const transaction = { hash: HASH, from: TEST_ACCOUNT, to: request.to, input: request.data, value: request.value, chainId: 1, nonce: 7 }
    const journal = new MemoryCeremonyJournal()
    const dispatchClient: EoaAdapterClient = {
      getBlockNumber: async () => 100n,
      getTransactionCount: async () => 7,
      sendTransaction: async () => { throw new Error('provider disconnected after acceptance') },
      getTransaction: async () => transaction,
      waitForTransactionReceipt: async () => ({ transactionHash: HASH, status: 'success' }),
    }
    const coordinator = new TransactionCeremonyCoordinator({
      journal,
      emergencySwitch: new MutableCeremonyEmergencySwitch(),
      adapters: { eoa: new EoaCeremonyAdapter(dispatchClient, materializedExecutorFor(dispatchClient), TEST_EVC), safe: unused },
      readWalletBinding: async () => ceremony.template.wallet,
      revalidatePolicy: async () => {},
      collectSignature: async () => '0x01',
      refreshPyth: async () => [],
      finalize: current => artifactFor(current),
      now: () => 100,
      createId: kind => `${kind}-recovery`,
      withLaneLock: async (_key, work) => work(),
    })
    await expect(coordinator.execute(ceremony, { ceremonyId: ceremony.ceremonyId, consentDigest: ceremony.consentDigest })).rejects.toThrow(/reconciliation/)
    const [attempt] = await journal.listRecoverableAttempts()
    const eoa = new EoaAttemptReconciler(journal, {
      getTransaction: async () => undefined,
      getTransactionReceipt: async () => ({ transactionHash: HASH, status: 'success' }),
      findTransaction: async () => transaction,
    })
    const recovery = new CeremonyRecoveryService(journal, { eoa, safe: { reconcile: async () => ({ state: 'recovery-required' }) } }, () => 500)
    const recovered = await recovery.reconcile(attempt!.attemptId)
    expect(recovered.state).toBe('succeeded')
    expect(recovered.externalIds).toContainEqual({ kind: 'transaction-hash', value: HASH })
  })

  it('keeps a mismatched EOA transaction unresolved', async () => {
    const ceremony = makeCeremony()
    const request = ceremony.template.requests[0]!
    const journal = new MemoryCeremonyJournal()
    const coordinator = new TransactionCeremonyCoordinator({
      journal,
      emergencySwitch: new MutableCeremonyEmergencySwitch(),
      adapters: {
        eoa: (() => {
          const client: EoaAdapterClient = {
            getBlockNumber: async () => 100n,
            getTransactionCount: async () => 7,
            sendTransaction: async () => { throw new Error('lost') },
            getTransaction: async () => { throw new Error('unused') },
            waitForTransactionReceipt: async () => { throw new Error('unused') },
          }
          return new EoaCeremonyAdapter(client, materializedExecutorFor(client), TEST_EVC)
        })(),
        safe: unused,
      },
      readWalletBinding: async () => ceremony.template.wallet,
      revalidatePolicy: async () => {}, collectSignature: async () => '0x01', refreshPyth: async () => [],
      finalize: current => artifactFor(current), createId: kind => `${kind}-mismatch`, withLaneLock: async (_key, work) => work(),
      now: () => 100,
    })
    await expect(coordinator.execute(ceremony, { ceremonyId: ceremony.ceremonyId, consentDigest: ceremony.consentDigest })).rejects.toThrow()
    const [attempt] = await journal.listRecoverableAttempts()
    const eoa = new EoaAttemptReconciler(journal, {
      getTransaction: async () => undefined,
      getTransactionReceipt: async () => ({ transactionHash: HASH, status: 'success' }),
      findTransaction: async () => ({ hash: HASH, from: TEST_ACCOUNT, to: getAddress('0x9000000000000000000000000000000000000000'), input: request.data, value: 0n, chainId: 1, nonce: 7 }),
    })
    const recovery = new CeremonyRecoveryService(journal, { eoa, safe: { reconcile: async () => ({ state: 'recovery-required' }) } })
    expect((await recovery.reconcile(attempt!.attemptId)).state).toBe('recovery-required')
  })

  it('uses the Safe receipt rather than a failure status code', async () => {
    const ceremony = makeCeremony('safe')
    const journal = new MemoryCeremonyJournal()
    const callsId = 'calls-1'
    const adapter = new SafeCeremonyAdapter({
      sendCalls: async () => callsId,
      getProposedCalls: async () => ceremony.template.requests,
      waitForCallsStatus: async () => ({ status: 600, executionHash: HASH }),
      getExecutionReceipt: async () => undefined,
    })
    const coordinator = new TransactionCeremonyCoordinator({
      journal,
      emergencySwitch: new MutableCeremonyEmergencySwitch(),
      adapters: { eoa: { transport: 'eoa', dispatch: async () => { throw new Error('unused') } }, safe: adapter },
      readWalletBinding: async () => ceremony.template.wallet,
      revalidatePolicy: async () => {}, collectSignature: async () => '0x01', refreshPyth: async () => [],
      finalize: current => artifactFor(current), createId: kind => `${kind}-safe`, withLaneLock: async (_key, work) => work(),
      now: () => 100,
    })
    await expect(coordinator.execute(ceremony, { ceremonyId: ceremony.ceremonyId, consentDigest: ceremony.consentDigest })).rejects.toThrow(/reconciliation/)
    const [attempt] = await journal.listRecoverableAttempts()
    const safe = new SafeAttemptReconciler(journal, {
      getProposedCalls: async () => ceremony.template.requests,
      getCallsStatus: async () => ({ status: 600, executionHash: HASH }),
      getExecutionReceipt: async () => ({ status: 'reverted' }),
    })
    const recovery = new CeremonyRecoveryService(journal, { safe, eoa: { reconcile: async () => ({ state: 'recovery-required' }) } })
    expect((await recovery.reconcile(attempt!.attemptId)).state).toBe('reverted')
  })
})
