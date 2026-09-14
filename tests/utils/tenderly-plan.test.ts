import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, getAddress, keccak256, toHex } from 'viem'
import type { EVCBatchItem, EulerSDK, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import type { EoaRequest, SignatureSlot } from '~/features/reviewed-execution/domain/reviewed-execution'
import { buildTenderlySimulationPayload, tenderlyPayloadMatchesReviewedRequests } from '~/utils/tenderly-plan'

const owner = '0x1000000000000000000000000000000000000000'
const distributor = '0x2000000000000000000000000000000000000000'
const token = '0x3000000000000000000000000000000000000000'
const evc = '0x4000000000000000000000000000000000000000'

const claimAbi = [
  {
    type: 'function',
    name: 'claim',
    inputs: [
      { name: 'users', type: 'address[]' },
      { name: 'tokens', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'proofs', type: 'bytes32[][]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

const sdk = {
  deploymentService: {
    getDeployment: vi.fn(),
  },
  executionService: {
    encodeBatch: vi.fn(),
    deriveStateOverrides: vi.fn(),
  },
} as unknown as EulerSDK

describe('buildTenderlySimulationPayload', () => {
  it('builds a Tenderly payload for a single Merkl-style contract call', async () => {
    const plan: TransactionPlan = [{
      type: 'contractCall',
      chainId: 1,
      to: distributor,
      abi: claimAbi,
      functionName: 'claim',
      args: [[owner], [token], [100n], [[]]],
      value: 0n,
    }]

    const payload = await buildTenderlySimulationPayload({
      plan,
      owner,
      sdk,
    })

    expect(payload).toEqual({
      chainId: 1,
      from: owner,
      to: distributor,
      data: encodeFunctionData({
        abi: claimAbi,
        functionName: 'claim',
        args: [[owner], [token], [100n], [[]]],
      }),
      value: '0',
      stateOverrides: [],
    })
  })

  it('returns undefined for ambiguous direct-call plans', async () => {
    const plan: TransactionPlan = [
      {
        type: 'contractCall',
        chainId: 1,
        to: distributor,
        abi: claimAbi,
        functionName: 'claim',
        args: [[owner], [token], [100n], [[]]],
        value: 0n,
      },
      {
        type: 'contractCall',
        chainId: 1,
        to: distributor,
        abi: claimAbi,
        functionName: 'claim',
        args: [[owner], [token], [100n], [[]]],
        value: 0n,
      },
    ]

    await expect(buildTenderlySimulationPayload({ plan, owner, sdk })).resolves.toBeUndefined()
  })

  it('matches a Permit2 simulation after removing only its reviewed signature slot', async () => {
    const permitItem: EVCBatchItem = {
      targetContract: getAddress(token),
      onBehalfOfAccount: getAddress(owner),
      value: 0n,
      data: '0x12345678',
    }
    const coreItem: EVCBatchItem = {
      targetContract: getAddress(distributor),
      onBehalfOfAccount: getAddress(owner),
      value: 0n,
      data: '0x87654321',
    }
    const encodeBatch = (items: EVCBatchItem[]) => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] })
    const evcSdk = {
      deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc } } }) },
      executionService: {
        encodeBatch,
        deriveStateOverrides: vi.fn(async () => []),
      },
    } as unknown as EulerSDK
    const plan = [
      { type: 'requiredApproval', resolved: [{ type: 'permit2' }] },
      { type: 'evcBatch', items: [coreItem] },
    ] as unknown as TransactionPlan
    const payload = await buildTenderlySimulationPayload({ plan, owner, chainId: 1, sdk: evcSdk })
    expect(payload).toBeDefined()

    const requestId = keccak256(toHex('request'))
    const effectId = keccak256(toHex('effect'))
    const request: EoaRequest = {
      requestId,
      effectIds: [effectId],
      phase: 'core',
      chainId: 1,
      from: getAddress(owner),
      to: getAddress(evc),
      data: encodeBatch([permitItem, coreItem]),
      value: 0n,
    }
    const signatureSlot = {
      slotId: keccak256(toHex('slot')),
      kind: 'permit2',
      signer: getAddress(owner),
      chainId: 1,
      typedData: {},
      typedDataHash: keccak256(toHex('typed-data')),
      nonce: 1n,
      insertionPoints: [{ requestId, effectId, batchItemIndex: 0, abiArgumentPath: ['signature'] }],
    } as SignatureSlot

    expect(tenderlyPayloadMatchesReviewedRequests({
      payload: payload!,
      requests: [request],
      signatureSlots: [signatureSlot],
      sdk: evcSdk,
    })).toBe(true)
    expect(tenderlyPayloadMatchesReviewedRequests({
      payload: payload!,
      requests: [request],
      signatureSlots: [],
      sdk: evcSdk,
    })).toBe(false)
    expect(tenderlyPayloadMatchesReviewedRequests({
      payload: payload!,
      requests: [{ ...request, value: 1n }],
      signatureSlots: [signatureSlot],
      sdk: evcSdk,
    })).toBe(false)
  })

  it('matches a migration simulation after removing only its reviewed authorization slots', async () => {
    const grantItem: EVCBatchItem = {
      targetContract: getAddress(token),
      onBehalfOfAccount: getAddress(owner),
      value: 0n,
      data: '0x11111111',
    }
    const coreItem: EVCBatchItem = {
      targetContract: getAddress(distributor),
      onBehalfOfAccount: getAddress(owner),
      value: 0n,
      data: '0x22222222',
    }
    const revokeItem: EVCBatchItem = {
      targetContract: getAddress(token),
      onBehalfOfAccount: getAddress(owner),
      value: 0n,
      data: '0x33333333',
    }
    const encodeBatch = (items: EVCBatchItem[]) => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] })
    const evcSdk = {
      deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc } } }) },
      executionService: {
        encodeBatch,
        deriveStateOverrides: vi.fn(async () => []),
      },
    } as unknown as EulerSDK
    const plan = [{ type: 'evcBatch', items: [coreItem] }] as unknown as TransactionPlan
    const payload = await buildTenderlySimulationPayload({ plan, owner, chainId: 1, sdk: evcSdk })
    expect(payload).toBeDefined()

    const requestId = keccak256(toHex('migration-request'))
    const effectId = keccak256(toHex('migration-effect'))
    const request: EoaRequest = {
      requestId,
      effectIds: [effectId],
      phase: 'core',
      chainId: 1,
      from: getAddress(owner),
      to: getAddress(evc),
      data: encodeBatch([grantItem, coreItem, revokeItem]),
      value: 0n,
    }
    const slotAt = (batchItemIndex: number, suffix: string): SignatureSlot => ({
      slotId: keccak256(toHex(`migration-slot-${suffix}`)),
      kind: 'migration',
      signer: getAddress(owner),
      chainId: 1,
      typedData: {},
      typedDataHash: keccak256(toHex(`migration-typed-data-${suffix}`)),
      insertionPoints: [{ requestId, effectId, batchItemIndex, abiArgumentPath: ['signature'] }],
    })
    const signatureSlots = [slotAt(0, 'grant'), slotAt(2, 'revoke')]

    expect(tenderlyPayloadMatchesReviewedRequests({
      payload: payload!,
      requests: [request],
      signatureSlots,
      sdk: evcSdk,
    })).toBe(true)
    expect(tenderlyPayloadMatchesReviewedRequests({
      payload: payload!,
      requests: [request],
      signatureSlots: signatureSlots.slice(0, 1),
      sdk: evcSdk,
    })).toBe(false)
  })
})
