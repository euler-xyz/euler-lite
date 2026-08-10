/** `governor()` getter from euler-price-oracle's Governable (EulerRouter). */
export const governableGovernorAbi = [
  {
    type: 'function',
    name: 'governor',
    inputs: [],
    outputs: [{ name: 'governor', type: 'address' }],
    stateMutability: 'view',
  },
] as const

export const priceOracleAbi = [
  {
    type: 'function',
    name: 'getQuote',
    inputs: [
      { name: 'inAmount', type: 'uint256' },
      { name: 'base', type: 'address' },
      { name: 'quote', type: 'address' },
    ],
    outputs: [{ name: 'outAmount', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const
