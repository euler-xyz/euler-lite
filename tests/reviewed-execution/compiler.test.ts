import { encodeFunctionData, getAddress, keccak256, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { ExecutionService, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { validateReviewedRequestSet } from '~/features/reviewed-execution/domain/validators'
import { materializePreparedPlan } from '~/features/reviewed-execution/materialization/prepared-plan'
import { IntentCompilerRegistry } from '~/features/reviewed-execution/planning/compiler'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const TOKEN = getAddress('0x2000000000000000000000000000000000000000')
const VAULT = getAddress('0x3000000000000000000000000000000000000000')
const EVC = getAddress('0x4000000000000000000000000000000000000000')
const SUB_ACCOUNT_A = getAddress('0x5000000000000000000000000000000000000000')
const SUB_ACCOUNT_B = getAddress('0x6000000000000000000000000000000000000000')

const intentFor = (intentId: string, subAccount: typeof SUB_ACCOUNT_A | typeof SUB_ACCOUNT_B): OperationIntent => ({
  schemaVersion: 1,
  intentId,
  revision: 1,
  kind: 'deposit',
  chainId: 1,
  account: ACCOUNT,
  subAccounts: [ACCOUNT, subAccount],
  planner: { name: 'deposit', args: { vaultAddress: VAULT, assetAddress: TOKEN, amount: 10n } },
  constraints: [{ kind: 'exact-input', token: TOKEN, amount: 10n }],
  metadata: { createdAt: 1, source: 'test' },
})

const intents = [intentFor('intent-a', SUB_ACCOUNT_A), intentFor('intent-b', SUB_ACCOUNT_B)] as const

const planFor = (amount: bigint, subAccount: typeof SUB_ACCOUNT_A | typeof SUB_ACCOUNT_B, data: `0x${string}`): TransactionPlan => [
  { type: 'requiredApproval', token: TOKEN, owner: ACCOUNT, spender: VAULT, amount },
  { type: 'evcBatch', items: [{ targetContract: VAULT, onBehalfOfAccount: subAccount, value: 0n, data }] },
]

const sourcePlans = new Map<string, TransactionPlan>([
  ['intent-a', planFor(10n, SUB_ACCOUNT_A, '0x11111111')],
  ['intent-b', planFor(20n, SUB_ACCOUNT_B, '0x22222222')],
])

const executionService = new ExecutionService({} as never)
const mergeLikeSdk = (plans: readonly TransactionPlan[]): TransactionPlan => executionService.mergePlans([...plans])

const compile = (mergePlans = mergeLikeSdk) => new IntentCompilerRegistry({
  deposit: {
    compile: async intent => sourcePlans.get(intent.intentId)!,
  },
}, mergePlans).compile(intents, { snapshot: {} as never, runtime: {} }, () => {})

describe('intent compiler merged prerequisite ownership', () => {
  it('preserves repeated same-key approvals when a single intent plan is not merged', async () => {
    const plan: TransactionPlan = [
      { type: 'requiredApproval', token: TOKEN, owner: ACCOUNT, spender: VAULT, amount: 10n },
      { type: 'requiredApproval', token: TOKEN, owner: ACCOUNT, spender: VAULT, amount: 20n },
      { type: 'evcBatch', items: [{ targetContract: VAULT, onBehalfOfAccount: SUB_ACCOUNT_A, value: 0n, data: '0x11111111' }] },
    ]
    const compiled = await new IntentCompilerRegistry({
      deposit: { compile: async () => plan },
    }, () => { throw new Error('single plans must not be merged') }).compile(
      [intents[0]],
      { snapshot: {} as never, runtime: {} },
      () => {},
    )

    expect(compiled.effectOwners['0']).toEqual([{ intentId: 'intent-a', intentRevision: 1 }])
    expect(compiled.effectOwners['1']).toEqual([{ intentId: 'intent-a', intentRevision: 1 }])
  })

  it('accepts an exactly summed approval and retains every contributing intent', async () => {
    const compiled = await compile()

    expect(compiled.effectOwners['0']).toEqual([
      { intentId: 'intent-a', intentRevision: 1 },
      { intentId: 'intent-b', intentRevision: 1 },
    ])
    expect(compiled.effectOwners['1:0']).toEqual([{ intentId: 'intent-a', intentRevision: 1 }])
    expect(compiled.effectOwners['1:1']).toEqual([{ intentId: 'intent-b', intentRevision: 1 }])

    const approvalData = encodeFunctionData({
      abi: [{
        type: 'function',
        name: 'approve',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
        outputs: [{ name: '', type: 'bool' }],
      }],
      functionName: 'approve',
      args: [VAULT, 30n],
    })
    const resolvedPlan = compiled.plan.map(item => item.type === 'requiredApproval'
      ? {
          ...item,
          resolved: [{ type: 'approve' as const, token: TOKEN, owner: ACCOUNT, spender: VAULT, amount: 30n, data: approvalData }],
        }
      : item) as TransactionPlan
    const requestSet = materializePreparedPlan({
      intents,
      plan: resolvedPlan,
      wallet: {
        chainId: 1,
        account: ACCOUNT,
        subAccounts: [ACCOUNT, SUB_ACCOUNT_A, SUB_ACCOUNT_B],
        connectorId: 'injected',
        connectorSessionId: 'session-1',
        walletKind: 'eoa',
        classificationVersion: 'v1',
        approvalMode: 'approve',
      },
      sdk: {
        deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }) },
        executionService: {
          encodeBatch: items => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] }),
        },
      },
      effectOwners: compiled.effectOwners,
      policyDigest: keccak256(toHex('policy')),
    })

    const approval = requestSet.effects.find(effect => effect.effect.kind === 'approval')!
    expect(approval.intentRefs).toEqual(compiled.effectOwners['0'])
    expect(approval.policySubjects).toEqual(expect.arrayContaining([
      { kind: 'account', value: SUB_ACCOUNT_A },
      { kind: 'account', value: SUB_ACCOUNT_B },
    ]))
    expect(() => validateReviewedRequestSet(requestSet, intents)).not.toThrow()
  })

  it('rejects a coalesced approval whose amount is not the exact source sum', async () => {
    await expect(compile(() => [
      { type: 'requiredApproval', token: TOKEN, owner: ACCOUNT, spender: VAULT, amount: 29n },
      { type: 'evcBatch', items: [
        { targetContract: VAULT, onBehalfOfAccount: SUB_ACCOUNT_A, value: 0n, data: '0x11111111' },
        { targetContract: VAULT, onBehalfOfAccount: SUB_ACCOUNT_B, value: 0n, data: '0x22222222' },
      ] },
    ])).rejects.toThrow(/changed a required approval/)
  })
})
