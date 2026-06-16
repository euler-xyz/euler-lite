import { getAddress, type Address } from 'viem'

export const CROSS_PROTOCOL_REFINANCE_FIRST_PROTOCOL = 'morpho' as const
export const CROSS_PROTOCOL_REFINANCE_FIRST_DIRECTION = 'external-to-euler' as const

export const MORPHO_CONNECTOR_ID = 'morpho'

export const MORPHO_BLUE_ADDRESSES: Record<number, Address> = {
  1: getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'),
  8453: getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'),
}

export const MORPHO_POSITION_FALLBACK_MARKET_IDS: Record<number, string[]> = {
  8453: [
    '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda',
  ],
}
