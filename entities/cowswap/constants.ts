import type { Address } from 'viem'

export const COWSWAP_PROVIDER_NAME = 'cow'
export const COWSWAP_APPDATA_VERSION = '0.9.0'
export const COWSWAP_ORDER_DEADLINE_SECONDS = 900 // 15 minutes
export const COWSWAP_ORDER_POLL_INTERVAL_MS = 3000
export const COWSWAP_ORDER_POLL_MAX_DURATION_MS = (COWSWAP_ORDER_DEADLINE_SECONDS + 60) * 1000 // deadline + 1 min buffer

export type CowSwapChainConfig = {
  orderbookUrl: string
  settlementContract: Address
  vaultRelayer: Address
  openPositionWrapper: Address
  closePositionWrapper: Address
  collateralSwapWrapper: Address
}

export const COWSWAP_CHAIN_CONFIG: Record<number, CowSwapChainConfig> = {
  1: {
    orderbookUrl: 'https://api.cow.fi/mainnet',
    settlementContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    vaultRelayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
    openPositionWrapper: '0x59684A689D4a1CAc0f0632F54ec8cDd42612D728',
    closePositionWrapper: '0xa18c87849eF90190117FF1E1e8b4acE6Dac7A54b',
    collateralSwapWrapper: '0x175FBD01874e92C9b081F493371fEFE009760a42',
  },
}

export const isCowSwapSupportedChain = (chainId: number): boolean =>
  chainId in COWSWAP_CHAIN_CONFIG

export const getCowSwapChainConfig = (chainId: number): CowSwapChainConfig | undefined =>
  COWSWAP_CHAIN_CONFIG[chainId]
