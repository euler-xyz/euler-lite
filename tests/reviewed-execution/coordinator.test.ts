import { getAddress, hashTypedData, keccak256, toHex, type Hash } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { EoaExecutionAdapter, type EoaAdapterClient } from '~/features/reviewed-execution/adapters/eoa'
import type { ExecutionTransportAdapter } from '~/features/reviewed-execution/adapters/types'
import { ReviewedExecutionCoordinator } from '~/features/reviewed-execution/coordinator/coordinator'
import { MutableExecutionEmergencySwitch } from '~/features/reviewed-execution/coordinator/emergency-switch'
import { sealReviewedExecution } from '~/features/reviewed-execution/domain/seal'
import { reviewedRequestDigest } from '~/features/reviewed-execution/materialization/prepared-plan'
import { MemorySubmissionJournal, requestVectorDigest } from '~/features/reviewed-execution/persistence/journal'
import { walletLaneKey } from '~/features/reviewed-execution/persistence/locks'
import { buildReviewedSimulation } from '~/features/reviewed-execution/simulation/coverage'
import { artifactFor, makeReviewedExecution, materializedExecutorFor, TEST_ACCOUNT, TEST_EVC, TEST_TOKEN } from './fixtures'

const HASH = `0x${'ab'.repeat(32)}` as Hash

const makeClient = (overrides: Partial<EoaAdapterClient> = {}): EoaAdapterClient => ({
  getBlockNumber: async () => 100n,
  getTransactionCount: async () => 7,
  sendTransaction: async () => HASH,
  getTransaction: async () => ({
    hash: HASH,
    from: getAddress('0x1000000000000000000000000000000000000000'),
    to: getAddress('0x4000000000000000000000000000000000000000'),
    input: makeReviewedExecution().requestSet.requests[0]!.data,
    value: 0n,
    chainId: 1,
    nonce: 7,
  }),
  waitForTransactionReceipt: async () => ({ transactionHash: HASH, status: 'success' }),
  ...overrides,
})

const rejectingSafeAdapter: ExecutionTransportAdapter = {
  transport: 'safe',
  dispatch: async () => { throw new Error('not used') },
}

const setup = (
  client: EoaAdapterClient,
  journal = new MemorySubmissionJournal(),
  execution = makeReviewedExecution(),
  eoaAdapter: ExecutionTransportAdapter = new EoaExecutionAdapter(client, materializedExecutorFor(client), TEST_EVC),
) => {
  const emergencySwitch = new MutableExecutionEmergencySwitch()
  let now = 100
  const coordinator = new ReviewedExecutionCoordinator({
    journal,
    emergencySwitch,
    adapters: { eoa: eoaAdapter, safe: rejectingSafeAdapter },
    readWalletBinding: async () => execution.requestSet.wallet,
    revalidatePolicy: async () => {},
    collectSignature: async () => '0x01',
    refreshPyth: async () => [],
    finalize: current => artifactFor(current),
    now: () => now++,
    createId: kind => `${kind}-1`,
    withLaneLock: async (_lane, work) => work(),
  })
  return { execution, coordinator, journal, emergencySwitch }
}

const executionWithSignature = () => {
  const base = makeReviewedExecution()
  const request = base.requestSet.requests[0]!
  const requestId = 'requestId' in request ? request.requestId : request.callId
  const typedData = {
    domain: { name: 'Authorization', chainId: 1, verifyingContract: TEST_TOKEN },
    types: { Authorization: [{ name: 'owner', type: 'address' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Authorization' as const,
    message: { owner: TEST_ACCOUNT, deadline: 2_000_000_000n },
  }
  const requestSet = {
    ...base.requestSet,
    signatureSlots: [{
      slotId: keccak256(toHex('signature-slot')),
      kind: 'migration' as const,
      signer: TEST_ACCOUNT,
      chainId: 1,
      typedData,
      typedDataHash: hashTypedData(typedData),
      validUntil: 2_000_000_000,
      insertionPoints: [{ requestId, effectId: base.requestSet.effects[0]!.effectId, batchItemIndex: 0, abiArgumentPath: ['authorization', 'signature'] }],
    }],
  }
  const requestDigest = reviewedRequestDigest(requestSet)
  return sealReviewedExecution({
    intents: base.intents,
    requestSet: requestSet,
    policy: base.policy,
    simulation: buildReviewedSimulation({ requestSet, requestDigest, observedAt: 10, projection: { canExecute: true, simulatedAccounts: [], simulatedVaults: [] } }),
    pluginSnapshot: base.pluginSnapshot,
    validity: base.validity,
    presentationKind: 'supply',
    presentationInputs: { amount: '10', symbol: 'USDC' },
  })
}

describe('reviewed execution coordinator', () => {
  it('persists and reads back dispatching before invoking the wallet', async () => {
    const journal = new MemorySubmissionJournal()
    const sendTransaction = vi.fn(async () => {
      const attempts = await journal.listRecoverableAttempts()
      expect(attempts).toHaveLength(1)
      expect(attempts[0]!.state).toBe('dispatching')
      return HASH
    })
    const prepared = setup(makeClient({ sendTransaction }), journal)
    const result = await prepared.coordinator.execute(prepared.execution, { reviewId: prepared.execution.reviewId, reviewDigest: prepared.execution.reviewDigest })

    expect(sendTransaction).toHaveBeenCalledOnce()
    expect(result.attempt.state).toBe('succeeded')
    expect(result.attempt.externalIds).toEqual([{ kind: 'transaction-hash', value: HASH }])
    expect(await journal.listRecoverableAttempts()).toEqual([])
  })

  it('retains the lane and external ID when verification after dispatch is ambiguous', async () => {
    const prepared = setup(makeClient({
      getTransaction: async () => {
        throw new Error('rpc unavailable')
      },
    }))
    await expect(prepared.coordinator.execute(prepared.execution, { reviewId: prepared.execution.reviewId, reviewDigest: prepared.execution.reviewDigest }))
      .rejects.toThrow(/cannot yet be verified/)
    const [attempt] = await prepared.journal.listRecoverableAttempts()
    expect(attempt?.state).toBe('recovery-required')
    expect(attempt?.externalIds).toEqual([{ kind: 'transaction-hash', value: HASH }])
  })

  it('proves wallet rejection before submission and releases the lane', async () => {
    const rejection = Object.assign(new Error('User rejected'), { code: 4001 })
    const prepared = setup(makeClient({
      sendTransaction: async () => {
        throw rejection
      },
    }))
    await expect(prepared.coordinator.execute(prepared.execution, { reviewId: prepared.execution.reviewId, reviewDigest: prepared.execution.reviewDigest }))
      .rejects.toThrow(/cancelled/)
    expect(await prepared.journal.listRecoverableAttempts()).toEqual([])
  })

  it('blocks new reservations with the emergency switch without hiding recovery state', async () => {
    const prepared = setup(makeClient())
    prepared.emergencySwitch.disableNewReviews('maintenance')
    await expect(prepared.coordinator.execute(prepared.execution, { reviewId: prepared.execution.reviewId, reviewDigest: prepared.execution.reviewDigest }))
      .rejects.toThrow(/maintenance/)
    expect(await prepared.journal.listRecoverableAttempts()).toEqual([])
  })

  it('resumes an already reserved pre-dispatch attempt while new reviewed executions are disabled', async () => {
    const prepared = setup(makeClient())
    await prepared.journal.putReviewedExecution(prepared.execution)
    const attempt = await prepared.journal.reserveAttempt({
      execution: prepared.execution,
      attemptId: 'attempt-existing',
      reservationId: 'reservation-existing',
      laneKey: walletLaneKey(prepared.execution.requestSet.wallet.account, prepared.execution.requestSet.wallet.chainId),
      requestVectorDigest: requestVectorDigest(prepared.execution),
      now: 50,
    })
    prepared.emergencySwitch.disableNewReviews('maintenance')
    const result = await prepared.coordinator.resume(attempt.attemptId)
    expect(result.attempt.state).toBe('succeeded')
  })

  it('never retries an attempt that reached a durable signature prompt', async () => {
    const prepared = setup(makeClient())
    await prepared.journal.putReviewedExecution(prepared.execution)
    let attempt = await prepared.journal.reserveAttempt({
      execution: prepared.execution,
      attemptId: 'attempt-signing',
      reservationId: 'reservation-signing',
      laneKey: walletLaneKey(prepared.execution.requestSet.wallet.account, prepared.execution.requestSet.wallet.chainId),
      requestVectorDigest: requestVectorDigest(prepared.execution),
      now: 50,
    })
    attempt = await prepared.journal.transitionAttempt({ expected: attempt, to: 'revalidating', now: 51 })
    attempt = await prepared.journal.transitionAttempt({ expected: attempt, to: 'signing', now: 52 })

    await expect(prepared.coordinator.resume(attempt.attemptId)).rejects.toThrow(/wallet prompt.*reconciled/)
    expect((await prepared.journal.listRecoverableAttempts())[0]?.state).toBe('signing')
  })

  it('never retries a finalized attempt after a signature was collected', async () => {
    const execution = executionWithSignature()
    const prepared = setup(makeClient(), new MemorySubmissionJournal(), execution)
    await prepared.journal.putReviewedExecution(execution)
    let attempt = await prepared.journal.reserveAttempt({
      execution,
      attemptId: 'attempt-signed-finalized',
      reservationId: 'reservation-signed-finalized',
      laneKey: walletLaneKey(execution.requestSet.wallet.account, execution.requestSet.wallet.chainId),
      requestVectorDigest: requestVectorDigest(execution),
      now: 50,
    })
    attempt = await prepared.journal.transitionAttempt({ expected: attempt, to: 'revalidating', now: 51 })
    attempt = await prepared.journal.transitionAttempt({ expected: attempt, to: 'signing', now: 52 })
    attempt = await prepared.journal.transitionAttempt({ expected: attempt, to: 'finalized', now: 53 })

    await expect(prepared.coordinator.resume(attempt.attemptId)).rejects.toThrow(/wallet prompt.*reconciled/)
    expect((await prepared.journal.listRecoverableAttempts())[0]?.state).toBe('finalized')
  })

  it('keeps the lane recoverable when wallet context drifts after a signature response', async () => {
    const execution = executionWithSignature()
    const journal = new MemorySubmissionJournal()
    const sendTransaction = vi.fn(async () => HASH)
    const collectSignature = vi.fn(async () => '0x01' as const)
    let walletReads = 0
    const coordinator = new ReviewedExecutionCoordinator({
      journal,
      emergencySwitch: new MutableExecutionEmergencySwitch(),
      adapters: {
        eoa: (() => {
          const client = makeClient({ sendTransaction })
          return new EoaExecutionAdapter(client, materializedExecutorFor(client), TEST_EVC)
        })(),
        safe: rejectingSafeAdapter,
      },
      readWalletBinding: async () => ++walletReads >= 5
        ? { ...execution.requestSet.wallet, connectorSessionId: 'changed-session' }
        : execution.requestSet.wallet,
      revalidatePolicy: async () => {},
      collectSignature,
      refreshPyth: async () => [],
      finalize: current => artifactFor(current),
      now: () => 100,
      createId: kind => `${kind}-signed`,
      withLaneLock: async (_lane, work) => work(),
    })

    await expect(coordinator.execute(execution, { reviewId: execution.reviewId, reviewDigest: execution.reviewDigest }))
      .rejects.toThrow(/Wallet connection.*changed/)
    expect(collectSignature).toHaveBeenCalledOnce()
    expect(sendTransaction).not.toHaveBeenCalled()
    expect((await journal.listRecoverableAttempts())[0]?.state).toBe('recovery-required')
  })

  it('persists cleanup before dispatch and completes it after the reviewed cleanup confirms', async () => {
    const owner = { intentId: 'intent-1', intentRevision: 1 }
    const execution = makeReviewedExecution('eoa', {
      before: [{ phase: 'prerequisite', owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: TEST_TOKEN, data: '0x01020304' }],
      after: [{ phase: 'cleanup', owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: TEST_TOKEN, data: '0x05060708' }],
    })
    const requests = execution.requestSet.requests
    let sent = 0
    const prepared = setup(makeClient({
      sendTransaction: async () => {
        sent++
        return (`0x${String(sent).padStart(64, '0')}`) as Hash
      },
      getTransactionCount: async () => 7,
      getTransaction: async (hash) => {
        const index = Number.parseInt(hash.slice(-1), 16) - 1
        const request = requests[index]!
        return { hash, from: TEST_ACCOUNT, to: request.to, input: request.data, value: request.value, chainId: 1, nonce: 7 }
      },
      waitForTransactionReceipt: async hash => ({ transactionHash: hash, status: 'success' }),
    }), new MemorySubmissionJournal(), execution)
    const result = await prepared.coordinator.execute(execution, { reviewId: execution.reviewId, reviewDigest: execution.reviewDigest })
    const obligations = await prepared.journal.listCleanupObligations(result.attempt.attemptId)
    expect(obligations).toHaveLength(1)
    expect(obligations[0]?.status).toBe('completed')
  })

  it('retains the lane as cleanup-required when a grant succeeded before a later known revert', async () => {
    const owner = { intentId: 'intent-1', intentRevision: 1 }
    const execution = makeReviewedExecution('eoa', {
      before: [{ phase: 'prerequisite', owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: TEST_TOKEN, data: '0x01020304' }],
      after: [{ phase: 'cleanup', owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: TEST_TOKEN, data: '0x05060708' }],
    })
    const requests = execution.requestSet.requests
    let sent = 0
    const prepared = setup(makeClient({
      sendTransaction: async () => (`0x${String(++sent).padStart(64, '0')}`) as Hash,
      getTransaction: async (hash) => {
        const index = Number.parseInt(hash.slice(-1), 16) - 1
        const request = requests[index]!
        return { hash, from: TEST_ACCOUNT, to: request.to, input: request.data, value: request.value, chainId: 1, nonce: 7 }
      },
      waitForTransactionReceipt: async hash => ({ transactionHash: hash, status: hash.endsWith('2') ? 'reverted' : 'success' }),
    }), new MemorySubmissionJournal(), execution)
    await expect(prepared.coordinator.execute(execution, { reviewId: execution.reviewId, reviewDigest: execution.reviewDigest })).rejects.toThrow(/reverted/)
    const [attempt] = await prepared.journal.listRecoverableAttempts()
    expect(attempt?.state).toBe('cleanup-required')
    expect((await prepared.journal.listCleanupObligations(attempt!.attemptId))[0]?.status).toBe('pending')
  })
})
