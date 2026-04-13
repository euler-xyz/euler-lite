import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { OPEN_POSITION_PARAMS_COMPONENTS } from '~/abis/cowswap-wrapper'
import { COWSWAP_APPDATA_VERSION } from './constants'
import type { CowSwapOpenPositionParams, CowSwapOrderPayload } from './types'

const COW_ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const

// Encode wrapperData as abi.encode(OpenPositionParams, bytes) — matching the
// contract's abi.decode(wrapperData, (OpenPositionParams, bytes)) in _wrap().
const WRAPPER_DATA_ABI = [
  {
    type: 'tuple',
    components: OPEN_POSITION_PARAMS_COMPONENTS,
  },
  { type: 'bytes' },
] as const

export const buildCowSwapWrapperData = (
  params: CowSwapOpenPositionParams,
  permitSignature: Hex,
): Hex => encodeAbiParameters(WRAPPER_DATA_ABI, [
  {
    owner: params.owner,
    account: params.account,
    deadline: BigInt(params.deadline),
    collateralVault: params.collateralVault,
    borrowVault: params.borrowVault,
    collateralAmount: params.collateralAmount,
    borrowAmount: params.borrowAmount,
  },
  permitSignature,
])

export const buildCowSwapAppData = (
  wrapperData: Hex,
  wrapperAddress: Address,
): { appDataString: string, appDataHash: Hex } => {
  const appData = {
    appCode: 'euler_position_open',
    version: COWSWAP_APPDATA_VERSION,
    metadata: {
      wrappers: [
        {
          address: wrapperAddress,
          data: wrapperData,
          isOmittable: false,
        },
      ],
    },
  }

  const appDataString = JSON.stringify(appData)
  const appDataHash = keccak256(toHex(appDataString))

  return { appDataString, appDataHash }
}

export type CowSwapOrderTypedDataParams = {
  chainId: number
  settlementContract: Address
  sellToken: Address
  buyToken: Address
  receiver: Address
  sellAmount: bigint
  buyAmount: bigint
  validTo: number
  appDataHash: Hex
}

export const buildCowSwapOrderTypedData = (params: CowSwapOrderTypedDataParams) => {
  const domain = {
    name: 'Gnosis Protocol',
    version: 'v2',
    chainId: BigInt(params.chainId),
    verifyingContract: getAddress(params.settlementContract),
  }

  const message = {
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    receiver: params.receiver,
    sellAmount: params.sellAmount,
    buyAmount: params.buyAmount,
    validTo: params.validTo,
    appData: params.appDataHash,
    feeAmount: 0n,
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  } as const

  return {
    domain,
    types: COW_ORDER_TYPES,
    primaryType: 'Order' as const,
    message,
  }
}

export const buildCowSwapOrderPayload = (
  typedData: ReturnType<typeof buildCowSwapOrderTypedData>,
  signature: string,
  owner: Address,
  appDataString: string,
  appDataHash: Hex,
): CowSwapOrderPayload => {
  const { message } = typedData

  return {
    sellToken: message.sellToken,
    buyToken: message.buyToken,
    from: owner,
    receiver: message.receiver,
    sellAmount: message.sellAmount.toString(),
    buyAmount: message.buyAmount.toString(),
    feeAmount: message.feeAmount.toString(),
    kind: message.kind,
    partiallyFillable: message.partiallyFillable,
    validTo: message.validTo,
    sellTokenBalance: message.sellTokenBalance,
    buyTokenBalance: message.buyTokenBalance,
    signature,
    signingScheme: 'eip712',
    onchainOrder: false,
    appData: appDataString,
    appDataHash,
  }
}
