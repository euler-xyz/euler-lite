import { encodeFunctionData, type Hash, type Hex, type TransactionReceipt } from 'viem'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it, vi } from 'vitest'
import { EVC_ABI } from '~/abis/evc'
import { PYTH_ABI } from '~/abis/pyth'
import { EoaExecutionAdapter, type EoaAdapterClient } from '~/features/reviewed-execution/adapters/eoa'
import { SafeExecutionAdapter, type SafeAdapterClient } from '~/features/reviewed-execution/adapters/safe'
import type { ExecutionTransportAdapter } from '~/features/reviewed-execution/adapters/types'
import { ReviewedExecutionCoordinator, type CoordinatorDependencies } from '~/features/reviewed-execution/coordinator/coordinator'
import type { ReviewedExecution } from '~/features/reviewed-execution/domain/reviewed-execution'
import { finalizeReviewedRequestSet } from '~/features/reviewed-execution/materialization/finalize'
import { verifyRefreshedPluginPlan } from '~/features/reviewed-execution/materialization/pyth-refresh'
import { artifactFor, getFixturePluginPlans, makePythReviewedExecution, makeReviewedExecution, materializedExecutorFor, TEST_ACCOUNT, TEST_EVC, TEST_TOKEN } from './fixtures'

const hashFor = (value: number) => `0x${value.toString(16).padStart(64, '0')}` as Hash
const HASH = hashFor(1)
const MIGRATION_AUTHORIZATION = hashFor(101)

interface TestEoaClient extends EoaAdapterClient {
  waitForTransactionReceipt(hash: Hash): Promise<Pick<TransactionReceipt, 'transactionHash' | 'status'>>
}

const makeClient = (_execution: ReviewedExecution, overrides: Partial<TestEoaClient> = {}): TestEoaClient => ({
  sendTransaction: async () => HASH,
  waitForTransactionReceipt: async hash => ({ transactionHash: hash, status: 'success' }),
  ...overrides,
})

const unusedSafeAdapter: ExecutionTransportAdapter = {
  transport: 'safe',
  dispatch: async () => { throw new Error('not used') },
}

const safeAdapterFor = (
  client: Omit<SafeAdapterClient, 'reserveSubmission' | 'recordCallsId' | 'clearSubmission'>,
) => new SafeExecutionAdapter({
  reserveSubmission: async () => 'test-reservation',
  recordCallsId: async () => {},
  clearSubmission: async () => {},
  ...client,
})

const setup = ({
  execution = makeReviewedExecution(),
  client,
  eoaAdapter,
  safeAdapter = unusedSafeAdapter,
  readWalletBinding,
  revalidatePolicy,
  initializationBarrier,
  refreshPyth,
  finalize,
  now,
}: {
  execution?: ReviewedExecution
  client?: TestEoaClient
  eoaAdapter?: ExecutionTransportAdapter
  safeAdapter?: ExecutionTransportAdapter
  readWalletBinding?: () => Promise<ReviewedExecution['requestSet']['wallet']>
  revalidatePolicy?: () => Promise<void>
  initializationBarrier?: Promise<void>
  refreshPyth?: CoordinatorDependencies['refreshPyth']
  finalize?: CoordinatorDependencies['finalize']
  now?: () => number
} = {}) => {
  const actualClient = client ?? makeClient(execution)
  const dependencies: CoordinatorDependencies = {
    adapters: {
      eoa: eoaAdapter ?? new EoaExecutionAdapter(actualClient, materializedExecutorFor(actualClient.waitForTransactionReceipt), TEST_EVC),
      safe: safeAdapter,
    },
    readWalletBinding: readWalletBinding ?? (async () => execution.requestSet.wallet),
    revalidatePolicy: revalidatePolicy ?? (async () => {}),
    collectSignature: async () => '0x01',
    refreshPyth: refreshPyth ?? (async () => []),
    finalize: finalize ?? (current => artifactFor(current)),
    now: now ?? (() => 100),
  }
  const initializeDependencies = initializationBarrier
    ? vi.fn(() => initializationBarrier.then(() => dependencies))
    : undefined
  const coordinator = new ReviewedExecutionCoordinator(initializeDependencies ?? dependencies)
  return { execution, coordinator, client: actualClient, initializeDependencies }
}

const execute = (coordinator: ReviewedExecutionCoordinator, execution: ReviewedExecution) =>
  coordinator.execute(execution, { reviewId: execution.reviewId, reviewDigest: execution.reviewDigest })

const migrationExecution = (includeGrant = true) => {
  const owner = { intentId: 'intent-1', intentRevision: 1 }
  return makeReviewedExecution('eoa', {
    before: includeGrant
      ? [{
          phase: 'prerequisite',
          authorizationId: MIGRATION_AUTHORIZATION,
          owner,
          provenance: { source: 'migration-authorization', mode: 'transaction' },
          chainId: 1,
          to: TEST_TOKEN,
          data: '0x01020304',
        }]
      : [],
    after: [{
      phase: 'cleanup',
      authorizationId: MIGRATION_AUTHORIZATION,
      owner,
      provenance: { source: 'migration-authorization', mode: 'transaction' },
      chainId: 1,
      to: TEST_TOKEN,
      data: '0x05060708',
    }],
  })
}

describe('reviewed execution coordinator', () => {
  it('submits the finalized reviewed request once', async () => {
    const execution = makeReviewedExecution()
    const sendTransaction = vi.fn(async () => HASH)
    const prepared = setup({ execution, client: makeClient(execution, { sendTransaction }) })

    const result = await execute(prepared.coordinator, execution)

    expect(result.status).toBe('submitted')
    expect(result.dispatch?.transactionHashes).toEqual([HASH])
    expect(sendTransaction).toHaveBeenCalledOnce()
  })

  it('does not reject an unchanged reviewed request solely because time elapsed', async () => {
    const execution = makeReviewedExecution()
    const sendTransaction = vi.fn(async () => HASH)
    const prepared = setup({
      execution,
      client: makeClient(execution, { sendTransaction }),
      now: () => execution.validity.createdAt + 24 * 60 * 60_000,
    })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({ status: 'submitted' })
    expect(sendTransaction).toHaveBeenCalledOnce()
  })

  it('rejects an expired operation deadline before wallet handoff', async () => {
    const execution = makeReviewedExecution('eoa', {
      constraints: [
        { kind: 'exact-input', token: TEST_TOKEN, amount: 10n },
        { kind: 'deadline', timestamp: 101 },
      ],
    })
    const sendTransaction = vi.fn(async () => HASH)
    const prepared = setup({
      execution,
      client: makeClient(execution, { sendTransaction }),
      now: () => 102_000,
    })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({
      status: 'failed',
      message: 'A reviewed operation expired',
    })
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('does not hand off a core request when its signature expires during a prerequisite receipt wait', async () => {
    const owner = { intentId: 'intent-1', intentRevision: 1 }
    const execution = makeReviewedExecution('eoa', {
      before: [{
        phase: 'prerequisite',
        authorizationId: MIGRATION_AUTHORIZATION,
        owner,
        provenance: { source: 'migration-authorization', mode: 'transaction' },
        chainId: 1,
        to: TEST_TOKEN,
        data: '0x01020304',
      }],
      signatureValidUntil: 101,
    })
    let nowMs = 100_000
    const sentPhases: string[] = []
    const client = makeClient(execution, {
      sendTransaction: async (request) => {
        sentPhases.push(request.phase)
        return HASH
      },
      waitForTransactionReceipt: async (hash) => {
        nowMs = 102_000
        return { transactionHash: hash, status: 'success' }
      },
    })
    const prepared = setup({ execution, client, now: () => nowMs })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({
      status: 'failed',
      message: 'A reviewed signature request expired',
    })
    expect(sentPhases).toEqual(['prerequisite'])
  })

  it('synchronously rejects duplicate confirmation for the same active review', async () => {
    const execution = makeReviewedExecution()
    let initialize!: () => void
    const initializationBarrier = new Promise<void>((resolve) => {
      initialize = resolve
    })
    let release!: () => void
    let started!: () => void
    const dispatchStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const dispatchReleased = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatch = vi.fn(async () => {
      started()
      await dispatchReleased
      return { transactionHashes: [HASH] }
    })
    const prepared = setup({
      execution,
      eoaAdapter: { transport: 'eoa', dispatch },
      initializationBarrier,
    })

    const first = execute(prepared.coordinator, execution)
    const duplicate = await execute(prepared.coordinator, execution)
    expect(duplicate).toMatchObject({ status: 'failed', message: expect.stringMatching(/already being submitted/) })
    expect(dispatch).not.toHaveBeenCalled()
    expect(prepared.initializeDependencies).toHaveBeenCalledOnce()

    initialize()
    await dispatchStarted
    expect(dispatch).toHaveBeenCalledOnce()

    release()
    await expect(first).resolves.toMatchObject({ status: 'submitted' })
  })

  it('rejects wallet context drift before handoff', async () => {
    const execution = makeReviewedExecution()
    const dispatch = vi.fn(async () => ({ transactionHashes: [HASH] }))
    let reads = 0
    const prepared = setup({
      execution,
      eoaAdapter: { transport: 'eoa', dispatch },
      readWalletBinding: async () => ++reads >= 2
        ? { ...execution.requestSet.wallet, connectorSessionId: 'changed-session' }
        : execution.requestSet.wallet,
    })

    const result = await execute(prepared.coordinator, execution)

    expect(result).toMatchObject({ status: 'failed', message: expect.stringMatching(/Wallet connection.*changed/) })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reports an inconclusive wallet response as unknown and releases the local guard', async () => {
    const execution = makeReviewedExecution()
    const sendTransaction = vi.fn(async () => {
      throw new Error('provider disconnected after approval')
    })
    const prepared = setup({ execution, client: makeClient(execution, { sendTransaction }) })

    const first = await execute(prepared.coordinator, execution)
    const second = await execute(prepared.coordinator, execution)

    expect(first.status).toBe('unknown')
    expect(first.message).toMatch(/status is unknown/i)
    expect(second.status).toBe('unknown')
    expect(sendTransaction).toHaveBeenCalledTimes(2)
  })

  it('allows the same reviewed request to be retried after the first wallet prompt is rejected', async () => {
    const execution = makeReviewedExecution()
    const sendTransaction = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('User rejected'), { code: 4001 }))
      .mockResolvedValueOnce(HASH)
    const prepared = setup({ execution, client: makeClient(execution, { sendTransaction }) })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({
      status: 'rejected',
      canRetry: true,
    })
    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({ status: 'submitted' })
    expect(sendTransaction).toHaveBeenCalledTimes(2)
  })

  it('leaves post-handoff receipt sequencing to the SDK when wallet context later changes', async () => {
    const execution = makeReviewedExecution()
    let handedOff = false
    const client = makeClient(execution, {
      sendTransaction: async () => {
        handedOff = true
        return HASH
      },
    })
    const prepared = setup({
      execution,
      client,
      readWalletBinding: async () => handedOff
        ? { ...execution.requestSet.wallet, connectorSessionId: 'changed-after-handoff' }
        : execution.requestSet.wallet,
    })

    const result = await execute(prepared.coordinator, execution)

    expect(result).toMatchObject({ status: 'submitted', dispatch: { transactionHashes: [HASH] } })
  })

  it('refreshes Pyth only after a delayed prerequisite receipt exceeds the freshness window', async () => {
    const execution = makePythReviewedExecution()
    let nowMs = 100_000
    let sent = 0
    let refreshed = false
    let finalizedCoreData: Hex | undefined
    const events: string[] = []
    const client = makeClient(execution, {
      sendTransaction: async (request) => {
        events.push(`send:${request.phase}`)
        if (request.phase === 'core') finalizedCoreData = request.data
        return hashFor(++sent)
      },
      waitForTransactionReceipt: async (hash) => {
        events.push('receipt:start')
        if (sent === 1) nowMs += 61_000
        events.push('receipt:confirmed')
        return { transactionHash: hash, status: 'success' }
      },
    })
    const refreshPyth = vi.fn(async () => {
      events.push(`refresh:${nowMs}`)
      refreshed = true
      const pluginPlans = getFixturePluginPlans(execution)
      const sealedPreview = pluginPlans.previewPlan as unknown as TransactionPlan
      const raw = pluginPlans.rawPlan as unknown as TransactionPlan
      const sealedBatch = sealedPreview[1]
      if (sealedBatch?.type !== 'evcBatch') throw new Error('Expected reviewed EVC batch')
      const freshPayload = encodeFunctionData({ abi: PYTH_ABI, functionName: 'updatePriceFeeds', args: [['0xaabb']] })
      const refreshedPlan: TransactionPlan = [
        raw[0]!,
        {
          ...sealedBatch,
          items: sealedBatch.items.map((item, index) => index === 0 ? { ...item, data: freshPayload } : item),
        },
      ]
      const slot = execution.requestSet.pythRefreshSlots[0]!
      return verifyRefreshedPluginPlan({
        sealedPreview,
        refreshed: refreshedPlan,
        slots: execution.requestSet.pythRefreshSlots,
        evidence: [{
          planItemIndex: slot.sourcePlanItemIndex,
          batchItemIndex: slot.sourceBatchItemIndex,
          target: slot.target,
          requiredFeedIds: slot.requiredFeedIds,
          publishTimes: [160],
          maxValue: slot.maxValue,
          freshnessPolicy: slot.freshnessPolicy,
        }],
        nowSeconds: Math.floor(nowMs / 1000),
      })
    })
    const finalizationSdk = {
      executionService: {
        encodeBatch: (items: EVCBatchItem[]) => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] }),
        encodePermit2Call: () => { throw new Error('unused') },
      },
    }
    const prepared = setup({
      execution,
      client,
      refreshPyth,
      now: () => nowMs,
      readWalletBinding: async () => {
        if (refreshed) events.push('wallet-check:after-refresh')
        return execution.requestSet.wallet
      },
      revalidatePolicy: async () => {
        if (refreshed) events.push('policy-check:after-refresh')
      },
      finalize: (current, signatures, pythValues) => finalizeReviewedRequestSet({
        reviewId: current.reviewId,
        requestDigest: current.requestDigest,
        requestSet: current.requestSet,
        sdk: finalizationSdk,
        signatures,
        pythValues,
      }),
    })

    const result = await execute(prepared.coordinator, execution)

    expect(result).toMatchObject({ status: 'submitted' })
    expect(refreshPyth).toHaveBeenCalledOnce()
    expect(finalizedCoreData).not.toBe(execution.requestSet.requests[1]?.data)
    expect(events.slice(0, 4)).toEqual([
      'send:prerequisite',
      'receipt:start',
      'receipt:confirmed',
      'refresh:161000',
    ])
    const coreSendIndex = events.indexOf('send:core')
    expect(coreSendIndex).toBeGreaterThan(3)
    expect(events.slice(4, coreSendIndex)).toContain('wallet-check:after-refresh')
    expect(events.slice(4, coreSendIndex)).toContain('policy-check:after-refresh')
    expect(events.slice(coreSendIndex)).toEqual(['send:core', 'receipt:start', 'receipt:confirmed'])
  })

  it('does not hand off any request when wallet context changes during Pyth refresh', async () => {
    const execution = makePythReviewedExecution({ includePrerequisite: false })
    let releaseRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    let walletChanged = false
    const sendTransaction = vi.fn(async () => HASH)
    const prepared = setup({
      execution,
      client: makeClient(execution, { sendTransaction }),
      readWalletBinding: async () => walletChanged
        ? { ...execution.requestSet.wallet, connectorSessionId: 'changed-during-refresh' }
        : execution.requestSet.wallet,
      refreshPyth: async () => {
        markRefreshStarted()
        await refreshReleased
        return []
      },
    })

    const resultPromise = execute(prepared.coordinator, execution)
    await refreshStarted
    walletChanged = true
    releaseRefresh()

    await expect(resultPromise).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/Wallet connection.*changed/),
    })
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('rechecks refreshed Pyth publish times after the final awaited dispatch guard', async () => {
    const execution = makePythReviewedExecution({ includePrerequisite: false })
    const slot = execution.requestSet.pythRefreshSlots[0]!
    let nowMs = 100_000
    let refreshed = false
    const sendTransaction = vi.fn(async () => HASH)
    const prepared = setup({
      execution,
      client: makeClient(execution, { sendTransaction }),
      now: () => nowMs,
      refreshPyth: async () => {
        refreshed = true
        return [{
          slotId: slot.slotId,
          target: slot.target,
          onBehalfOfAccount: TEST_ACCOUNT,
          data: '0x',
          value: 0n,
          payloadHash: hashFor(202),
          publishTimes: [100],
        }]
      },
      revalidatePolicy: async () => {
        if (refreshed) nowMs = 161_000
      },
    })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/Pyth payload expired before wallet handoff/),
    })
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('preserves the Safe status flow through the reviewed adapter', async () => {
    const execution = makeReviewedExecution('safe')
    const callsId = hashFor(2)
    const sendCalls = vi.fn(async () => callsId)
    const safeAdapter = safeAdapterFor({
      assertAtomicCapability: async () => {},
      sendCalls,
      waitForExecution: async () => ({ executionHash: HASH, receiptStatus: 'success', atomic: true }),
    })
    const prepared = setup({ execution, safeAdapter })

    const result = await execute(prepared.coordinator, execution)

    expect(result).toMatchObject({
      status: 'submitted',
      dispatch: { callsId, executionHash: HASH, transactionHashes: [HASH], atomic: true },
    })
    expect(sendCalls).toHaveBeenCalledOnce()
    expect(sendCalls).toHaveBeenCalledWith(execution.requestSet.safeTransport)
  })

  it('reports inconclusive Safe status as unknown without retrying', async () => {
    const execution = makeReviewedExecution('safe')
    const sendCalls = vi.fn(async () => hashFor(2))
    const safeAdapter = safeAdapterFor({
      assertAtomicCapability: async () => {},
      sendCalls,
      waitForExecution: async () => { throw new Error('provider unavailable') },
    })
    const prepared = setup({ execution, safeAdapter })

    const result = await execute(prepared.coordinator, execution)

    expect(result.status).toBe('unknown')
    expect(sendCalls).toHaveBeenCalledOnce()
  })

  it('revalidates Safe atomic capability before wallet handoff', async () => {
    const execution = makeReviewedExecution('safe')
    const sendCalls = vi.fn(async () => hashFor(2))
    const safeAdapter = safeAdapterFor({
      assertAtomicCapability: async () => { throw new Error('Safe wallet atomic execution is unsupported on chain 1') },
      sendCalls,
      waitForExecution: async () => ({ executionHash: HASH, receiptStatus: 'success', atomic: true }),
    })
    const prepared = setup({ execution, safeAdapter })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({ status: 'failed', message: expect.stringMatching(/unsupported/) })
    expect(sendCalls).not.toHaveBeenCalled()
  })

  it('rejects finalized Safe envelope drift before wallet handoff', async () => {
    const execution = makeReviewedExecution('safe')
    const sendCalls = vi.fn(async () => hashFor(2))
    const safeAdapter = safeAdapterFor({
      assertAtomicCapability: async () => {},
      sendCalls,
      waitForExecution: async () => ({ executionHash: HASH, receiptStatus: 'success', atomic: true }),
    })
    const prepared = setup({
      execution,
      safeAdapter,
      finalize: (current) => {
        const artifact = artifactFor(current)
        return { ...artifact, safeTransport: { ...artifact.safeTransport!, chainId: 2 } }
      },
    })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({ status: 'failed', message: expect.stringMatching(/fields changed/) })
    expect(sendCalls).not.toHaveBeenCalled()
  })

  it('does not report success unless Safe confirms atomic execution', async () => {
    const execution = makeReviewedExecution('safe')
    const safeAdapter = safeAdapterFor({
      assertAtomicCapability: async () => {},
      sendCalls: async () => hashFor(2),
      waitForExecution: async () => ({ executionHash: HASH, receiptStatus: 'success', atomic: false }),
    })
    const prepared = setup({ execution, safeAdapter })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({ status: 'failed', message: expect.stringMatching(/not confirmed atomic/) })
  })

  it('reports current-session Safe cancellation as rejected', async () => {
    const execution = makeReviewedExecution('safe')
    const safeAdapter = safeAdapterFor({
      assertAtomicCapability: async () => {},
      sendCalls: async () => hashFor(2),
      waitForExecution: async () => { throw new Error('Safe transaction was cancelled') },
    })
    const prepared = setup({ execution, safeAdapter })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({ status: 'rejected', canRetry: true })
  })

  it('reports a reverted Safe receipt as failed', async () => {
    const execution = makeReviewedExecution('safe')
    const safeAdapter = safeAdapterFor({
      assertAtomicCapability: async () => {},
      sendCalls: async () => hashFor(2),
      waitForExecution: async () => ({ executionHash: HASH, receiptStatus: 'reverted', atomic: true }),
    })
    const prepared = setup({ execution, safeAdapter })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({ status: 'failed' })
  })

  it('preserves a conclusive current-session Safe failure', async () => {
    const execution = makeReviewedExecution('safe')
    const safeAdapter = safeAdapterFor({
      assertAtomicCapability: async () => {},
      sendCalls: async () => hashFor(2),
      waitForExecution: async () => { throw new Error('Safe transaction failed') },
    })
    const prepared = setup({ execution, safeAdapter })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({
      status: 'failed',
      message: 'Safe transaction failed',
    })
  })

  it('reports an atomic Safe migration and revocation as unknown after handoff', async () => {
    const execution = makeReviewedExecution('safe', {
      before: [{
        phase: 'prerequisite',
        authorizationId: MIGRATION_AUTHORIZATION,
        owner: { intentId: 'intent-1', intentRevision: 1 },
        provenance: { source: 'migration-authorization', mode: 'transaction' },
        chainId: 1,
        to: TEST_TOKEN,
        data: '0x01020304',
      }],
      after: [{
        phase: 'cleanup',
        authorizationId: MIGRATION_AUTHORIZATION,
        owner: { intentId: 'intent-1', intentRevision: 1 },
        provenance: { source: 'migration-authorization', mode: 'transaction' },
        chainId: 1,
        to: TEST_TOKEN,
        data: '0x05060708',
      }],
    })
    const sendCalls = vi.fn(async () => hashFor(2))
    const safeAdapter = safeAdapterFor({
      assertAtomicCapability: async () => {},
      sendCalls,
      waitForExecution: async () => { throw new Error('provider unavailable') },
    })
    const prepared = setup({ execution, safeAdapter })

    const result = await execute(prepared.coordinator, execution)

    expect(result).toMatchObject({
      status: 'unknown',
      migration: {
        submission: { status: 'unknown' },
        revocation: { status: 'unknown' },
        authorizationMayRemain: true,
      },
    })
    expect(sendCalls).toHaveBeenCalledOnce()
  })

  it('executes the reviewed migration grant, core, and revocation in order', async () => {
    const execution = migrationExecution()
    let sent = 0
    const client = makeClient(execution, { sendTransaction: async () => hashFor(++sent) })
    const prepared = setup({ execution, client })

    const result = await execute(prepared.coordinator, execution)

    expect(sent).toBe(3)
    expect(result.status).toBe('submitted')
    expect(result.migration).toMatchObject({
      submission: { status: 'submitted' },
      revocation: { status: 'submitted' },
      authorizationMayRemain: false,
    })
  })

  it('restores a confirmed temporary grant after the migration core reverts', async () => {
    const execution = migrationExecution()
    let sent = 0
    const client = makeClient(execution, {
      sendTransaction: async () => hashFor(++sent),
      waitForTransactionReceipt: async hash => ({ transactionHash: hash, status: hash === hashFor(2) ? 'reverted' : 'success' }),
    })
    const prepared = setup({ execution, client })

    const result = await execute(prepared.coordinator, execution)

    expect(sent).toBe(3)
    expect(result.status).toBe('failed')
    expect(result.migration).toMatchObject({
      submission: { status: 'failed' },
      revocation: { status: 'submitted' },
      authorizationMayRemain: false,
    })
    expect(result.migration?.warning).toBeUndefined()
  })

  it('restores a confirmed temporary grant after the migration core is rejected', async () => {
    const execution = migrationExecution()
    const sentPhases: string[] = []
    let sent = 0
    const client = makeClient(execution, {
      sendTransaction: async (request) => {
        sentPhases.push(request.phase)
        if (request.phase === 'core') throw Object.assign(new Error('User rejected'), { code: 4001 })
        return hashFor(++sent)
      },
    })
    const prepared = setup({ execution, client })

    const result = await execute(prepared.coordinator, execution)

    expect(sentPhases).toEqual(['prerequisite', 'core', 'cleanup'])
    expect(result).toMatchObject({
      status: 'rejected',
      migration: {
        submission: { status: 'rejected' },
        revocation: { status: 'submitted' },
        authorizationMayRemain: false,
      },
    })
    expect(result.canRetry).toBeUndefined()
  })

  it('does not risk duplicate cleanup when migration core status is unknown', async () => {
    const execution = migrationExecution()
    const sentPhases: string[] = []
    let sent = 0
    const client = makeClient(execution, {
      sendTransaction: async (request) => {
        sentPhases.push(request.phase)
        if (request.phase === 'core') throw new Error('provider disconnected after approval')
        return hashFor(++sent)
      },
    })
    const prepared = setup({ execution, client })

    const result = await execute(prepared.coordinator, execution)

    expect(sentPhases).toEqual(['prerequisite', 'core'])
    expect(result).toMatchObject({
      status: 'unknown',
      migration: {
        submission: { status: 'unknown' },
        revocation: { status: 'not-submitted' },
        authorizationMayRemain: true,
      },
    })
  })

  it('restores only grants confirmed before a later prerequisite is rejected', async () => {
    const owner = { intentId: 'intent-1', intentRevision: 1 }
    const secondAuthorization = hashFor(102)
    const execution = makeReviewedExecution('eoa', {
      before: [
        {
          phase: 'prerequisite',
          authorizationId: MIGRATION_AUTHORIZATION,
          owner,
          provenance: { source: 'migration-authorization', mode: 'transaction' },
          chainId: 1,
          to: TEST_TOKEN,
          data: '0x01000001',
        },
        {
          phase: 'prerequisite',
          authorizationId: secondAuthorization,
          owner,
          provenance: { source: 'migration-authorization', mode: 'transaction' },
          chainId: 1,
          to: TEST_TOKEN,
          data: '0x01000002',
        },
      ],
      after: [
        {
          phase: 'cleanup',
          authorizationId: MIGRATION_AUTHORIZATION,
          owner,
          provenance: { source: 'migration-authorization', mode: 'transaction' },
          chainId: 1,
          to: TEST_TOKEN,
          data: '0x02000001',
        },
        {
          phase: 'cleanup',
          authorizationId: secondAuthorization,
          owner,
          provenance: { source: 'migration-authorization', mode: 'transaction' },
          chainId: 1,
          to: TEST_TOKEN,
          data: '0x02000002',
        },
      ],
    })
    const sentData: Hex[] = []
    let sent = 0
    const client = makeClient(execution, {
      sendTransaction: async (request) => {
        sentData.push(request.data)
        if (request.data === '0x01000002') throw Object.assign(new Error('User rejected'), { code: 4001 })
        return hashFor(++sent)
      },
    })
    const prepared = setup({ execution, client })

    const result = await execute(prepared.coordinator, execution)

    expect(sentData).toEqual(['0x01000001', '0x01000002', '0x02000001'])
    expect(result).toMatchObject({
      status: 'rejected',
      migration: {
        revocation: { status: 'submitted' },
        authorizationMayRemain: false,
      },
    })
  })

  it('cleans up a pre-existing authorization after the migration core is rejected', async () => {
    const execution = migrationExecution(false)
    const sentPhases: string[] = []
    const sendTransaction = vi.fn(async (request) => {
      sentPhases.push(request.phase)
      if (request.phase === 'core') throw Object.assign(new Error('User rejected'), { code: 4001 })
      return HASH
    })
    const prepared = setup({ execution, client: makeClient(execution, { sendTransaction }) })

    const result = await execute(prepared.coordinator, execution)

    expect(sentPhases).toEqual(['core', 'cleanup'])
    expect(result.status).toBe('rejected')
    expect(result.migration).toMatchObject({
      submission: { status: 'rejected' },
      revocation: { status: 'submitted' },
      authorizationMayRemain: false,
    })
    expect(result.migration?.warning).toBeUndefined()
  })

  it('warns when both a migration and its pre-existing authorization cleanup are rejected', async () => {
    const execution = migrationExecution(false)
    const sentPhases: string[] = []
    const sendTransaction = vi.fn(async (request) => {
      sentPhases.push(request.phase)
      throw Object.assign(new Error('User rejected'), { code: 4001 })
    })
    const prepared = setup({ execution, client: makeClient(execution, { sendTransaction }) })

    const result = await execute(prepared.coordinator, execution)

    expect(sentPhases).toEqual(['core', 'cleanup'])
    expect(result.status).toBe('rejected')
    expect(result.migration).toMatchObject({
      submission: { status: 'rejected' },
      revocation: { status: 'rejected' },
      authorizationMayRemain: true,
    })
    expect(result.migration?.warning).toMatch(/authorization may remain active/i)
  })

  it('preserves a submitted migration when revocation fails', async () => {
    const execution = migrationExecution()
    let sent = 0
    const client = makeClient(execution, {
      sendTransaction: async () => hashFor(++sent),
      waitForTransactionReceipt: async hash => ({ transactionHash: hash, status: hash === hashFor(3) ? 'reverted' : 'success' }),
    })
    const prepared = setup({ execution, client })

    const result = await execute(prepared.coordinator, execution)

    expect(sent).toBe(3)
    expect(result.status).toBe('submitted')
    expect(result.migration).toMatchObject({
      submission: { status: 'submitted' },
      revocation: { status: 'failed' },
      authorizationMayRemain: true,
    })
    expect(result.migration?.warning).toMatch(/Migration submitted.*authorization revocation.*failed/i)
  })
})
