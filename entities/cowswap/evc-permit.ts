import type { Address, Hex } from 'viem'

const EVC_PERMIT_TYPES = {
  Permit: [
    { name: 'signer', type: 'address' },
    { name: 'sender', type: 'address' },
    { name: 'nonceNamespace', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
} as const

export const computeNonceNamespace = (sender: Address): bigint =>
  BigInt(sender)

export type EvcPermitParams = {
  chainId: number
  evcAddress: Address
  signer: Address
  sender: Address
  nonceNamespace: bigint
  nonce: bigint
  deadline: number
  value?: bigint
  data: Hex
}

export const buildEvcPermitTypedData = (params: EvcPermitParams) => {
  const domain = {
    name: 'Ethereum Vault Connector',
    chainId: BigInt(params.chainId),
    verifyingContract: params.evcAddress,
  }

  const message = {
    signer: params.signer,
    sender: params.sender,
    nonceNamespace: params.nonceNamespace,
    nonce: params.nonce,
    deadline: BigInt(params.deadline),
    value: params.value ?? 0n,
    data: params.data,
  }

  return {
    domain,
    types: EVC_PERMIT_TYPES,
    primaryType: 'Permit' as const,
    message,
  }
}
