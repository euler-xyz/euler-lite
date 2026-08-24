import { erc20Abi, getAddress } from 'viem'
import type { Account, IHasVaultAddress, MigrationAuthorizationRequest, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it, vi } from 'vitest'
import { canonicalDigest, toCanonicalValue } from '~/features/reviewed-execution/domain/canonical'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { buildMigrationSimulationPlan, compileCrossProtocolMigrationIntent, type MigrationCompilationCollectors, type MigrationCompilerSdk } from '~/features/reviewed-execution/planning/migration-compiler'

const OWNER = getAddress('0x1000000000000000000000000000000000000000')
const TOKEN = getAddress('0x2000000000000000000000000000000000000000')
const SPENDER = getAddress('0x3000000000000000000000000000000000000000')
const previewPlan = [{ type: 'evcBatch', items: [] }] as unknown as TransactionPlan
const simulationPlan = [{ type: 'evcBatch', items: [{ targetContract: TOKEN, onBehalfOfAccount: OWNER, value: 0n, data: '0x12345678' }] }] as unknown as TransactionPlan
const account = { owner: OWNER, chainId: 1 } as Account<IHasVaultAddress>

const transactionRequest = {
  kind: 'transaction',
  connectorId: 'aave',
  protocol: 'Aave V3',
  chainId: 1,
  owner: OWNER,
  call: { to: TOKEN, abi: erc20Abi, functionName: 'approve', args: [SPENDER, 100n] },
  revocation: { to: TOKEN, abi: erc20Abi, functionName: 'approve', args: [SPENDER, 0n] },
} as unknown as MigrationAuthorizationRequest

const typedRequest = {
  kind: 'typedData',
  connectorId: 'morpho',
  protocol: 'Morpho',
  chainId: 1,
  owner: OWNER,
  typedData: {
    domain: { name: 'Morpho', chainId: 1, verifyingContract: SPENDER },
    types: { Authorization: [{ name: 'owner', type: 'address' }] },
    primaryType: 'Authorization',
    message: { owner: OWNER, deadline: 2_000_000_000n },
  },
} as unknown as MigrationAuthorizationRequest

const intentFor = (request?: MigrationAuthorizationRequest): OperationIntent => ({
  schemaVersion: 1,
  intentId: 'migration:1',
  revision: 1,
  kind: 'migration',
  chainId: 1,
  account: OWNER,
  subAccounts: [OWNER],
  planner: {
    name: 'cross-protocol-migration',
    args: {
      direction: 'external-to-euler',
      connectorId: 'aave',
      owner: OWNER,
      positionRef: 'position-1',
      authorizationEvidenceDigest: canonicalDigest('migration-authorization-evidence-v1', toCanonicalValue(request ?? null)),
    },
  },
  constraints: [{ kind: 'deadline', timestamp: 2_000_000_000 }],
  metadata: { createdAt: 1, source: 'test' },
})

const collectors = (): MigrationCompilationCollectors => ({
  migrationSlots: [],
  before: [],
  after: [],
  stateOverrides: [],
  plansForSimulation: new Map(),
})

const sdkFor = (
  request?: MigrationAuthorizationRequest,
  prepareMigrationAuthorizationSlots?: NonNullable<MigrationCompilerSdk['positionMigrationService']['prepareMigrationAuthorizationSlots']>,
): MigrationCompilerSdk => ({
  positionMigrationService: {
    planMigrationSimulation: vi.fn(async () => ({
      plan: simulationPlan,
      previewPlan,
      authorizationRequest: request,
      stateOverrides: [{ address: TOKEN, stateDiff: [] }],
    } as never)),
    ...(prepareMigrationAuthorizationSlots ? { prepareMigrationAuthorizationSlots } : {}),
  },
})

describe('cross-protocol migration compiler', () => {
  it('replaces only the migration plan when building the direct simulation input', () => {
    const depositPlan = [{ type: 'evcBatch', items: [{ data: '0xdeposit' }] }] as unknown as TransactionPlan
    const reviewedMigrationPlan = [{ type: 'evcBatch', items: [{ data: '0xstub' }] }] as unknown as TransactionPlan
    const migrationSimulationPlan = [{ type: 'evcBatch', items: [{ data: '0xcore' }] }] as unknown as TransactionPlan
    const mergePlans = vi.fn((plans: TransactionPlan[]) => plans.flat() as TransactionPlan)

    const result = buildMigrationSimulationPlan([
      { intentId: 'deposit:1', intentRevision: 1, plan: depositPlan },
      { intentId: 'migration:1', intentRevision: 1, plan: reviewedMigrationPlan },
    ], new Map([['migration:1:1', migrationSimulationPlan]]), mergePlans)

    expect(mergePlans).toHaveBeenCalledWith([depositPlan, migrationSimulationPlan])
    expect(result).not.toContain(reviewedMigrationPlan[0])
  })

  it('materializes transaction grants and reverse-order cleanup explicitly', async () => {
    const nested = { ...transactionRequest, postMigrationAuthorization: transactionRequest } as MigrationAuthorizationRequest
    const output = collectors()

    await expect(compileCrossProtocolMigrationIntent({ intent: intentFor(nested), account, sdk: sdkFor(nested), collectors: output }))
      .resolves.toBe(simulationPlan)

    expect(output.before).toHaveLength(2)
    expect(output.after).toHaveLength(2)
    expect(output.before.every(call => call.phase === 'prerequisite')).toBe(true)
    expect(output.after.every(call => call.phase === 'cleanup')).toBe(true)
    expect(output.after.map(call => call.authorizationId)).toEqual(output.before.map(call => call.authorizationId).reverse())
    expect(output.stateOverrides).toEqual([{ address: TOKEN, stateDiff: [] }])
    expect(output.plansForSimulation.get('migration:1:1')).toBe(simulationPlan)
    expect(output.migrationSlots).toEqual([])
  })

  it('uses only the SDK-provided ABI-aware coordinate for typed authorization', async () => {
    const output = collectors()
    const prepareSlots = vi.fn(() => [{
      authorizationRequestIndex: 0,
      planItemIndex: 0,
      batchItemIndex: 2,
      abiArgumentPath: ['authorization', 'signature'],
    }])

    const compiled = await compileCrossProtocolMigrationIntent({
      intent: intentFor(typedRequest),
      account,
      sdk: sdkFor(typedRequest, prepareSlots),
      collectors: output,
    })

    expect(compiled).toBe(previewPlan)
    expect(output.plansForSimulation.get('migration:1:1')).toBe(simulationPlan)
    expect(prepareSlots).toHaveBeenCalledWith({ previewPlan, authorizationRequest: typedRequest })
    expect(output.migrationSlots).toHaveLength(1)
    expect(output.migrationSlots[0]).toMatchObject({
      planItemIndex: 0,
      batchItemIndex: 2,
      signer: OWNER,
      chainId: 1,
      validUntil: 2_000_000_000,
      abiArgumentPath: ['authorization', 'signature'],
    })
  })

  it('accepts a fresh existing-authorization result that contains only the normal revocation', async () => {
    const enableRequest = typedRequest as Extract<MigrationAuthorizationRequest, { kind: 'typedData' }>
    const disableRequest = {
      ...enableRequest,
      typedData: {
        ...enableRequest.typedData,
        message: { ...enableRequest.typedData.message, isAuthorized: false },
      },
    } as MigrationAuthorizationRequest
    const output = collectors()

    await compileCrossProtocolMigrationIntent({
      intent: intentFor(disableRequest),
      account,
      sdk: sdkFor(disableRequest, () => [{
        authorizationRequestIndex: 0,
        planItemIndex: 0,
        batchItemIndex: 1,
        abiArgumentPath: ['authorization', 'signature'],
      }]),
      collectors: output,
    })

    expect(output.before).toEqual([])
    expect(output.after).toEqual([])
    expect(output.migrationSlots).toHaveLength(1)
    expect(output.migrationSlots[0]?.typedData.message).toMatchObject({ isAuthorized: false })
  })

  it('fails closed when authorization evidence drifts', async () => {
    await expect(compileCrossProtocolMigrationIntent({
      intent: intentFor(undefined),
      account,
      sdk: sdkFor(transactionRequest),
      collectors: collectors(),
    })).rejects.toThrow('authorization requirements changed')
  })

  it('adopts an exact warmed compilation without invoking the SDK planner', async () => {
    const planMigrationSimulation = vi.fn(async () => {
      throw new Error('must not run')
    })
    const warmedResult = { plan: simulationPlan, previewPlan, stateOverrides: [] }
    const sdk: MigrationCompilerSdk = { positionMigrationService: { planMigrationSimulation } }

    await expect(compileCrossProtocolMigrationIntent({
      intent: intentFor(), account, sdk, collectors: collectors(), warmedResult,
    })).resolves.toBe(previewPlan)
    expect(planMigrationSimulation).not.toHaveBeenCalled()
  })

  it('fails closed when the SDK slot prerequisite is unavailable or ambiguous', async () => {
    await expect(compileCrossProtocolMigrationIntent({
      intent: intentFor(typedRequest), account, sdk: sdkFor(typedRequest), collectors: collectors(),
    })).rejects.toThrow('slot builder is unavailable')

    await expect(compileCrossProtocolMigrationIntent({
      intent: intentFor(typedRequest),
      account,
      sdk: sdkFor(typedRequest, () => []),
      collectors: collectors(),
    })).rejects.toThrow('incomplete or ambiguous')
  })
})
