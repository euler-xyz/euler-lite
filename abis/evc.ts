export const BATCH_ITEM_COMPONENTS = [
  { name: 'targetContract', type: 'address' },
  { name: 'onBehalfOfAccount', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' },
] as const

export const BATCH_ITEM_RESULT_COMPONENTS = [
  { name: 'success', type: 'bool' },
  { name: 'result', type: 'bytes' },
] as const

export const EVC_ABI = [
  {
    inputs: [
      {
        components: BATCH_ITEM_COMPONENTS,
        name: 'items',
        type: 'tuple[]',
      },
    ],
    name: 'batch',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      {
        components: BATCH_ITEM_COMPONENTS,
        name: 'items',
        type: 'tuple[]',
      },
    ],
    name: 'batchSimulation',
    outputs: [
      {
        components: BATCH_ITEM_RESULT_COMPONENTS,
        name: 'batchItemsResult',
        type: 'tuple[]',
      },
      {
        components: [
          { name: 'account', type: 'address' },
          { name: 'isValid', type: 'bool' },
        ],
        name: 'accountsStatusResult',
        type: 'tuple[]',
      },
      {
        components: [
          { name: 'vault', type: 'address' },
          { name: 'isValid', type: 'bool' },
        ],
        name: 'vaultsStatusResult',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    name: 'isAccountOperatorAuthorized',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export type BatchItem = {
  targetContract: `0x${string}`
  onBehalfOfAccount: `0x${string}`
  value: bigint
  data: `0x${string}`
}

export type BatchItemResult = {
  success: boolean
  result: string
}

export const evcEnableControllerAbi = [
  {
    type: 'function',
    name: 'enableController',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'vault', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

export const evcDisableControllerAbi = [
  {
    type: 'function',
    name: 'disableController',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

export const evcEnableCollateralAbi = [
  {
    type: 'function',
    name: 'enableCollateral',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'vault', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

export const evcDisableCollateralAbi = [
  {
    type: 'function',
    name: 'disableCollateral',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'vault', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

export const evcGetAccountOwnerAbi = [
  {
    type: 'function',
    name: 'getAccountOwner',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const

export const evcGetControllersAbi = [
  {
    type: 'function',
    name: 'getControllers',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
] as const
