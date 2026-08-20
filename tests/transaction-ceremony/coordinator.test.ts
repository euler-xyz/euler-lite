import { getAddress, hashTypedData, keccak256, toHex, type Hash } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { EoaCeremonyAdapter, type EoaAdapterClient } from '~/features/transaction-ceremony/adapters/eoa'
import type { CeremonyTransportAdapter } from '~/features/transaction-ceremony/adapters/types'
import { TransactionCeremonyCoordinator } from '~/features/transaction-ceremony/coordinator/coordinator'
import { MutableCeremonyEmergencySwitch } from '~/features/transaction-ceremony/coordinator/emergency-switch'
import { sealCeremony } from '~/features/transaction-ceremony/domain/seal'
import { executionTemplateDigest } from '~/features/transaction-ceremony/materialization/prepared-plan'
import { MemoryCeremonyJournal, requestVectorDigest } from '~/features/transaction-ceremony/persistence/journal'
import { walletLaneKey } from '~/features/transaction-ceremony/persistence/locks'
import { buildSimulationCertificate } from '~/features/transaction-ceremony/simulation/coverage'
import { artifactFor, makeCeremony, materializedExecutorFor, TEST_ACCOUNT, TEST_EVC, TEST_TOKEN } from './fixtures'

const HASH = `0x${'ab'.repeat(32)}` as Hash

const makeClient = (overrides: Partial<EoaAdapterClient> = {}): EoaAdapterClient => ({
  getBlockNumber: async () => 100n,
  getTransactionCount: async () => 7,
  sendTransaction: async () => HASH,
  getTransaction: async () => ({
    hash: HASH,
    from: getAddress('0x1000000000000000000000000000000000000000'),
    to: getAddress('0x4000000000000000000000000000000000000000'),
    input: makeCeremony().template.requests[0]!.data,
    value: 0n,
    chainId: 1,
    nonce: 7,
  }),
  waitForTransactionReceipt: async () => ({ transactionHash: HASH, status: 'success' }),
  ...overrides,
})

const rejectingSafeAdapter: CeremonyTransportAdapter = {
  transport: 'safe',
  dispatch: async () => { throw new Error('not used') },
}

const setup = (
  client: EoaAdapterClient,
  journal = new MemoryCeremonyJournal(),
  ceremony = makeCeremony(),
  eoaAdapter: CeremonyTransportAdapter = new EoaCeremonyAdapter(client, materializedExecutorFor(client), TEST_EVC),
) => {
  const emergencySwitch = new MutableCeremonyEmergencySwitch()
  let now = 100
  const coordinator = new TransactionCeremonyCoordinator({
    journal,
    emergencySwitch,
    adapters: { eoa: eoaAdapter, safe: rejectingSafeAdapter },
    readWalletBinding: async () => ceremony.template.wallet,
    revalidatePolicy: async () => {},
    collectSignature: async () => '0x01',
    refreshPyth: async () => [],
    finalize: current => artifactFor(current),
    now: () => now++,
    createId: kind => `${kind}-1`,
    withLaneLock: async (_lane, work) => work(),
  })
  return { ceremony, coordinator, journal, emergencySwitch }
}

const ceremonyWithSignature = () => {
  const base = makeCeremony()
  const request = base.template.requests[0]!
  const requestId = 'requestId' in request ? request.requestId : request.callId
  const typedData = {
    domain: { name: 'Authorization', chainId: 1, verifyingContract: TEST_TOKEN },
    types: { Authorization: [{ name: 'owner', type: 'address' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Authorization' as const,
    message: { owner: TEST_ACCOUNT, deadline: 2_000_000_000n },
  }
  const template = {
    ...base.template,
    signatureSlots: [{
      slotId: keccak256(toHex('signature-slot')),
      kind: 'migration' as const,
      signer: TEST_ACCOUNT,
      chainId: 1,
      typedData,
      typedDataHash: hashTypedData(typedData),
      validUntil: 2_000_000_000,
      insertionPoints: [{ requestId, effectId: base.template.effects[0]!.effectId, batchItemIndex: 0, abiArgumentPath: ['authorization', 'signature'] }],
    }],
  }
  const templateDigest = executionTemplateDigest(template)
  return sealCeremony({
    intents: base.intents,
    template,
    policyEvidence: base.policyEvidence,
    simulation: buildSimulationCertificate({ template, templateDigest, observedAt: 10, projection: { canExecute: true, simulatedAccounts: [], simulatedVaults: [] } }),
    plugins: base.plugins,
    validity: base.validity,
    presentationKind: 'supply',
    presentationInputs: { amount: '10', symbol: 'USDC' },
  })
}

describe('transaction ceremony coordinator', () => {
  it('persists and reads back dispatching before invoking the wallet', async () => {
    const journal = new MemoryCeremonyJournal()
    const sendTransaction = vi.fn(async () => {
      const attempts = await journal.listRecoverableAttempts()
      expect(attempts).toHaveLength(1)
      expect(attempts[0]!.state).toBe('dispatching')
      return HASH
    })
    const prepared = setup(makeClient({ sendTransaction }), journal)
    const result = await prepared.coordinator.execute(prepared.ceremony, { ceremonyId: prepared.ceremony.ceremonyId, consentDigest: prepared.ceremony.consentDigest })

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
    await expect(prepared.coordinator.execute(prepared.ceremony, { ceremonyId: prepared.ceremony.ceremonyId, consentDigest: prepared.ceremony.consentDigest }))
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
    await expect(prepared.coordinator.execute(prepared.ceremony, { ceremonyId: prepared.ceremony.ceremonyId, consentDigest: prepared.ceremony.consentDigest }))
      .rejects.toThrow(/cancelled/)
    expect(await prepared.journal.listRecoverableAttempts()).toEqual([])
  })

  it('blocks new reservations with the emergency switch without hiding recovery state', async () => {
    const prepared = setup(makeClient())
    prepared.emergencySwitch.disableNewCeremonies('maintenance')
    await expect(prepared.coordinator.execute(prepared.ceremony, { ceremonyId: prepared.ceremony.ceremonyId, consentDigest: prepared.ceremony.consentDigest }))
      .rejects.toThrow(/maintenance/)
    expect(await prepared.journal.listRecoverableAttempts()).toEqual([])
  })

  it('resumes an already reserved pre-dispatch attempt while new ceremonies are disabled', async () => {
    const prepared = setup(makeClient())
    await prepared.journal.putCeremony(prepared.ceremony)
    const attempt = await prepared.journal.reserveAttempt({
      ceremony: prepared.ceremony,
      attemptId: 'attempt-existing',
      reservationId: 'reservation-existing',
      laneKey: walletLaneKey(prepared.ceremony.template.wallet.account, prepared.ceremony.template.wallet.chainId),
      requestVectorDigest: requestVectorDigest(prepared.ceremony),
      now: 50,
    })
    prepared.emergencySwitch.disableNewCeremonies('maintenance')
    const result = await prepared.coordinator.resume(attempt.attemptId)
    expect(result.attempt.state).toBe('succeeded')
  })

  it('never retries an attempt that reached a durable signature prompt', async () => {
    const prepared = setup(makeClient())
    await prepared.journal.putCeremony(prepared.ceremony)
    let attempt = await prepared.journal.reserveAttempt({
      ceremony: prepared.ceremony,
      attemptId: 'attempt-signing',
      reservationId: 'reservation-signing',
      laneKey: walletLaneKey(prepared.ceremony.template.wallet.account, prepared.ceremony.template.wallet.chainId),
      requestVectorDigest: requestVectorDigest(prepared.ceremony),
      now: 50,
    })
    attempt = await prepared.journal.transitionAttempt({ expected: attempt, to: 'revalidating', now: 51 })
    attempt = await prepared.journal.transitionAttempt({ expected: attempt, to: 'signing', now: 52 })

    await expect(prepared.coordinator.resume(attempt.attemptId)).rejects.toThrow(/wallet prompt.*reconciled/)
    expect((await prepared.journal.listRecoverableAttempts())[0]?.state).toBe('signing')
  })

  it('never retries a finalized attempt after a signature was collected', async () => {
    const ceremony = ceremonyWithSignature()
    const prepared = setup(makeClient(), new MemoryCeremonyJournal(), ceremony)
    await prepared.journal.putCeremony(ceremony)
    let attempt = await prepared.journal.reserveAttempt({
      ceremony,
      attemptId: 'attempt-signed-finalized',
      reservationId: 'reservation-signed-finalized',
      laneKey: walletLaneKey(ceremony.template.wallet.account, ceremony.template.wallet.chainId),
      requestVectorDigest: requestVectorDigest(ceremony),
      now: 50,
    })
    attempt = await prepared.journal.transitionAttempt({ expected: attempt, to: 'revalidating', now: 51 })
    attempt = await prepared.journal.transitionAttempt({ expected: attempt, to: 'signing', now: 52 })
    attempt = await prepared.journal.transitionAttempt({ expected: attempt, to: 'finalized', now: 53 })

    await expect(prepared.coordinator.resume(attempt.attemptId)).rejects.toThrow(/wallet prompt.*reconciled/)
    expect((await prepared.journal.listRecoverableAttempts())[0]?.state).toBe('finalized')
  })

  it('keeps the lane recoverable when wallet context drifts after a signature response', async () => {
    const ceremony = ceremonyWithSignature()
    const journal = new MemoryCeremonyJournal()
    const sendTransaction = vi.fn(async () => HASH)
    const collectSignature = vi.fn(async () => '0x01' as const)
    let walletReads = 0
    const coordinator = new TransactionCeremonyCoordinator({
      journal,
      emergencySwitch: new MutableCeremonyEmergencySwitch(),
      adapters: {
        eoa: (() => {
          const client = makeClient({ sendTransaction })
          return new EoaCeremonyAdapter(client, materializedExecutorFor(client), TEST_EVC)
        })(),
        safe: rejectingSafeAdapter,
      },
      readWalletBinding: async () => ++walletReads >= 5
        ? { ...ceremony.template.wallet, connectorSessionId: 'changed-session' }
        : ceremony.template.wallet,
      revalidatePolicy: async () => {},
      collectSignature,
      refreshPyth: async () => [],
      finalize: current => artifactFor(current),
      now: () => 100,
      createId: kind => `${kind}-signed`,
      withLaneLock: async (_lane, work) => work(),
    })

    await expect(coordinator.execute(ceremony, { ceremonyId: ceremony.ceremonyId, consentDigest: ceremony.consentDigest }))
      .rejects.toThrow(/Wallet connection.*changed/)
    expect(collectSignature).toHaveBeenCalledOnce()
    expect(sendTransaction).not.toHaveBeenCalled()
    expect((await journal.listRecoverableAttempts())[0]?.state).toBe('recovery-required')
  })

  it('persists cleanup before dispatch and completes it after the reviewed cleanup confirms', async () => {
    const owner = { intentId: 'intent-1', intentRevision: 1 }
    const ceremony = makeCeremony('eoa', {
      before: [{ phase: 'prerequisite', owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: TEST_TOKEN, data: '0x01020304' }],
      after: [{ phase: 'cleanup', owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: TEST_TOKEN, data: '0x05060708' }],
    })
    const requests = ceremony.template.requests
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
    }), new MemoryCeremonyJournal(), ceremony)
    const result = await prepared.coordinator.execute(ceremony, { ceremonyId: ceremony.ceremonyId, consentDigest: ceremony.consentDigest })
    const obligations = await prepared.journal.listCleanupObligations(result.attempt.attemptId)
    expect(obligations).toHaveLength(1)
    expect(obligations[0]?.status).toBe('completed')
  })

  it('retains the lane as cleanup-required when a grant succeeded before a later known revert', async () => {
    const owner = { intentId: 'intent-1', intentRevision: 1 }
    const ceremony = makeCeremony('eoa', {
      before: [{ phase: 'prerequisite', owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: TEST_TOKEN, data: '0x01020304' }],
      after: [{ phase: 'cleanup', owner, provenance: { source: 'migration-authorization', mode: 'transaction' }, chainId: 1, to: TEST_TOKEN, data: '0x05060708' }],
    })
    const requests = ceremony.template.requests
    let sent = 0
    const prepared = setup(makeClient({
      sendTransaction: async () => (`0x${String(++sent).padStart(64, '0')}`) as Hash,
      getTransaction: async (hash) => {
        const index = Number.parseInt(hash.slice(-1), 16) - 1
        const request = requests[index]!
        return { hash, from: TEST_ACCOUNT, to: request.to, input: request.data, value: request.value, chainId: 1, nonce: 7 }
      },
      waitForTransactionReceipt: async hash => ({ transactionHash: hash, status: hash.endsWith('2') ? 'reverted' : 'success' }),
    }), new MemoryCeremonyJournal(), ceremony)
    await expect(prepared.coordinator.execute(ceremony, { ceremonyId: ceremony.ceremonyId, consentDigest: ceremony.consentDigest })).rejects.toThrow(/reverted/)
    const [attempt] = await prepared.journal.listRecoverableAttempts()
    expect(attempt?.state).toBe('cleanup-required')
    expect((await prepared.journal.listCleanupObligations(attempt!.attemptId))[0]?.status).toBe('pending')
  })
})
