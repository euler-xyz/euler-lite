// Keyring hook target ABI — view functions for credential checking
export const keyringHookTargetAbi = [
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'checkKeyringCredentialOrWildCard',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'policyId',
    outputs: [{ internalType: 'uint32', name: '', type: 'uint32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'keyring',
    outputs: [{ internalType: 'contract IKeyringCredentials', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Integrator-supplied hook targets (e.g. HookTargetAccessControlKeyringUnwind)
  // expose the same values behind `get`-prefixed getters instead of the public
  // immutables above. useKeyring falls back to these when policyId()/keyring()
  // revert. getPolicyId() is uint32 on the verified integrator ABI, matching the
  // native policyId() getter (so viem returns a plain number, no coercion).
  {
    inputs: [],
    name: 'getPolicyId',
    outputs: [{ internalType: 'uint32', name: '', type: 'uint32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getKeyring',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Keyring credentials contract ABI — credential creation and expiration
export const keyringContractAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'tradingAddress', type: 'address' },
      { internalType: 'uint256', name: 'policyId', type: 'uint256' },
      { internalType: 'uint256', name: 'chainId', type: 'uint256' },
      { internalType: 'uint256', name: 'validUntil', type: 'uint256' },
      { internalType: 'uint256', name: 'cost', type: 'uint256' },
      { internalType: 'bytes', name: 'key', type: 'bytes' },
      { internalType: 'bytes', name: 'signature', type: 'bytes' },
      { internalType: 'bytes', name: 'backdoor', type: 'bytes' },
    ],
    name: 'createCredential',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'policyId', type: 'uint256' },
      { internalType: 'address', name: 'entity_', type: 'address' },
    ],
    name: 'entityExp',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const
