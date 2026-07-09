import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { SwapperMode, type EVCBatchItem, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'

import { buildTransactionPlanDisplaySteps, type StepDecodingContext, type VaultLookup } from '~/utils/stepDecoding'

const verifier = '0x0000000000000000000000000000000000000001' as Address
const account = '0x0000000000000000000000000000000000000002' as Address
const swapper = '0x0000000000000000000000000000000000000003' as Address
const usdcVault = '0x0000000000000000000000000000000000000011' as Address
const daiVault = '0x0000000000000000000000000000000000000012' as Address
const weethVault = '0x0000000000000000000000000000000000000013' as Address
const wethVault = '0x0000000000000000000000000000000000000014' as Address
const cbBtcVault = '0x0000000000000000000000000000000000000015' as Address
const sourceWbtcVault = '0x0000000000000000000000000000000000000016' as Address
const targetWbtcVault = '0x0000000000000000000000000000000000000017' as Address
const usdcAsset = '0x0000000000000000000000000000000000000021' as Address
const daiAsset = '0x0000000000000000000000000000000000000022' as Address
const weethAsset = '0x0000000000000000000000000000000000000023' as Address
const wethAsset = '0x0000000000000000000000000000000000000024' as Address
const cbBtcAsset = '0x0000000000000000000000000000000000000025' as Address
const wstEthAsset = '0x0000000000000000000000000000000000000026' as Address
const morpho = '0x0000000000000000000000000000000000000031' as Address
const aavePool = '0x0000000000000000000000000000000000000032' as Address
const oracle = '0x0000000000000000000000000000000000000033' as Address
const irm = '0x0000000000000000000000000000000000000034' as Address
const aToken = '0x0000000000000000000000000000000000000035' as Address
const variableDebtToken = '0x0000000000000000000000000000000000000036' as Address
const metamorphoVault = '0x0000000000000000000000000000000000000037' as Address
const bytes32Zero = `0x${'00'.repeat(32)}` as Hex
const genericHandler = '0x47656e6572696300000000000000000000000000000000000000000000000000' as Hex
const wbtcAsset = '0x0000000000000000000000000000000000000026' as Address

const swapVerifierAbi = parseAbi([
  'function verifyAmountMinAndDeposit(address vault,address receiver,uint256 amountMin,uint256 deadline)',
  'function verifyAmountMinAndSkim(address vault,address receiver,uint256 amountMin,uint256 deadline)',
  'function verifyAmountMinAndTransfer(address asset,address receiver,uint256 amountMin,uint256 deadline)',
  'function verifyDebtMax(address vault,address account,uint256 amountMax,uint256 deadline)',
  'function aaveBorrowForSender(address pool,address asset,uint256 amount,address to)',
  'function morphoBorrowForSender(address morpho,(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 amount,address to)',
  'function morphoWithdrawCollateralForSender(address morpho,(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 amount,address to)',
  'function transferBalanceFromSender(address token,uint256 maxAmount,address to)',
])
const vaultAbi = parseAbi([
  'function withdraw(uint256 assets,address receiver,address owner)',
  'function redeem(uint256 shares,address receiver,address owner)',
  'function borrow(uint256 assets,address receiver)',
  'function repay(uint256 assets,address receiver)',
])
const evcAbi = parseAbi([
  'function enableController(address account,address vault)',
  'function enableCollateral(address account,address vault)',
  'function disableController()',
])
const swapperAbi = parseAbi([
  'function multicall(bytes[] data)',
  'function deposit(address token,address vault,uint256 amountMin,address account)',
  'function repay(address token,address vault,uint256 repayAmount,address account)',
  'function swap((bytes32 handler,uint256 mode,address account,address tokenIn,address tokenOut,address vaultIn,address accountIn,address receiver,uint256 amountOut,bytes data) params)',
  'function sweep(address token,uint256 amountMin,address to)',
])
const morphoAbi = parseAbi([
  'function repay((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,uint256 shares,address onBehalf,bytes data)',
  'function setAuthorizationWithSig((address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline) authorization,(uint8 v,bytes32 r,bytes32 s) signature)',
  'function supplyCollateral((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,address onBehalf,bytes data)',
])
const aavePoolAbi = parseAbi([
  'function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf)',
  'function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)',
  'function withdraw(address asset,uint256 amount,address to)',
])
const aaveAuthAbi = parseAbi([
  'function delegationWithSig(address delegator,address delegatee,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
])

const ctx: StepDecodingContext = {
  type: 'swap',
  asset: {
    symbol: 'USDC',
    address: usdcAsset,
    decimals: 6,
  },
  amount: '100',
  swapToAsset: {
    symbol: 'DAI',
    address: daiAsset,
    decimals: 6,
  },
  swapToAmount: '99',
}

const getVault: VaultLookup = (address) => {
  const normalized = address.toLowerCase()
  if (normalized === usdcVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'USDC',
        address: usdcAsset,
        decimals: 6,
      },
    }
  }
  if (normalized === daiVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'DAI',
        address: daiAsset,
        decimals: 6,
      },
    }
  }
  if (normalized === weethVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'weETH',
        address: weethAsset,
        decimals: 18,
      },
    }
  }
  if (normalized === wethVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'WETH',
        address: wethAsset,
        decimals: 18,
      },
    }
  }
  if (normalized === cbBtcVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'cbBTC',
        address: cbBtcAsset,
        decimals: 8,
      },
    }
  }
  if (normalized === sourceWbtcVault.toLowerCase() || normalized === targetWbtcVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'WBTC',
        address: wbtcAsset,
        decimals: 8,
      },
    }
  }
  return undefined
}

const getLogoUrl = () => ''

const batchItem = (data: Hex, targetContract: Address = verifier): EVCBatchItem => ({
  targetContract,
  onBehalfOfAccount: account,
  value: 0n,
  data,
})

const marketParams = {
  loanToken: usdcAsset,
  collateralToken: wethAsset,
  oracle,
  irm,
  lltv: 860000000000000000n,
}

const morphoAuthorization = (isAuthorized: boolean) => encodeFunctionData({
  abi: morphoAbi,
  functionName: 'setAuthorizationWithSig',
  args: [
    { authorizer: account, authorized: verifier, isAuthorized, nonce: isAuthorized ? 1n : 2n, deadline: 123n },
    { v: 27, r: bytes32Zero, s: bytes32Zero },
  ],
})

const genericSwap = (target: Address, tokenIn: Address, tokenOut: Address, payload: Hex) => encodeFunctionData({
  abi: swapperAbi,
  functionName: 'swap',
  args: [{
    handler: genericHandler,
    mode: 0n,
    account: target,
    tokenIn,
    tokenOut,
    vaultIn: target,
    accountIn: target,
    receiver: target,
    amountOut: 0n,
    data: encodeAbiParameters([
      { name: 'target', type: 'address' },
      { name: 'payload', type: 'bytes' },
    ], [target, payload]),
  }],
})

const tokenSwap = (tokenIn: Address, tokenOut: Address, amountOut = 0n) => encodeFunctionData({
  abi: swapperAbi,
  functionName: 'swap',
  args: [{
    handler: bytes32Zero,
    mode: 0n,
    account,
    tokenIn,
    tokenOut,
    vaultIn: account,
    accountIn: account,
    receiver: account,
    amountOut,
    data: '0x',
  }],
})

const buildSteps = (data: Hex) => buildTransactionPlanDisplaySteps(
  [{
    type: 'evcBatch',
    items: [batchItem(data)],
  }] satisfies TransactionPlan,
  ctx,
  getVault,
  getLogoUrl,
)

const migrationCtx: StepDecodingContext = {
  type: 'migration',
  asset: {
    symbol: 'USDC',
    address: usdcAsset,
    decimals: 6,
  },
  amount: '1',
}

const migrationSteps = (items: EVCBatchItem[], context: StepDecodingContext = migrationCtx) => buildTransactionPlanDisplaySteps(
  [{
    type: 'evcBatch',
    items,
  }] satisfies TransactionPlan,
  context,
  getVault,
  getLogoUrl,
)

const enableController = (vault: Address) => encodeFunctionData({
  abi: evcAbi,
  functionName: 'enableController',
  args: [account, vault],
})

const enableCollateral = (vault: Address) => encodeFunctionData({
  abi: evcAbi,
  functionName: 'enableCollateral',
  args: [account, vault],
})

const disableController = () => encodeFunctionData({
  abi: evcAbi,
  functionName: 'disableController',
  args: [],
})

const swapperMulticall = (calls: Hex[]) => encodeFunctionData({
  abi: swapperAbi,
  functionName: 'multicall',
  args: [calls],
})

describe('buildTransactionPlanDisplaySteps swap verifier rows', () => {
  it('shows the min received amount for deposit verification', () => {
    const steps = buildSteps(encodeFunctionData({
      abi: swapVerifierAbi,
      functionName: 'verifyAmountMinAndDeposit',
      args: [daiVault, account, 98_765_432n, 123n],
    }))

    expect(steps[0]).toMatchObject({
      label: 'Verify min received',
      assetInfo: {
        symbol: 'DAI',
        address: daiAsset,
        amount: '98.765432',
      },
    })
  })

  it('shows the min received amount for skim verification', () => {
    const steps = buildSteps(encodeFunctionData({
      abi: swapVerifierAbi,
      functionName: 'verifyAmountMinAndSkim',
      args: [daiVault, account, 98_765_432n, 123n],
    }))

    expect(steps[0]).toMatchObject({
      label: 'Verify min received',
      assetInfo: {
        symbol: 'DAI',
        address: daiAsset,
        amount: '98.765432',
      },
    })
  })

  it('shows the min received amount for transfer verification', () => {
    const steps = buildSteps(encodeFunctionData({
      abi: swapVerifierAbi,
      functionName: 'verifyAmountMinAndTransfer',
      args: [daiAsset, account, 12_345_678n, 123n],
    }))

    expect(steps[0]).toMatchObject({
      label: 'Verify min received',
      assetInfo: {
        symbol: 'DAI',
        address: daiAsset,
        amount: '12.345678',
      },
    })
  })

  it('shows the max debt amount for debt verification', () => {
    const steps = buildSteps(encodeFunctionData({
      abi: swapVerifierAbi,
      functionName: 'verifyDebtMax',
      args: [usdcVault, account, 1_234_567n, 123n],
    }))

    expect(steps[0]).toMatchObject({
      label: 'Verify max debt',
      assetInfo: {
        symbol: 'USDC',
        address: usdcAsset,
        amount: '1.234567',
      },
    })
  })

  it('keeps quoted swap output separate from the verifier minimum', () => {
    const steps = buildTransactionPlanDisplaySteps(
      [{
        type: 'evcBatch',
        items: [
          batchItem(encodeFunctionData({
            abi: swapperAbi,
            functionName: 'multicall',
            args: [[]],
          }), swapper),
          batchItem(encodeFunctionData({
            abi: swapVerifierAbi,
            functionName: 'verifyAmountMinAndSkim',
            args: [daiVault, account, 98_765_432n, 123n],
          })),
        ],
      }] satisfies TransactionPlan,
      ctx,
      getVault,
      getLogoUrl,
    )

    expect(steps[0]).toMatchObject({
      label: 'Swap',
      toAssetInfo: {
        symbol: 'DAI',
        address: daiAsset,
        amount: '99',
      },
    })
    expect(steps[1]).toMatchObject({
      label: 'Verify min received',
      assetInfo: {
        symbol: 'DAI',
        address: daiAsset,
        amount: '98.765432',
      },
    })
  })

  it('infers separate swap assets in a combined collateral and debt refinance batch', () => {
    const steps = buildTransactionPlanDisplaySteps(
      [{
        type: 'evcBatch',
        items: [
          batchItem(encodeFunctionData({
            abi: vaultAbi,
            functionName: 'withdraw',
            args: [731_941n, weethVault, account],
          }), usdcVault),
          batchItem(encodeFunctionData({
            abi: swapperAbi,
            functionName: 'multicall',
            args: [[]],
          }), swapper),
          batchItem(encodeFunctionData({
            abi: swapVerifierAbi,
            functionName: 'verifyAmountMinAndSkim',
            args: [weethVault, account, 377_740_000_000_000n, 123n],
          })),
          batchItem(encodeFunctionData({
            abi: vaultAbi,
            functionName: 'borrow',
            args: [395_140_000_000_000n, account],
          }), wethVault),
          batchItem(encodeFunctionData({
            abi: swapperAbi,
            functionName: 'multicall',
            args: [[]],
          }), swapper),
          batchItem(encodeFunctionData({
            abi: swapVerifierAbi,
            functionName: 'verifyDebtMax',
            args: [cbBtcVault, account, 0n, 123n],
          })),
        ],
      }] satisfies TransactionPlan,
      {
        type: 'refinance',
        asset: { symbol: 'cbBTC', address: cbBtcAsset, decimals: 8 },
        amount: '0.00000994',
      },
      getVault,
      getLogoUrl,
    )

    expect(steps[0]).toMatchObject({
      label: 'Withdraw',
      assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '0.731941' },
    })
    expect(steps[1]).toMatchObject({
      label: 'Swap',
      assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '0.731941' },
    })
    expect(steps[1]?.toAssetInfo).toBeUndefined()
    expect(steps[3]).toMatchObject({
      label: 'Borrow',
      assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00039514' },
    })
    expect(steps[4]).toMatchObject({
      label: 'Swap to repay',
      assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00039514' },
    })
    expect(steps[4]?.toAssetInfo).toBeUndefined()
  })

  it('uses explicit collateral swap input metadata for collateral-only refinance reviews', () => {
    const steps = buildTransactionPlanDisplaySteps(
      [{
        type: 'evcBatch',
        items: [
          batchItem(encodeFunctionData({
            abi: vaultAbi,
            functionName: 'withdraw',
            args: [25_152n, swapper, account],
          }), sourceWbtcVault),
          batchItem(encodeFunctionData({
            abi: swapperAbi,
            functionName: 'multicall',
            args: [[]],
          }), swapper),
        ],
      }] satisfies TransactionPlan,
      {
        type: 'refinance',
        asset: { symbol: 'USDC', address: usdcAsset, decimals: 6 },
        amount: '9.618704',
        swapFromAsset: { symbol: 'WBTC', address: wbtcAsset, decimals: 8 },
        swapFromAmount: '0.00025152',
        swapToAsset: { symbol: 'weETH', address: weethAsset, decimals: 18 },
        swapToAmount: '0.00037774',
        swapMode: SwapperMode.EXACT_IN,
      },
      getVault,
      getLogoUrl,
    )

    expect(steps[1]).toMatchObject({
      label: 'Swap',
      assetInfo: {
        symbol: 'WBTC',
        address: wbtcAsset,
        amount: '0.00025152',
      },
      toAssetInfo: {
        symbol: 'weETH',
        address: weethAsset,
        amount: '0.00037774',
      },
    })
  })

  it('uses vault-specific display amounts for same-asset refinance collateral redeems', () => {
    const steps = buildTransactionPlanDisplaySteps(
      [{
        type: 'evcBatch',
        items: [
          batchItem(encodeFunctionData({
            abi: vaultAbi,
            functionName: 'redeem',
            args: [25_152n, targetWbtcVault, account],
          }), sourceWbtcVault),
        ],
      }] satisfies TransactionPlan,
      {
        type: 'refinance',
        asset: { symbol: 'USDC', address: usdcAsset, decimals: 6 },
        amount: '9.618704',
        vaultAmounts: {
          [sourceWbtcVault.toLowerCase()]: '0.00025152',
        },
      },
      getVault,
      getLogoUrl,
    )

    expect(steps[0]).toMatchObject({
      label: 'Withdraw',
      assetInfo: {
        symbol: 'WBTC',
        address: wbtcAsset,
        amount: '0.00025152',
      },
    })
  })
})

describe('buildTransactionPlanDisplaySteps generic-handler redeem outside migrations', () => {
  it('labels a wrapped ERC4626 redeem as a plain withdrawal', () => {
    const steps = buildSteps(genericSwap(daiVault, daiAsset, daiAsset, encodeFunctionData({
      abi: vaultAbi,
      functionName: 'redeem',
      args: [1n, account, account],
    })))

    expect(steps[0]?.label).toBe('Withdraw')
  })
})

describe('buildTransactionPlanDisplaySteps migration rows', () => {
  const collateralAmount = 1_771_920_000_000_000n
  const debtBorrowAmount = 1_010_849n
  const debtRepayAmount = 1_000_841n
  const maxUint256 = 2n ** 256n - 1n

  const summary = (items: EVCBatchItem[]) =>
    migrationSteps(items).map(step => ({
      label: step.label,
      assetInfo: step.assetInfo
        ? {
            symbol: step.assetInfo.symbol,
            address: step.assetInfo.address,
            amount: step.assetInfo.amount,
          }
        : undefined,
    }))

  it('decodes an inbound Morpho migration from the transaction payload', () => {
    const rows = summary([
      batchItem(morphoAuthorization(true), morpho),
      batchItem(enableController(usdcVault)),
      batchItem(enableCollateral(wethVault)),
      batchItem(encodeFunctionData({
        abi: vaultAbi,
        functionName: 'borrow',
        args: [debtBorrowAmount, account],
      }), usdcVault),
      batchItem(swapperMulticall([
        genericSwap(morpho, usdcAsset, usdcAsset, encodeFunctionData({
          abi: morphoAbi,
          functionName: 'repay',
          args: [marketParams, debtRepayAmount, 0n, account, '0x'],
        })),
      ]), swapper),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'morphoWithdrawCollateralForSender',
        args: [morpho, marketParams, collateralAmount, verifier],
      })),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'verifyAmountMinAndDeposit',
        args: [wethVault, account, collateralAmount, 123n],
      })),
      batchItem(encodeFunctionData({
        abi: swapperAbi,
        functionName: 'repay',
        args: [usdcAsset, usdcVault, 0n, account],
      }), swapper),
      batchItem(morphoAuthorization(false), morpho),
    ])

    expect(rows).toEqual([
      { label: 'Enable Morpho authorization', assetInfo: undefined },
      { label: 'Enable controller', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: undefined } },
      { label: 'Enable collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: undefined } },
      { label: 'Borrow on Euler', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.010849' } },
      { label: 'Repay Morpho debt', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.000841' } },
      { label: 'Withdraw Morpho collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Supply collateral to Euler', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Disable Morpho authorization', assetInfo: undefined },
    ])
  })

  it('keeps the debt swap visible when an inbound Morpho migration borrows a different Euler asset', () => {
    const steps = migrationSteps([
      batchItem(enableController(cbBtcVault)),
      batchItem(enableCollateral(wethVault)),
      batchItem(encodeFunctionData({
        abi: vaultAbi,
        functionName: 'borrow',
        args: [1697n, account],
      }), cbBtcVault),
      batchItem(swapperMulticall([
        tokenSwap(cbBtcAsset, usdcAsset, debtRepayAmount),
        genericSwap(morpho, usdcAsset, usdcAsset, encodeFunctionData({
          abi: morphoAbi,
          functionName: 'repay',
          args: [marketParams, 0n, 123n, account, '0x'],
        })),
      ]), swapper),
    ], { ...migrationCtx, amount: '1.000841' })

    expect(steps).toMatchObject([
      { label: 'Enable controller', assetInfo: { symbol: 'cbBTC', address: cbBtcAsset } },
      { label: 'Enable collateral', assetInfo: { symbol: 'WETH', address: wethAsset } },
      { label: 'Borrow on Euler', assetInfo: { symbol: 'cbBTC', address: cbBtcAsset, amount: '0.00001697' } },
      {
        label: 'Swap',
        assetInfo: { symbol: 'cbBTC', address: cbBtcAsset, amount: '0.00001697' },
        toAssetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.000841' },
      },
      { label: 'Repay Morpho debt', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.000841' } },
    ])
  })

  it('fills Morpho debt swap output and external collateral withdrawal assets in a two-swap inbound migration', () => {
    const sourceCollateralAmount = 2_771_920_000_000_000n
    const targetCollateralMinAmount = 1_428_230_000_000_000n
    const sourceMarketParams = {
      ...marketParams,
      collateralToken: wstEthAsset,
    }
    const steps = migrationSteps([
      batchItem(morphoAuthorization(true), morpho),
      batchItem(enableController(cbBtcVault)),
      batchItem(enableCollateral(wethVault)),
      batchItem(encodeFunctionData({
        abi: vaultAbi,
        functionName: 'borrow',
        args: [1697n, account],
      }), cbBtcVault),
      batchItem(swapperMulticall([
        tokenSwap(cbBtcAsset, usdcAsset),
        genericSwap(morpho, usdcAsset, usdcAsset, encodeFunctionData({
          abi: morphoAbi,
          functionName: 'repay',
          args: [sourceMarketParams, 0n, 123n, account, '0x'],
        })),
      ]), swapper),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'morphoWithdrawCollateralForSender',
        args: [morpho, sourceMarketParams, sourceCollateralAmount, verifier],
      })),
      batchItem(swapperMulticall([
        tokenSwap(wstEthAsset, wethAsset),
      ]), swapper),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'verifyAmountMinAndDeposit',
        args: [wethVault, account, targetCollateralMinAmount, 123n],
      })),
      batchItem(morphoAuthorization(false), morpho),
    ], {
      ...migrationCtx,
      amount: '1.000841',
      knownAssets: [
        { symbol: 'wstETH', address: wstEthAsset, decimals: 18 },
      ],
      swapQuoteOutputs: [
        { tokenIn: cbBtcAsset, tokenOut: usdcAsset, amountOut: '1.000841' },
        { tokenIn: wstEthAsset, tokenOut: wethAsset, amountOut: '0.0015' },
      ],
    })

    expect(steps).toMatchObject([
      { label: 'Enable Morpho authorization', assetInfo: undefined },
      { label: 'Enable controller', assetInfo: { symbol: 'cbBTC', address: cbBtcAsset } },
      { label: 'Enable collateral', assetInfo: { symbol: 'WETH', address: wethAsset } },
      { label: 'Borrow on Euler', assetInfo: { symbol: 'cbBTC', address: cbBtcAsset, amount: '0.00001697' } },
      {
        label: 'Swap',
        assetInfo: { symbol: 'cbBTC', address: cbBtcAsset, amount: '0.00001697' },
        toAssetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.000841' },
      },
      { label: 'Repay Morpho debt', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.000841' } },
      { label: 'Withdraw Morpho collateral', assetInfo: { symbol: 'wstETH', address: wstEthAsset, amount: '0.00277192' } },
      {
        label: 'Swap',
        assetInfo: { symbol: 'wstETH', address: wstEthAsset, amount: '0.00277192' },
        toAssetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.0015' },
      },
      { label: 'Verify min received and supply to Euler', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00142823' } },
      { label: 'Disable Morpho authorization', assetInfo: undefined },
    ])
  })

  it('renders a max Swapper repay as "remaining" and uses Swapper deposit amountMin', () => {
    const rows = summary([
      // Swapper repay with the type(uint256).max "repay full debt" sentinel.
      batchItem(encodeFunctionData({
        abi: swapperAbi,
        functionName: 'repay',
        args: [usdcAsset, usdcVault, maxUint256, account],
      }), swapper),
      batchItem(encodeFunctionData({
        abi: swapperAbi,
        functionName: 'deposit',
        args: [wethAsset, wethVault, collateralAmount, account],
      }), swapper),
    ])

    expect(rows).toEqual([
      { label: 'Repay Euler debt', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: 'remaining' } },
      { label: 'Supply collateral to Euler', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
    ])
  })

  it('labels a no-swap same-asset collateral move as "Supply collateral to Euler", not "Swap"', () => {
    const rows = summary([
      batchItem(enableCollateral(wethVault)),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'morphoWithdrawCollateralForSender',
        args: [morpho, marketParams, collateralAmount, account],
      })),
      // Swapper "swap" with tokenIn === tokenOut: not a real swap, just a
      // deposit of the withdrawn collateral into the Euler vault.
      batchItem(swapperMulticall([
        genericSwap(wethVault, wethAsset, wethAsset, '0xdeadbeef'),
      ]), swapper),
    ])

    expect(rows).toEqual([
      { label: 'Enable collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: undefined } },
      { label: 'Withdraw Morpho collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Supply collateral to Euler', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
    ])
  })

  it('labels a no-swap collateral multicall (deposit + excess repay) as "Supply collateral to Euler"', () => {
    const rows = summary([
      batchItem(enableCollateral(wethVault)),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'morphoWithdrawCollateralForSender',
        args: [morpho, marketParams, collateralAmount, account],
      })),
      // The real no-swap path: a Swapper multicall bundling the collateral
      // deposit with an excess-debt repay. The deposit is the primary action.
      batchItem(swapperMulticall([
        encodeFunctionData({ abi: swapperAbi, functionName: 'deposit', args: [wethAsset, wethVault, collateralAmount, account] }),
        encodeFunctionData({ abi: swapperAbi, functionName: 'repay', args: [usdcAsset, usdcVault, debtBorrowAmount, account] }),
      ]), swapper),
    ])

    expect(rows).toEqual([
      { label: 'Enable collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: undefined } },
      { label: 'Withdraw Morpho collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Supply collateral to Euler', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
    ])
  })

  it('decodes an outbound Morpho migration from nested Swapper payloads', () => {
    const rows = summary([
      batchItem(morphoAuthorization(true), morpho),
      batchItem(encodeFunctionData({
        abi: vaultAbi,
        functionName: 'withdraw',
        args: [collateralAmount, account, account],
      }), wethVault),
      batchItem(genericSwap(morpho, wethAsset, wethAsset, encodeFunctionData({
        abi: morphoAbi,
        functionName: 'supplyCollateral',
        args: [marketParams, collateralAmount, account, '0x'],
      })), swapper),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'morphoBorrowForSender',
        args: [morpho, marketParams, debtBorrowAmount, account],
      })),
      batchItem(encodeFunctionData({
        abi: vaultAbi,
        functionName: 'repay',
        args: [debtRepayAmount, account],
      }), usdcVault),
      batchItem(morphoAuthorization(false), morpho),
      batchItem(disableController(), usdcVault),
    ])

    expect(rows).toEqual([
      { label: 'Enable Morpho authorization', assetInfo: undefined },
      { label: 'Withdraw Euler collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Supply collateral to Morpho', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Borrow on Morpho', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.010849' } },
      { label: 'Repay Euler debt', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.000841' } },
      { label: 'Disable Morpho authorization', assetInfo: undefined },
      { label: 'Disable Euler controller', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: undefined } },
    ])
  })

  it('decodes an inbound Aave migration from signed permit and pool payloads', () => {
    const rows = summary([
      batchItem(encodeFunctionData({
        abi: aaveAuthAbi,
        functionName: 'permit',
        args: [account, verifier, collateralAmount, 123n, 27, bytes32Zero, bytes32Zero],
      }), aToken),
      batchItem(enableController(usdcVault)),
      batchItem(enableCollateral(wethVault)),
      batchItem(encodeFunctionData({
        abi: vaultAbi,
        functionName: 'borrow',
        args: [debtBorrowAmount, account],
      }), usdcVault),
      batchItem(swapperMulticall([
        genericSwap(aavePool, usdcAsset, usdcAsset, encodeFunctionData({
          abi: aavePoolAbi,
          functionName: 'repay',
          args: [usdcAsset, debtRepayAmount, 2n, account],
        })),
      ]), swapper),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'transferBalanceFromSender',
        args: [aToken, collateralAmount, swapper],
      })),
      batchItem(swapperMulticall([
        genericSwap(aavePool, wethAsset, wethAsset, encodeFunctionData({
          abi: aavePoolAbi,
          functionName: 'withdraw',
          args: [wethAsset, maxUint256, verifier],
        })),
      ]), swapper),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'verifyAmountMinAndDeposit',
        args: [wethVault, account, collateralAmount, 123n],
      })),
      batchItem(encodeFunctionData({
        abi: swapperAbi,
        functionName: 'repay',
        args: [usdcAsset, usdcVault, debtBorrowAmount, account],
      }), swapper),
    ])

    expect(rows).toEqual([
      { label: 'Apply Aave permit', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Enable controller', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: undefined } },
      { label: 'Enable collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: undefined } },
      { label: 'Borrow on Euler', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.010849' } },
      { label: 'Repay Aave debt', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.000841' } },
      { label: 'Transfer Aave collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Supply collateral to Euler', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
    ])
  })

  it('shows the underlying position amount as an estimate on Metamorpho share permit and transfer steps', () => {
    const shareBalance = 1_400_000_000_000_000_000n
    const steps = migrationSteps([
      batchItem(encodeFunctionData({
        abi: aaveAuthAbi,
        functionName: 'permit',
        args: [account, verifier, shareBalance, 123n, 27, bytes32Zero, bytes32Zero],
      }), metamorphoVault),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'transferBalanceFromSender',
        args: [metamorphoVault, shareBalance, swapper],
      })),
      batchItem(swapperMulticall([
        genericSwap(metamorphoVault, metamorphoVault, usdcAsset, encodeFunctionData({
          abi: vaultAbi,
          functionName: 'redeem',
          args: [shareBalance, verifier, swapper],
        })),
      ]), swapper),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'verifyAmountMinAndDeposit',
        args: [usdcVault, account, 1_500_405n, 123n],
      })),
    ], { ...migrationCtx, amount: '1.500405' })

    expect(steps).toMatchObject([
      { label: 'Apply Morpho vault permit', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.500405', estimated: true } },
      { label: 'Transfer Morpho vault shares', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.500405', estimated: true } },
      { label: 'Supply collateral to Euler', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.500405' } },
    ])
  })

  it('keeps the share transfer estimate when a Metamorpho migration swaps into the target collateral', () => {
    const shareBalance = 1_400_000_000_000_000_000n
    const steps = migrationSteps([
      batchItem(encodeFunctionData({
        abi: aaveAuthAbi,
        functionName: 'permit',
        args: [account, verifier, shareBalance, 123n, 27, bytes32Zero, bytes32Zero],
      }), metamorphoVault),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'transferBalanceFromSender',
        args: [metamorphoVault, shareBalance, swapper],
      })),
      batchItem(swapperMulticall([
        genericSwap(metamorphoVault, metamorphoVault, usdcAsset, encodeFunctionData({
          abi: vaultAbi,
          functionName: 'redeem',
          args: [shareBalance, swapper, swapper],
        })),
        tokenSwap(usdcAsset, wethAsset),
      ]), swapper),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'verifyAmountMinAndDeposit',
        args: [wethVault, account, 377_740_000_000_000n, 123n],
      })),
    ], { ...migrationCtx, amount: '1.500405' })

    expect(steps).toMatchObject([
      { label: 'Apply Morpho vault permit', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.500405', estimated: true } },
      { label: 'Transfer Morpho vault shares', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.500405', estimated: true } },
      {
        label: 'Swap',
        assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.500405', estimated: true },
        toAssetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00037774' },
      },
      { label: 'Verify min received and supply to Euler', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00037774' } },
    ])
  })

  it('decodes an outbound Aave migration from signed delegation and pool payloads', () => {
    const rows = summary([
      batchItem(encodeFunctionData({
        abi: aaveAuthAbi,
        functionName: 'delegationWithSig',
        args: [account, verifier, debtBorrowAmount, 123n, 27, bytes32Zero, bytes32Zero],
      }), variableDebtToken),
      batchItem(encodeFunctionData({
        abi: vaultAbi,
        functionName: 'withdraw',
        args: [collateralAmount, account, account],
      }), wethVault),
      batchItem(swapperMulticall([
        genericSwap(aavePool, wethAsset, wethAsset, encodeFunctionData({
          abi: aavePoolAbi,
          functionName: 'supply',
          args: [wethAsset, collateralAmount, account, 0],
        })),
      ]), swapper),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'aaveBorrowForSender',
        args: [aavePool, usdcAsset, debtBorrowAmount, account],
      })),
      batchItem(encodeFunctionData({
        abi: vaultAbi,
        functionName: 'repay',
        args: [debtRepayAmount, account],
      }), usdcVault),
      batchItem(disableController(), usdcVault),
    ])

    expect(rows).toEqual([
      { label: 'Apply Aave debt delegation', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.010849' } },
      { label: 'Withdraw Euler collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Supply collateral to Aave', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Borrow on Aave', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.010849' } },
      { label: 'Repay Euler debt', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.000841' } },
      { label: 'Disable Euler controller', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: undefined } },
    ])
  })

  it('uses the Aave supply assets for an outbound Aave migration redeemed with Euler shares', () => {
    const sourceShares = 999_900_000_000_000_000n

    const rows = summary([
      batchItem(encodeFunctionData({
        abi: aaveAuthAbi,
        functionName: 'delegationWithSig',
        args: [account, verifier, debtBorrowAmount, 123n, 27, bytes32Zero, bytes32Zero],
      }), variableDebtToken),
      batchItem(encodeFunctionData({
        abi: vaultAbi,
        functionName: 'redeem',
        args: [sourceShares, swapper, account],
      }), wethVault),
      batchItem(swapperMulticall([
        genericSwap(aavePool, wethAsset, wethAsset, encodeFunctionData({
          abi: aavePoolAbi,
          functionName: 'supply',
          args: [wethAsset, collateralAmount, account, 0],
        })),
      ]), swapper),
      batchItem(encodeFunctionData({
        abi: swapVerifierAbi,
        functionName: 'aaveBorrowForSender',
        args: [aavePool, usdcAsset, debtBorrowAmount, account],
      })),
      batchItem(encodeFunctionData({
        abi: vaultAbi,
        functionName: 'repay',
        args: [debtRepayAmount, account],
      }), usdcVault),
      batchItem(disableController(), usdcVault),
    ])

    expect(rows).toEqual([
      { label: 'Apply Aave debt delegation', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.010849' } },
      { label: 'Withdraw Euler collateral', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Supply collateral to Aave', assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00177192' } },
      { label: 'Borrow on Aave', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.010849' } },
      { label: 'Repay Euler debt', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '1.000841' } },
      { label: 'Disable Euler controller', assetInfo: { symbol: 'USDC', address: usdcAsset, amount: undefined } },
    ])
  })
})
