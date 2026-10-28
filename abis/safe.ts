/**
 * Minimal fragments for probing Safe (ex Gnosis Safe) smart accounts.
 *
 * `masterCopy()` is not a regular function on the Safe singleton — Safe proxy
 * contracts (v1.1.1+) special-case the `0xa619486e` selector in their fallback
 * and return the singleton address stored at slot 0 without delegating. An
 * `eth_call` against any Safe proxy therefore answers it, while EOAs return
 * empty data and non-Safe contracts revert or return garbage that fails
 * decoding.
 */
export const safeAccountAbi = [
  {
    type: 'function',
    name: 'masterCopy',
    inputs: [],
    outputs: [{ name: 'masterCopy', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getThreshold',
    inputs: [],
    outputs: [{ name: 'threshold', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getOwners',
    inputs: [],
    outputs: [{ name: 'owners', type: 'address[]' }],
    stateMutability: 'view',
  },
] as const
