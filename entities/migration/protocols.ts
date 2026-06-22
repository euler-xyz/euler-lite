import { getAddress, type Address } from 'viem'

export const CROSS_PROTOCOL_REFINANCE_FIRST_PROTOCOL = 'morpho' as const
export const CROSS_PROTOCOL_REFINANCE_FIRST_DIRECTION = 'external-to-euler' as const

export const MORPHO_CONNECTOR_ID = 'morpho'
export const AAVE_CONNECTOR_ID = 'aave'

export const MORPHO_BLUE_ADDRESSES: Record<number, Address> = {
  1: getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'),
  8453: getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'),
}

export const AAVE_POOL_ADDRESSES: Record<number, Address> = {
  1: getAddress('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'),
  8453: getAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'),
}
