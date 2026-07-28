export const swapperAbi = [
  {
    type: 'function',
    name: 'multicall',
    inputs: [
      {
        name: 'calls',
        type: 'bytes[]',
        internalType: 'bytes[]',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
]

export const swapVerifierAbi = [
  {
    type: 'function',
    name: 'verifyAmountMinAndSkim',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'receiver',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'amountMin',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'deadline',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'verifyAmountMinAndTransfer',
    inputs: [
      {
        name: 'token',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'receiver',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'amountMin',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'deadline',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'verifyDebtMax',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'amountMax',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'deadline',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'view',
  },
]

export const transferFromSenderAbi = [
  {
    type: 'function',
    name: 'transferFromSender',
    inputs: [
      {
        name: 'token',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'to',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
]

export const eulerUtilsLensABI = [
  {
    type: 'constructor',
    inputs: [
      {
        name: '_eVaultFactory',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_oracleLens',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'TTL_ERROR',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_INFINITY',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_LIQUIDATION',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_MORE_THAN_ONE_YEAR',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'calculateTimeToLiquidation',
    inputs: [
      {
        name: 'liabilityVault',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'liabilityValue',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'collaterals',
        type: 'address[]',
        internalType: 'address[]',
      },
      {
        name: 'collateralValues',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'computeAPYs',
    inputs: [
      {
        name: 'borrowSPY',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'cash',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'borrows',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'interestFee',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: 'borrowAPY',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'supplyAPY',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'eVaultFactory',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract GenericFactory',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAPYs',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'borrowAPY',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'supplyAPY',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAssetPriceInfo',
    inputs: [
      {
        name: 'asset',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'unitOfAccount',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct AssetPriceInfo',
        components: [
          {
            name: 'queryFailure',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'queryFailureReason',
            type: 'bytes',
            internalType: 'bytes',
          },
          {
            name: 'timestamp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'oracle',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'asset',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'unitOfAccount',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'amountIn',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'amountOutMid',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'amountOutBid',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'amountOutAsk',
            type: 'uint256',
            internalType: 'uint256',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getControllerAssetPriceInfo',
    inputs: [
      {
        name: 'controller',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'asset',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct AssetPriceInfo',
        components: [
          {
            name: 'queryFailure',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'queryFailureReason',
            type: 'bytes',
            internalType: 'bytes',
          },
          {
            name: 'timestamp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'oracle',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'asset',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'unitOfAccount',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'amountIn',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'amountOutMid',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'amountOutBid',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'amountOutAsk',
            type: 'uint256',
            internalType: 'uint256',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getVaultInfoERC4626',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct VaultInfoERC4626',
        components: [
          {
            name: 'timestamp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'vault',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'vaultName',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'vaultSymbol',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'vaultDecimals',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'asset',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'assetName',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'assetSymbol',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'assetDecimals',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalShares',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalAssets',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'isEVault',
            type: 'bool',
            internalType: 'bool',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'oracleLens',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract OracleLens',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'tokenAllowances',
    inputs: [
      {
        name: 'spender',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'tokens',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'tokenBalances',
    inputs: [
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'tokens',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
    ],
    stateMutability: 'view',
  },
] as const
export const eulerVaultLensABI = [
  {
    type: 'constructor',
    inputs: [
      {
        name: '_oracleLens',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_utilsLens',
        type: 'address',
        internalType: 'address',
      },
      {
        name: '_irmLens',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'TTL_ERROR',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_INFINITY',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_LIQUIDATION',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_MORE_THAN_ONE_YEAR',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getRecognizedCollateralsLTVInfo',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct LTVInfo[]',
        components: [
          {
            name: 'collateral',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'borrowLTV',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'liquidationLTV',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'initialLiquidationLTV',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'targetTimestamp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'rampDuration',
            type: 'uint256',
            internalType: 'uint256',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getRewardVaultInfo',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'reward',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'numberOfEpochs',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct VaultRewardInfo',
        components: [
          {
            name: 'timestamp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'vault',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'reward',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'rewardName',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'rewardSymbol',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'rewardDecimals',
            type: 'uint8',
            internalType: 'uint8',
          },
          {
            name: 'balanceTracker',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'epochDuration',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'currentEpoch',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalRewardedEligible',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalRewardRegistered',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalRewardClaimed',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'epochInfoPrevious',
            type: 'tuple[]',
            internalType: 'struct RewardAmountInfo[]',
            components: [
              {
                name: 'epoch',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'epochStart',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'epochEnd',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'rewardAmount',
                type: 'uint256',
                internalType: 'uint256',
              },
            ],
          },
          {
            name: 'epochInfoUpcoming',
            type: 'tuple[]',
            internalType: 'struct RewardAmountInfo[]',
            components: [
              {
                name: 'epoch',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'epochStart',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'epochEnd',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'rewardAmount',
                type: 'uint256',
                internalType: 'uint256',
              },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getVaultInfoFull',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct VaultInfoFull',
        components: [
          {
            name: 'timestamp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'vault',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'vaultName',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'vaultSymbol',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'vaultDecimals',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'asset',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'assetName',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'assetSymbol',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'assetDecimals',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'unitOfAccount',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'unitOfAccountName',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'unitOfAccountSymbol',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'unitOfAccountDecimals',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalShares',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalCash',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalBorrowed',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalAssets',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'accumulatedFeesShares',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'accumulatedFeesAssets',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'governorFeeReceiver',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'protocolFeeReceiver',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'protocolFeeShare',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'interestFee',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'hookedOperations',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'configFlags',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'supplyCap',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'borrowCap',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxLiquidationDiscount',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'liquidationCoolOffTime',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'dToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'oracle',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'interestRateModel',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'hookTarget',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'evc',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'protocolConfig',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'balanceTracker',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'permit2',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'creator',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'governorAdmin',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'irmInfo',
            type: 'tuple',
            internalType: 'struct VaultInterestRateModelInfo',
            components: [
              {
                name: 'queryFailure',
                type: 'bool',
                internalType: 'bool',
              },
              {
                name: 'queryFailureReason',
                type: 'bytes',
                internalType: 'bytes',
              },
              {
                name: 'vault',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'interestRateModel',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'interestRateInfo',
                type: 'tuple[]',
                internalType: 'struct InterestRateInfo[]',
                components: [
                  {
                    name: 'cash',
                    type: 'uint256',
                    internalType: 'uint256',
                  },
                  {
                    name: 'borrows',
                    type: 'uint256',
                    internalType: 'uint256',
                  },
                  {
                    name: 'borrowSPY',
                    type: 'uint256',
                    internalType: 'uint256',
                  },
                  {
                    name: 'borrowAPY',
                    type: 'uint256',
                    internalType: 'uint256',
                  },
                  {
                    name: 'supplyAPY',
                    type: 'uint256',
                    internalType: 'uint256',
                  },
                ],
              },
              {
                name: 'interestRateModelInfo',
                type: 'tuple',
                internalType: 'struct InterestRateModelDetailedInfo',
                components: [
                  {
                    name: 'interestRateModel',
                    type: 'address',
                    internalType: 'address',
                  },
                  {
                    name: 'interestRateModelType',
                    type: 'uint8',
                    internalType: 'enum InterestRateModelType',
                  },
                  {
                    name: 'interestRateModelParams',
                    type: 'bytes',
                    internalType: 'bytes',
                  },
                ],
              },
            ],
          },
          {
            name: 'collateralLTVInfo',
            type: 'tuple[]',
            internalType: 'struct LTVInfo[]',
            components: [
              {
                name: 'collateral',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'borrowLTV',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'liquidationLTV',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'initialLiquidationLTV',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'targetTimestamp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'rampDuration',
                type: 'uint256',
                internalType: 'uint256',
              },
            ],
          },
          {
            name: 'liabilityPriceInfo',
            type: 'tuple',
            internalType: 'struct AssetPriceInfo',
            components: [
              {
                name: 'queryFailure',
                type: 'bool',
                internalType: 'bool',
              },
              {
                name: 'queryFailureReason',
                type: 'bytes',
                internalType: 'bytes',
              },
              {
                name: 'timestamp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'oracle',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'asset',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'unitOfAccount',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'amountIn',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'amountOutMid',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'amountOutBid',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'amountOutAsk',
                type: 'uint256',
                internalType: 'uint256',
              },
            ],
          },
          {
            name: 'collateralPriceInfo',
            type: 'tuple[]',
            internalType: 'struct AssetPriceInfo[]',
            components: [
              {
                name: 'queryFailure',
                type: 'bool',
                internalType: 'bool',
              },
              {
                name: 'queryFailureReason',
                type: 'bytes',
                internalType: 'bytes',
              },
              {
                name: 'timestamp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'oracle',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'asset',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'unitOfAccount',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'amountIn',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'amountOutMid',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'amountOutBid',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'amountOutAsk',
                type: 'uint256',
                internalType: 'uint256',
              },
            ],
          },
          {
            name: 'oracleInfo',
            type: 'tuple',
            internalType: 'struct OracleDetailedInfo',
            components: [
              {
                name: 'oracle',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'name',
                type: 'string',
                internalType: 'string',
              },
              {
                name: 'oracleInfo',
                type: 'bytes',
                internalType: 'bytes',
              },
            ],
          },
          {
            name: 'backupAssetPriceInfo',
            type: 'tuple',
            internalType: 'struct AssetPriceInfo',
            components: [
              {
                name: 'queryFailure',
                type: 'bool',
                internalType: 'bool',
              },
              {
                name: 'queryFailureReason',
                type: 'bytes',
                internalType: 'bytes',
              },
              {
                name: 'timestamp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'oracle',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'asset',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'unitOfAccount',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'amountIn',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'amountOutMid',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'amountOutBid',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'amountOutAsk',
                type: 'uint256',
                internalType: 'uint256',
              },
            ],
          },
          {
            name: 'backupAssetOracleInfo',
            type: 'tuple',
            internalType: 'struct OracleDetailedInfo',
            components: [
              {
                name: 'oracle',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'name',
                type: 'string',
                internalType: 'string',
              },
              {
                name: 'oracleInfo',
                type: 'bytes',
                internalType: 'bytes',
              },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getVaultInterestRateModelInfo',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'cash',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
      {
        name: 'borrows',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct VaultInterestRateModelInfo',
        components: [
          {
            name: 'queryFailure',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'queryFailureReason',
            type: 'bytes',
            internalType: 'bytes',
          },
          {
            name: 'vault',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'interestRateModel',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'interestRateInfo',
            type: 'tuple[]',
            internalType: 'struct InterestRateInfo[]',
            components: [
              {
                name: 'cash',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'borrows',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'borrowSPY',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'borrowAPY',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'supplyAPY',
                type: 'uint256',
                internalType: 'uint256',
              },
            ],
          },
          {
            name: 'interestRateModelInfo',
            type: 'tuple',
            internalType: 'struct InterestRateModelDetailedInfo',
            components: [
              {
                name: 'interestRateModel',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'interestRateModelType',
                type: 'uint8',
                internalType: 'enum InterestRateModelType',
              },
              {
                name: 'interestRateModelParams',
                type: 'bytes',
                internalType: 'bytes',
              },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getVaultKinkInterestRateModelInfo',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct VaultInterestRateModelInfo',
        components: [
          {
            name: 'queryFailure',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'queryFailureReason',
            type: 'bytes',
            internalType: 'bytes',
          },
          {
            name: 'vault',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'interestRateModel',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'interestRateInfo',
            type: 'tuple[]',
            internalType: 'struct InterestRateInfo[]',
            components: [
              {
                name: 'cash',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'borrows',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'borrowSPY',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'borrowAPY',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'supplyAPY',
                type: 'uint256',
                internalType: 'uint256',
              },
            ],
          },
          {
            name: 'interestRateModelInfo',
            type: 'tuple',
            internalType: 'struct InterestRateModelDetailedInfo',
            components: [
              {
                name: 'interestRateModel',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'interestRateModelType',
                type: 'uint8',
                internalType: 'enum InterestRateModelType',
              },
              {
                name: 'interestRateModelParams',
                type: 'bytes',
                internalType: 'bytes',
              },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'irmLens',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IRMLens',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'oracleLens',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract OracleLens',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'utilsLens',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract UtilsLens',
      },
    ],
    stateMutability: 'view',
  },
]
export const eulerEarnVaultLensABI = [
  {
    type: 'constructor',
    inputs: [
      {
        name: '_utilsLens',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'TTL_ERROR',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_INFINITY',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_LIQUIDATION',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_MORE_THAN_ONE_YEAR',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getVaultInfoFull',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct EulerEarnVaultInfoFull',
        components: [
          {
            name: 'timestamp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'vault',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'vaultName',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'vaultSymbol',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'vaultDecimals',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'asset',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'assetName',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'assetSymbol',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'assetDecimals',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalShares',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'totalAssets',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'lostAssets',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'availableAssets',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'timelock',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'performanceFee',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'feeReceiver',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'owner',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'creator',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'curator',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'guardian',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'evc',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'permit2',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'pendingTimelock',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'pendingTimelockValidAt',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'pendingGuardian',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'pendingGuardianValidAt',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'supplyQueue',
            type: 'address[]',
            internalType: 'address[]',
          },
          {
            name: 'strategies',
            type: 'tuple[]',
            internalType: 'struct EulerEarnVaultStrategyInfo[]',
            components: [
              {
                name: 'strategy',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'allocatedAssets',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'availableAssets',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'currentAllocationCap',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'pendingAllocationCap',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'pendingAllocationCapValidAt',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'removableAt',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'info',
                type: 'tuple',
                internalType: 'struct VaultInfoERC4626',
                components: [
                  {
                    name: 'timestamp',
                    type: 'uint256',
                    internalType: 'uint256',
                  },
                  {
                    name: 'vault',
                    type: 'address',
                    internalType: 'address',
                  },
                  {
                    name: 'vaultName',
                    type: 'string',
                    internalType: 'string',
                  },
                  {
                    name: 'vaultSymbol',
                    type: 'string',
                    internalType: 'string',
                  },
                  {
                    name: 'vaultDecimals',
                    type: 'uint256',
                    internalType: 'uint256',
                  },
                  {
                    name: 'asset',
                    type: 'address',
                    internalType: 'address',
                  },
                  {
                    name: 'assetName',
                    type: 'string',
                    internalType: 'string',
                  },
                  {
                    name: 'assetSymbol',
                    type: 'string',
                    internalType: 'string',
                  },
                  {
                    name: 'assetDecimals',
                    type: 'uint256',
                    internalType: 'uint256',
                  },
                  {
                    name: 'totalShares',
                    type: 'uint256',
                    internalType: 'uint256',
                  },
                  {
                    name: 'totalAssets',
                    type: 'uint256',
                    internalType: 'uint256',
                  },
                  {
                    name: 'isEVault',
                    type: 'bool',
                    internalType: 'bool',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'utilsLens',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract UtilsLens',
      },
    ],
    stateMutability: 'view',
  },
]
export const eulerPerspectiveABI = [
  {
    type: 'function',
    name: 'isVerified',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'name',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'perspectiveVerify',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'failEarly',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'vaultFactory',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract GenericFactory',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'verifiedArray',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'verifiedLength',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'PerspectiveVerified',
    inputs: [
      {
        name: 'vault',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'PerspectiveError',
    inputs: [
      {
        name: 'perspective',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'vault',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'codes',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'PerspectivePanic',
    inputs: [],
  },
]
export const eulerOracleABI = [
  {
    type: 'constructor',
    inputs: [
      {
        name: '_adapterRegistry',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'TTL_ERROR',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_INFINITY',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_LIQUIDATION',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TTL_MORE_THAN_ONE_YEAR',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'int256',
        internalType: 'int256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'adapterRegistry',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract SnapshotRegistry',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getOracleInfo',
    inputs: [
      {
        name: 'oracleAddress',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'bases',
        type: 'address[]',
        internalType: 'address[]',
      },
      {
        name: 'quotes',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct OracleDetailedInfo',
        components: [
          {
            name: 'oracle',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'name',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'oracleInfo',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getValidAdapters',
    inputs: [
      {
        name: 'base',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'quote',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isStalePullOracle',
    inputs: [
      {
        name: 'oracleAddress',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'failureReason',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
]

export const erc20ABI = [
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      {
        name: 'owner',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'spender',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      {
        name: 'spender',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint8',
        internalType: 'uint8',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'name',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'symbol',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'totalSupply',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      {
        name: 'recipient',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transferFrom',
    inputs: [
      {
        name: 'sender',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'recipient',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'nonpayable',
  },
]

export const eVaultABI = [
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'receiver',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'shares',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'withdraw',
    inputs: [
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'receiver',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'owner',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'shares',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'redeem',
    inputs: [
      {
        name: 'shares',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'receiver',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'owner',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'assets',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'borrow',
    inputs: [
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'receiver',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'shares',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'repay',
    inputs: [
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'receiver',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'shares',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'asset',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'totalSupply',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'convertToShares',
    inputs: [
      {
        name: 'assets',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'convertToAssets',
    inputs: [
      {
        name: 'shares',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'previewWithdraw',
    inputs: [
      {
        name: 'assets',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'maxWithdraw',
    inputs: [
      {
        name: 'owner',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
]
