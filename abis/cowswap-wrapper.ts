const OPEN_POSITION_PARAMS_COMPONENTS = [
  { name: 'owner', type: 'address' },
  { name: 'account', type: 'address' },
  { name: 'deadline', type: 'uint256' },
  { name: 'collateralVault', type: 'address' },
  { name: 'borrowVault', type: 'address' },
  { name: 'collateralAmount', type: 'uint256' },
  { name: 'borrowAmount', type: 'uint256' },
] as const

export const OPEN_POSITION_WRAPPER_ABI = [
  {
    inputs: [{
      components: OPEN_POSITION_PARAMS_COMPONENTS,
      name: 'params',
      type: 'tuple',
    }],
    name: 'encodePermitData',
    outputs: [{ name: '', type: 'bytes' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{
      components: OPEN_POSITION_PARAMS_COMPONENTS,
      name: 'params',
      type: 'tuple',
    }],
    name: 'getApprovalHash',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const
