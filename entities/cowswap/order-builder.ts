import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { OPEN_POSITION_PARAMS_COMPONENTS, COLLATERAL_SWAP_PARAMS_COMPONENTS, CLOSE_POSITION_PARAMS_COMPONENTS } from '~/abis/cowswap-wrapper'
import { COWSWAP_APPDATA_VERSION } from './constants'
import type { CowSwapOpenPositionParams, CowSwapCollateralSwapParams, CowSwapClosePositionParams, CowSwapOrderPayload, CowSwapOrderSigningScheme } from './types'

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

export const buildOpenPositionWrapperData = (
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

// --- Collateral Swap ---

const COLLATERAL_SWAP_WRAPPER_DATA_ABI = [
  { type: 'tuple', components: COLLATERAL_SWAP_PARAMS_COMPONENTS },
  { type: 'bytes' },
] as const

export const buildCollateralSwapWrapperData = (
  params: CowSwapCollateralSwapParams,
  permitSignature: Hex,
): Hex => encodeAbiParameters(COLLATERAL_SWAP_WRAPPER_DATA_ABI, [
  {
    owner: params.owner,
    account: params.account,
    deadline: BigInt(params.deadline),
    fromVault: params.fromVault,
    toVault: params.toVault,
    fromAmount: params.fromAmount,
    disableSourceCollateral: params.disableSourceCollateral,
  },
  permitSignature,
])

// --- Close Position ---

const CLOSE_POSITION_WRAPPER_DATA_ABI = [
  { type: 'tuple', components: CLOSE_POSITION_PARAMS_COMPONENTS },
  { type: 'bytes' },
] as const

export const buildClosePositionWrapperData = (
  params: CowSwapClosePositionParams,
  permitSignature: Hex,
): Hex => encodeAbiParameters(CLOSE_POSITION_WRAPPER_DATA_ABI, [
  {
    owner: params.owner,
    account: params.account,
    deadline: BigInt(params.deadline),
    borrowVault: params.borrowVault,
    collateralVault: params.collateralVault,
    collateralAmount: params.collateralAmount,
  },
  permitSignature,
])

// --- Shared Builders ---

export const buildCowSwapAppData = (
  wrapperData: Hex,
  wrapperAddress: Address,
  appCode = 'euler_position_open',
): { appDataString: string, appDataHash: Hex } => {
  const appData = {
    appCode,
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
  kind?: 'sell' | 'buy'
  domainName?: string
  domainVersion?: string
  verifyingContract?: Address
}

export const buildCowSwapOrderTypedData = (params: CowSwapOrderTypedDataParams) => {
  const domain = {
    name: params.domainName ?? 'Gnosis Protocol',
    version: params.domainVersion ?? 'v2',
    chainId: BigInt(params.chainId),
    verifyingContract: getAddress(params.verifyingContract ?? params.settlementContract),
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
    kind: params.kind ?? 'sell',
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
  from: Address,
  appDataString: string,
  appDataHash: Hex,
  options?: { signingScheme?: CowSwapOrderSigningScheme },
): CowSwapOrderPayload => {
  const { message } = typedData

  return {
    sellToken: message.sellToken,
    buyToken: message.buyToken,
    from,
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
    signingScheme: options?.signingScheme ?? 'eip712',
    onchainOrder: false,
    appData: appDataString,
    appDataHash,
  }
}
