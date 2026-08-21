import { encodeFunctionData, type Hash, type Hex, type TransactionReceipt } from 'viem'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it, vi } from 'vitest'
import { EVC_ABI } from '~/abis/evc'
import { PYTH_ABI } from '~/abis/pyth'
import { EoaExecutionAdapter, type EoaAdapterClient } from '~/features/reviewed-execution/adapters/eoa'
import { SafeExecutionAdapter } from '~/features/reviewed-execution/adapters/safe'
import type { ExecutionTransportAdapter } from '~/features/reviewed-execution/adapters/types'
import { ReviewedExecutionCoordinator, type CoordinatorDependencies } from '~/features/reviewed-execution/coordinator/coordinator'
import type { ReviewedExecution } from '~/features/reviewed-execution/domain/reviewed-execution'
import { finalizeReviewedRequestSet } from '~/features/reviewed-execution/materialization/finalize'
import { verifyRefreshedPluginPlan } from '~/features/reviewed-execution/materialization/pyth-refresh'
import { artifactFor, makePythReviewedExecution, makeReviewedExecution, materializedExecutorFor, TEST_EVC, TEST_TOKEN } from './fixtures'

const hashFor = (value: number) => `0x${value.toString(16).padStart(64, '0')}` as Hash
const HASH = hashFor(1)

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
          owner,
          provenance: { source: 'migration-authorization', mode: 'transaction' },
          chainId: 1,
          to: TEST_TOKEN,
          data: '0x01020304',
        }]
      : [],
    after: [{
      phase: 'cleanup',
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
      const sealedPreview = execution.pluginSnapshot.previewPlan as unknown as TransactionPlan
      const raw = execution.pluginSnapshot.rawPlan as unknown as TransactionPlan
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
    expect(events).toEqual([
      'send:prerequisite',
      'receipt:start',
      'receipt:confirmed',
      'refresh:161000',
      'send:core',
      'receipt:start',
      'receipt:confirmed',
    ])
  })

  it('preserves the established current-session Safe status flow without durable recovery', async () => {
    const execution = makeReviewedExecution('safe')
    const callsId = hashFor(2)
    const sendCalls = vi.fn(async () => callsId)
    const safeAdapter = new SafeExecutionAdapter({
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
    const safeAdapter = new SafeExecutionAdapter({
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
    const safeAdapter = new SafeExecutionAdapter({
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
    const safeAdapter = new SafeExecutionAdapter({
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
    const safeAdapter = new SafeExecutionAdapter({
      assertAtomicCapability: async () => {},
      sendCalls: async () => hashFor(2),
      waitForExecution: async () => ({ executionHash: HASH, receiptStatus: 'success', atomic: false }),
    })
    const prepared = setup({ execution, safeAdapter })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({ status: 'failed', message: expect.stringMatching(/not confirmed atomic/) })
  })

  it('reports current-session Safe cancellation as rejected', async () => {
    const execution = makeReviewedExecution('safe')
    const safeAdapter = new SafeExecutionAdapter({
      assertAtomicCapability: async () => {},
      sendCalls: async () => hashFor(2),
      waitForExecution: async () => { throw new Error('Safe transaction was cancelled') },
    })
    const prepared = setup({ execution, safeAdapter })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({ status: 'rejected' })
  })

  it('reports a reverted Safe receipt as failed', async () => {
    const execution = makeReviewedExecution('safe')
    const safeAdapter = new SafeExecutionAdapter({
      assertAtomicCapability: async () => {},
      sendCalls: async () => hashFor(2),
      waitForExecution: async () => ({ executionHash: HASH, receiptStatus: 'reverted', atomic: true }),
    })
    const prepared = setup({ execution, safeAdapter })

    await expect(execute(prepared.coordinator, execution)).resolves.toMatchObject({ status: 'failed' })
  })

  it('preserves a conclusive current-session Safe failure', async () => {
    const execution = makeReviewedExecution('safe')
    const safeAdapter = new SafeExecutionAdapter({
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
        owner: { intentId: 'intent-1', intentRevision: 1 },
        provenance: { source: 'migration-authorization', mode: 'transaction' },
        chainId: 1,
        to: TEST_TOKEN,
        data: '0x01020304',
      }],
      after: [{
        phase: 'cleanup',
        owner: { intentId: 'intent-1', intentRevision: 1 },
        provenance: { source: 'migration-authorization', mode: 'transaction' },
        chainId: 1,
        to: TEST_TOKEN,
        data: '0x05060708',
      }],
    })
    const sendCalls = vi.fn(async () => hashFor(2))
    const safeAdapter = new SafeExecutionAdapter({
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

  it('stops after a failed migration core and does not synthesize cleanup', async () => {
    const execution = migrationExecution()
    let sent = 0
    const client = makeClient(execution, {
      sendTransaction: async () => hashFor(++sent),
      waitForTransactionReceipt: async hash => ({ transactionHash: hash, status: hash === hashFor(2) ? 'reverted' : 'success' }),
    })
    const prepared = setup({ execution, client })

    const result = await execute(prepared.coordinator, execution)

    expect(sent).toBe(2)
    expect(result.status).toBe('failed')
    expect(result.migration).toMatchObject({
      submission: { status: 'failed' },
      revocation: { status: 'not-submitted' },
      authorizationMayRemain: true,
    })
    expect(result.migration?.warning).toMatch(/authorization may remain active/i)
  })

  it('warns when a rejected fresh migration leaves a pre-existing authorization active', async () => {
    const execution = migrationExecution(false)
    const sendTransaction = vi.fn(async () => {
      throw Object.assign(new Error('User rejected'), { code: 4001 })
    })
    const prepared = setup({ execution, client: makeClient(execution, { sendTransaction }) })

    const result = await execute(prepared.coordinator, execution)

    expect(result.status).toBe('rejected')
    expect(result.migration).toMatchObject({
      submission: { status: 'rejected' },
      revocation: { status: 'not-submitted' },
      authorizationMayRemain: true,
    })
    expect(result.migration?.warning).toMatch(/authorization may remain active/i)
    expect(sendTransaction).toHaveBeenCalledOnce()
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
