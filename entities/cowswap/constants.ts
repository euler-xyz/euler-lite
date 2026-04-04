import type { Address } from 'viem'

export const COWSWAP_PROVIDER_NAME = 'cow'
export const COWSWAP_MIN_BUY_AMOUNT = 1n
export const COWSWAP_APPDATA_VERSION = '0.9.0'
export const COWSWAP_ORDER_POLL_INTERVAL_MS = 3000
export const COWSWAP_ORDER_POLL_MAX_DURATION_MS = 120_000

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
    orderbookUrl: 'https://barn.api.cow.fi/mainnet',
    settlementContract: '0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13',
    vaultRelayer: '0xC7242d167563352E2BCA4d71C043fbe542DB8FB2',
    openPositionWrapper: '0x891cf92cf082CD159aCAF6A62Ab010495B5Ab4aE',
    closePositionWrapper: '0x212EbC94997746285924b4e516e9936664B96275',
    collateralSwapWrapper: '0x4f501061d2288f52dF5693f9A1a25e04c77B4163',
  },
}

export const isCowSwapSupportedChain = (chainId: number): boolean =>
  chainId in COWSWAP_CHAIN_CONFIG

export const getCowSwapChainConfig = (chainId: number): CowSwapChainConfig | undefined =>
  COWSWAP_CHAIN_CONFIG[chainId]
