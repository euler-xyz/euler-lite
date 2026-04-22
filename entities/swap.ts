import type { Address, Hex } from 'viem'

export enum SwapperMode {
  EXACT_IN = 0,
  EXACT_OUT = 1,
  TARGET_DEBT = 2,
}

export enum SwapVerificationType {
  SkimMin = 'skimMin',
  TransferMin = 'transferMin',
  DebtMax = 'debtMax',
}

export interface SwapApiToken {
  address?: Address
  addressInfo?: Address
  chainId: number
  decimals: number
  logoURI: string
  name: string
  symbol: string
  meta?: Record<string, unknown>
}

export interface SwapApiMulticallItem {
  functionName: string
  args: unknown
  data: Hex
}

export interface SwapApiSwapBundle {
  swapperAddress: Address
  swapperData: Hex
  multicallItems: SwapApiMulticallItem[]
}

export interface SwapApiVerify {
  verifierAddress: Address
  verifierData: Hex
  type: SwapVerificationType
  vault: Address
  account: Address
  amount: string
  deadline: number
}

export interface SwapApiRouteItem {
  providerName: string
}

export interface SwapApiProviderData {
  quoteId?: number
}

export interface SwapApiQuote {
  amountIn: string
  amountInMax: string
  amountOut: string
  amountOutMin: string
  accountIn: Address
  accountOut: Address
  vaultIn: Address
  receiver: Address
  tokenIn: SwapApiToken
  tokenOut: SwapApiToken
  slippage: number
  swap: SwapApiSwapBundle
  verify: SwapApiVerify
  route: SwapApiRouteItem[]
  providerData?: SwapApiProviderData
}

export interface SwapApiResponse {
  success?: boolean
  data: SwapApiQuote[]
}

export interface StrategyMatchConfig {
  swapperModes?: SwapperMode[]
  isRepay?: boolean
  isPendlePT?: boolean
  tokensInOrOut?: Address[]
}

export interface RoutingItem {
  strategy: string
  match: StrategyMatchConfig
  config?: Record<string, unknown>
}

export type RoutingConfig = Record<string, RoutingItem[]>

export interface SwapApiRequest {
  tokenIn: Address
  tokenOut: Address
  accountIn: Address
  accountOut: Address
  amount: bigint
  vaultIn: Address
  receiver: Address
  origin: Address
  slippage: number
  swapperMode: SwapperMode
  isRepay: boolean
  targetDebt: bigint
  currentDebt: bigint
  deadline: number
  dustAccount?: Address
  routingOverride?: RoutingConfig
  provider?: string
}
