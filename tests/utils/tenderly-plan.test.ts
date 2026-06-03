import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionData } from 'viem'
import type { EulerSDK, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { buildTenderlySimulationPayload } from '~/utils/tenderly-plan'

const owner = '0x1000000000000000000000000000000000000000'
const distributor = '0x2000000000000000000000000000000000000000'
const token = '0x3000000000000000000000000000000000000000'

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
})
