import type { Address, Hex } from 'viem'

export type CowSwapOrderKind = 'sell' | 'buy'

export type CowSwapOrderSigningScheme = 'eip712' | 'eip1271' | 'ethsign' | 'presign'

export type CowSwapTokenBalance = 'erc20' | 'internal' | 'external'

export type CowSwapCompetitionOrderStatusType =
  | 'open'
  | 'scheduled'
  | 'active'
  | 'solved'
  | 'executing'
  | 'traded'
  | 'cancelled'

export type CowSwapLifecycleOrderStatusType =
  | 'presignaturePending'
  | 'open'
  | 'fulfilled'
  | 'cancelled'
  | 'expired'

export type CowSwapOrderStatusType =
  | CowSwapCompetitionOrderStatusType
  | CowSwapLifecycleOrderStatusType
  | 'unknown'

export type CowSwapTerminalOrderStatus =
  | 'traded'
  | 'fulfilled'
  | 'cancelled'
  | 'expired'

export type CowSwapOrderStatus = {
  type: CowSwapOrderStatusType
  competitionType?: CowSwapCompetitionOrderStatusType
  orderType?: CowSwapLifecycleOrderStatusType
  terminal: boolean
}

export type CowSwapOrderUid = string

export type CowSwapExecutionStatus =
  | 'idle'
  | 'approving_collateral'
  | 'fetching_inbox'
  | 'signing_permit'
  | 'signing_order'
  | 'submitting'
  | 'submitted'

export type CowSwapOpenPositionParams = {
  owner: Address
  account: Address
  deadline: number
  collateralVault: Address
  borrowVault: Address
  collateralAmount: bigint
  borrowAmount: bigint
}

export type CowSwapOpenPositionExecuteParams = {
  chainId: number
  sellToken: Address
  buyToken: Address
  sellAmount: bigint
  buyAmount: bigint
  validTo: number
  collateralToken: Address
  wrapper: CowSwapOpenPositionParams
}

// --- Collateral Swap ---

export type CowSwapCollateralSwapParams = {
  owner: Address
  account: Address
  deadline: number
  fromVault: Address
  toVault: Address
  fromAmount: bigint
  disableSourceCollateral: boolean
}

export type CowSwapCollateralSwapExecuteParams = {
  chainId: number
  sellToken: Address
  buyToken: Address
  sellAmount: bigint
  buyAmount: bigint
  validTo: number
  wrapper: CowSwapCollateralSwapParams
}

// --- Close Position ---

export type CowSwapClosePositionParams = {
  owner: Address
  account: Address
  deadline: number
  borrowVault: Address
  collateralVault: Address
  collateralAmount: bigint
}

export type CowSwapClosePositionExecuteParams = {
  chainId: number
  sellToken: Address
  buyToken: Address
  sellAmount: bigint
  buyAmount: bigint
  validTo: number
  orderKind: 'buy' | 'sell'
  wrapper: CowSwapClosePositionParams
}

// --- Shared ---

export type CowSwapOrderPayload = {
  sellToken: Address
  buyToken: Address
  from: Address
  receiver: Address
  sellAmount: string
  buyAmount: string
  feeAmount: string
  kind: CowSwapOrderKind
  partiallyFillable: boolean
  validTo: number
  sellTokenBalance: CowSwapTokenBalance
  buyTokenBalance: CowSwapTokenBalance
  signature: string
  signingScheme: CowSwapOrderSigningScheme
  onchainOrder: boolean
  appData: string
  appDataHash: Hex
}
