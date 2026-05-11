// ERC-4626 view fragments. Used to discover the underlying token of a vault
// or wrapper contract without depending on a full vault ABI.
export const erc4626AssetAbi = [
  {
    type: 'function',
    name: 'asset',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const
