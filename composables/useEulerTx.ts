import type { Address, Hash, Hex, TransactionReceipt } from 'viem'
import type {
  Account,
  CollateralShareSource,
  IHasVaultAddress,
  PlanBorrowArgs,
  PlanDepositArgs,
  PlanRedeemArgs,
  PlanRepayFromDepositArgs,
  PlanRepayFromWalletArgs,
  PlanRepayWithSwapArgs,
  PlanSwapAndBorrowFromWalletArgs,
  PlanSwapAndRepayFromWalletArgs,
  PlanSwapCollateralArgs,
  PlanSwapDebtArgs,
  PlanSwapFromWalletArgs,
  PlanDepositWithSwapFromWalletArgs,
  PlanWithdrawAndSwapArgs,
  PlanRedeemAndSwapArgs,
  PlanWithdrawArgs,
  PlanMigrateSameAssetCollateralArgs,
  PlanMigrateSameAssetDebtArgs,
  PlanMultiplyWithSwapArgs,
  PlanMultiplySameAssetArgs,
  PlanTransferArgs,
  SwapperMode,
  TransactionPlan,
  TransactionPlanExecutionProgress,
  TransactionPlanPrepared,
  WrappedNativeInfo, SwapQuote,
} from '@eulerxyz/euler-v2-sdk'
import { useConfig, useSendTransaction, useSignTypedData } from '@wagmi/vue'
import { getAccount } from '@wagmi/vue/actions'
import { getEulerSdk, getEulerSdkFresh } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'
import { invalidateSdkQueries, PLAN_CRITICAL_QUERIES } from '~/utils/sdk-query-cache'
import { waitForSubgraphBlock } from '~/utils/subgraph'

const OKX_POST_APPROVE_DELAY_MS = 3000
const ERC20_APPROVE_SELECTOR = '0x095ea7b3'

const isOkxWallet = async (connector?: { id?: string, name?: string, getProvider?: () => Promise<unknown> }) => {
  if (!connector) return false
  const id = connector.id?.toLowerCase() ?? ''
  const name = connector.name?.toLowerCase() ?? ''
  if (id === 'okx' || name.includes('okx')) return true
  if (id === 'walletconnect' && connector.getProvider) {
    try {
      const provider = await connector.getProvider() as { session?: { peer?: { metadata?: { name?: string } } } }
      const peerName = provider?.session?.peer?.metadata?.name?.toLowerCase() ?? ''
      return peerName.includes('okx')
    }
    catch {
      return false
    }
  }
  return false
}

export interface PlanDepositInput {
  vaultAddress: Address
  assetAddress: Address
  amount: bigint
  receiver?: Address
  enableCollateral?: boolean
  wrappedNativeInfo?: WrappedNativeInfo
}

export interface PlanWithdrawInput {
  vaultAddress: Address
  assets: bigint
  owner: Address
  receiver?: Address
  disableCollateral?: boolean
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export type PlanRedeemInput = {
  vaultAddress: Address
  owner: Address
  receiver?: Address
  disableCollateral?: boolean
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
} & ({ shares: bigint, assets?: never } | { assets: bigint, shares?: never })

export interface PlanBorrowInput {
  vaultAddress: Address
  amount: bigint
  borrowAccount: Address
  receiver?: Address
  collateral?: {
    vault: Address
    amount: bigint
    asset: Address
    source?: 'wallet'
    wrappedNativeInfo?: WrappedNativeInfo
  } | {
    vault: Address
    amount: bigint
    source: 'savings'
    from: Address
    disableCollateralFrom?: boolean
  }
}

export interface PlanRepayFromWalletInput {
  liabilityVault: Address
  liabilityAmount: bigint
  receiver: Address
  cleanupOnMax?: boolean
}

export interface PlanRepayFromDepositInput {
  liabilityVault: Address
  liabilityAmount: bigint
  receiver: Address
  fromVault: Address
  fromAccount: Address
  cleanupOnMax?: boolean
}

export interface PlanRepayWithSwapInput {
  swapQuote: SwapQuote
  cleanupOnMax?: boolean
  swapperMode?: SwapperMode
}

export interface PlanDepositWithSwapInput {
  swapQuote: SwapQuote
  amount: bigint
  tokenIn: Address
  enableCollateral?: boolean
  wrappedNativeInfo?: WrappedNativeInfo
}

export interface PlanSwapFromWalletInput {
  swapQuote: SwapQuote
  amount: bigint
  tokenIn: Address
  wrappedNativeInfo?: WrappedNativeInfo
}

export interface PlanSwapCollateralInput {
  swapQuote: SwapQuote
  swapperMode?: SwapperMode
}

export interface PlanSwapDebtInput {
  swapQuote: SwapQuote
  swapperMode?: SwapperMode
}

export interface PlanSwapAndBorrowInput {
  swapQuote: SwapQuote
  amount: bigint
  tokenIn: Address
  borrowVault: Address
  borrowAmount: bigint
  borrowAccount?: Address
  collateralVault?: Address
  receiver?: Address
  wrappedNativeInfo?: WrappedNativeInfo
}

export interface PlanSwapAndRepayInput {
  swapQuote: SwapQuote
  amount: bigint
  tokenIn: Address
  liabilityVault?: Address
  repayAccount?: Address
  isMax?: boolean
  cleanupOnMax?: boolean
  wrappedNativeInfo?: WrappedNativeInfo
}

export interface PlanWithdrawAndSwapInput {
  swapQuote: SwapQuote
  vaultAddress: Address
  assets: bigint
  owner: Address
  account?: Account<IHasVaultAddress>
}

export interface PlanRedeemAndSwapInput {
  swapQuote: SwapQuote
  vaultAddress: Address
  shares: bigint
  owner: Address
  account?: Account<IHasVaultAddress>
}

export interface PlanMigrateSameAssetCollateralInput {
  fromVault: Address
  toVault: Address
  amount: bigint
  positionAccount: Address
  fromAsset?: Address
  toAsset: Address
  isMax?: boolean
  maxShares?: bigint
  enableCollateralTo?: boolean
  disableCollateralFrom?: boolean
}

export interface PlanMigrateSameAssetDebtInput {
  oldLiabilityVault: Address
  newLiabilityVault: Address
  liabilityAccount: Address
  liabilityAmount?: bigint
  oldLiabilityAsset?: Address
  newLiabilityAsset: Address
  sweepExcess?: boolean
  transferRemainingSharesToOwner?: boolean
}

export interface PlanMultiplyWithSwapInput {
  collateralVault: Address
  collateralAmount: bigint
  collateralAsset: Address
  collateralShareSource?: CollateralShareSource
  collateralWrappedNativeInfo?: WrappedNativeInfo
  swapQuote: SwapQuote
  swapperMode?: SwapperMode
}

export interface PlanMultiplySameAssetInput {
  collateralVault: Address
  collateralAmount: bigint
  collateralAsset: Address
  collateralShareSource?: CollateralShareSource
  collateralWrappedNativeInfo?: WrappedNativeInfo
  longVault: Address
  liabilityVault: Address
  liabilityAmount: bigint
  receiver: Address
}

export interface PlanTransferInput {
  vaultAddress: Address
  from: Address
  to: Address
  amount: bigint
  enableCollateralTo?: boolean
  disableCollateralFrom?: boolean
}

export interface PlanCleanupInput {
  subAccount: Address
}

// ---------------------------------------------------------------------------
// Combined helpers — these encapsulate the "same-asset vs swap" branch that
// every caller would otherwise reproduce. When a `swapQuote` is provided, the
// cross-asset SDK planner is used; otherwise the same-asset planner is used
// with the explicit vault/account fields. Callers pass all the fields and the
// helper picks. This removes the inline ternary from every call site.
// ---------------------------------------------------------------------------

export interface PlanMultiplyInput {
  collateralVault: Address
  collateralAmount: bigint
  collateralAsset: Address
  collateralShareSource?: CollateralShareSource
  collateralWrappedNativeInfo?: WrappedNativeInfo
  // Same-asset path (used when swapQuote is absent). For the swap path these
  // are encoded in the quote and ignored here.
  longVault: Address
  liabilityVault: Address
  liabilityAmount: bigint
  receiver: Address
  // Swap path
  swapQuote?: SwapQuote
  swapperMode?: SwapperMode
}

export interface PlanRepayFromSourceInput {
  // Same-asset path (used when swapQuote is absent). For the swap path these
  // are encoded in the quote and ignored here.
  liabilityVault: Address
  liabilityAmount: bigint
  receiver: Address
  fromVault: Address
  fromAccount: Address
  // Swap path
  swapQuote?: SwapQuote
  swapperMode?: SwapperMode
  cleanupOnMax?: boolean
}

export interface PlanCollateralChangeInput {
  // Same-asset path (used when swapQuote is absent).
  fromVault: Address
  toVault: Address
  amount: bigint
  positionAccount: Address
  fromAsset?: Address
  toAsset: Address
  isMax?: boolean
  maxShares?: bigint
  enableCollateralTo?: boolean
  disableCollateralFrom?: boolean
  // Swap path
  swapQuote?: SwapQuote
  swapperMode?: SwapperMode
}

export interface PlanDebtChangeInput {
  // Same-asset path (used when swapQuote is absent).
  oldLiabilityVault: Address
  newLiabilityVault: Address
  liabilityAccount: Address
  liabilityAmount?: bigint
  oldLiabilityAsset?: Address
  newLiabilityAsset: Address
  sweepExcess?: boolean
  transferRemainingSharesToOwner?: boolean
  // Swap path
  swapQuote?: SwapQuote
  swapperMode?: SwapperMode
}

export interface PlanWithdrawOrRedeemInput {
  vaultAddress: Address
  owner: Address
  receiver?: Address
  disableCollateral?: boolean
  // When `isMax` is true and `shares` is provided, redeems exactly those shares
  // (so dust isn't left behind). Otherwise withdraws `assets`.
  assets?: bigint
  shares?: bigint
  isMax?: boolean
  // When set, output is swapped: planRedeemAndSwap (max) or planWithdrawAndSwap (partial).
  swapQuote?: SwapQuote
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export const useEulerTx = () => {
  const { address: walletAddress, chainId: wagmiChainId } = useWagmi()
  const { isSpyMode, spyAddress } = useSpyMode()
  const { permit2Enabled } = usePermit2Preference()
  const { SUBGRAPH_URL } = useEulerConfig()
  const { sendTransactionAsync } = useSendTransaction()
  const { signTypedDataAsync } = useSignTypedData()
  const config = useConfig()
  const { triggerPortfolioRefresh } = usePortfolioRefresh()
  const { chainId: addressesChainId } = useEulerAddresses()

  const address = computed(() => (isSpyMode.value ? (spyAddress.value as Address | undefined) : walletAddress.value as Address | undefined))
  // In spy mode the wallet's chain is undefined; fall back to the chain the
  // user is browsing (driven by the `?network=` query → useEulerAddresses).
  const chainId = computed(() => wagmiChainId.value ?? addressesChainId.value)

  const requireOwner = (): Address => {
    if (!address.value) throw new Error('Wallet not connected')
    return address.value
  }
  const requireChainId = (): number => {
    if (!chainId.value) throw new Error('Chain not connected')
    return chainId.value
  }

  /**
   * Resolve a plan-time SDK + Account pair.
   *
   * Uses the "fresh" SDK (always on-chain adapters, zero stale time on
   * plan-critical reads). When the caller provides a pre-fetched Account
   * (typically from `useFreshAccount`'s race-replace cache), it's reused
   * verbatim — no plan-time `fetchAccount` round-trip. Otherwise the Account
   * is fetched live so totalShares/totalAssets for asset/share conversion,
   * sub-account positions for `getPosition`, controller flags for
   * `isControllerEnabled`, etc. reflect the latest block.
   *
   * Cheap reads in this fetch path (labels, ABIs, deployments, prices) still
   * hit the QueryClient cache shared with the fast SDK, so the extra RPC
   * cost is bounded to the position-critical queries.
   */
  const freshPlanContext = async (preloaded?: Account<IHasVaultAddress>) => {
    const owner = requireOwner()
    const cid = requireChainId()
    const sdk = await getEulerSdkFresh()
    if (preloaded) return { sdk, account: preloaded }
    const fetched = await sdk.accountService.fetchAccount(cid, owner)
    return { sdk, account: fetched.result }
  }

  const planDeposit = async (input: PlanDepositInput): Promise<TransactionPlan> => {
    const owner = requireOwner()
    const { sdk, account } = await freshPlanContext()
    const args: PlanDepositArgs = {
      account,
      vault: input.vaultAddress,
      asset: input.assetAddress,
      amount: input.amount,
      receiver: input.receiver ?? owner,
      enableCollateral: input.enableCollateral,
      wrappedNativeInfo: input.wrappedNativeInfo,
    }
    return sdk.executionService.planDeposit(args)
  }

  const planWithdraw = async (input: PlanWithdrawInput): Promise<TransactionPlan> => {
    const owner = requireOwner()
    const { sdk, account } = await freshPlanContext(input.account)
    const args: PlanWithdrawArgs = {
      account,
      vault: input.vaultAddress,
      assets: input.assets,
      owner: input.owner,
      receiver: input.receiver ?? owner,
      disableCollateral: input.disableCollateral,
    }
    return sdk.executionService.planWithdraw(args)
  }

  const planRedeem = async (input: PlanRedeemInput): Promise<TransactionPlan> => {
    const owner = requireOwner()
    const { sdk, account } = await freshPlanContext(input.account)
    const base = {
      account,
      vault: input.vaultAddress,
      owner: input.owner,
      receiver: input.receiver ?? owner,
      disableCollateral: input.disableCollateral,
    }
    const args: PlanRedeemArgs = 'shares' in input && input.shares !== undefined
      ? { ...base, shares: input.shares }
      : { ...base, assets: (input as { assets: bigint }).assets }
    return sdk.executionService.planRedeem(args)
  }

  const planBorrow = async (input: PlanBorrowInput): Promise<TransactionPlan> => {
    const owner = requireOwner()
    const { sdk, account } = await freshPlanContext()
    const args: PlanBorrowArgs = {
      account,
      vault: input.vaultAddress,
      amount: input.amount,
      borrowAccount: input.borrowAccount,
      receiver: input.receiver ?? owner,
      collateral: input.collateral,
    }
    return sdk.executionService.planBorrow(args)
  }

  const planRepayFromWallet = async (input: PlanRepayFromWalletInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanRepayFromWalletArgs = {
      account,
      liabilityVault: input.liabilityVault,
      liabilityAmount: input.liabilityAmount,
      receiver: input.receiver,
      cleanupOnMax: input.cleanupOnMax,
    }
    return sdk.executionService.planRepayFromWallet(args)
  }

  const planRepayFromDeposit = async (input: PlanRepayFromDepositInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanRepayFromDepositArgs = {
      account,
      liabilityVault: input.liabilityVault,
      liabilityAmount: input.liabilityAmount,
      receiver: input.receiver,
      fromVault: input.fromVault,
      fromAccount: input.fromAccount,
      cleanupOnMax: input.cleanupOnMax,
    }
    return sdk.executionService.planRepayFromDeposit(args)
  }

  const planRepayWithSwap = async (input: PlanRepayWithSwapInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanRepayWithSwapArgs = {
      account,
      swapQuote: input.swapQuote,
      cleanupOnMax: input.cleanupOnMax,
      swapperMode: input.swapperMode,
    }
    return sdk.executionService.planRepayWithSwap(args)
  }

  const planDepositWithSwap = async (input: PlanDepositWithSwapInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanDepositWithSwapFromWalletArgs = {
      account,
      swapQuote: input.swapQuote,
      amount: input.amount,
      tokenIn: input.tokenIn,
      enableCollateral: input.enableCollateral,
      wrappedNativeInfo: input.wrappedNativeInfo,
    }
    return sdk.executionService.planDepositWithSwapFromWallet(args)
  }

  const planSwapFromWallet = async (input: PlanSwapFromWalletInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanSwapFromWalletArgs = {
      account,
      swapQuote: input.swapQuote,
      amount: input.amount,
      tokenIn: input.tokenIn,
      wrappedNativeInfo: input.wrappedNativeInfo,
    }
    return sdk.executionService.planSwapFromWallet(args)
  }

  const planSwapCollateral = async (input: PlanSwapCollateralInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanSwapCollateralArgs = {
      account,
      swapQuote: input.swapQuote,
      swapperMode: input.swapperMode,
    }
    return sdk.executionService.planSwapCollateral(args)
  }

  const planSwapDebt = async (input: PlanSwapDebtInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanSwapDebtArgs = {
      account,
      swapQuote: input.swapQuote,
      swapperMode: input.swapperMode,
    }
    return sdk.executionService.planSwapDebt(args)
  }

  const planSwapAndBorrow = async (input: PlanSwapAndBorrowInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanSwapAndBorrowFromWalletArgs = {
      account,
      swapQuote: input.swapQuote,
      amount: input.amount,
      tokenIn: input.tokenIn,
      borrowVault: input.borrowVault,
      borrowAmount: input.borrowAmount,
      borrowAccount: input.borrowAccount,
      collateralVault: input.collateralVault,
      receiver: input.receiver,
      wrappedNativeInfo: input.wrappedNativeInfo,
    }
    return sdk.executionService.planSwapAndBorrowFromWallet(args)
  }

  const planSwapAndRepay = async (input: PlanSwapAndRepayInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanSwapAndRepayFromWalletArgs = {
      account,
      swapQuote: input.swapQuote,
      amount: input.amount,
      tokenIn: input.tokenIn,
      liabilityVault: input.liabilityVault,
      repayAccount: input.repayAccount,
      isMax: input.isMax,
      cleanupOnMax: input.cleanupOnMax,
      wrappedNativeInfo: input.wrappedNativeInfo,
    }
    return sdk.executionService.planSwapAndRepayFromWallet(args)
  }

  const planWithdrawAndSwap = async (input: PlanWithdrawAndSwapInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext(input.account)
    const args: PlanWithdrawAndSwapArgs = {
      account,
      vault: input.vaultAddress,
      assets: input.assets,
      owner: input.owner,
      swapQuote: input.swapQuote,
    }
    return sdk.executionService.planWithdrawAndSwap(args)
  }

  const planRedeemAndSwap = async (input: PlanRedeemAndSwapInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext(input.account)
    const args: PlanRedeemAndSwapArgs = {
      account,
      vault: input.vaultAddress,
      shares: input.shares,
      owner: input.owner,
      swapQuote: input.swapQuote,
    }
    return sdk.executionService.planRedeemAndSwap(args)
  }

  const planMigrateSameAssetCollateral = async (input: PlanMigrateSameAssetCollateralInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanMigrateSameAssetCollateralArgs = {
      account,
      fromVault: input.fromVault,
      toVault: input.toVault,
      amount: input.amount,
      positionAccount: input.positionAccount,
      fromAsset: input.fromAsset,
      toAsset: input.toAsset,
      isMax: input.isMax,
      maxShares: input.maxShares,
      enableCollateralTo: input.enableCollateralTo,
      disableCollateralFrom: input.disableCollateralFrom,
    }
    return sdk.executionService.planMigrateSameAssetCollateral(args)
  }

  const planMigrateSameAssetDebt = async (input: PlanMigrateSameAssetDebtInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanMigrateSameAssetDebtArgs = {
      account,
      oldLiabilityVault: input.oldLiabilityVault,
      newLiabilityVault: input.newLiabilityVault,
      liabilityAccount: input.liabilityAccount,
      liabilityAmount: input.liabilityAmount,
      oldLiabilityAsset: input.oldLiabilityAsset,
      newLiabilityAsset: input.newLiabilityAsset,
      sweepExcess: input.sweepExcess,
      transferRemainingSharesToOwner: input.transferRemainingSharesToOwner,
    }
    return sdk.executionService.planMigrateSameAssetDebt(args)
  }

  const planMultiplyWithSwap = async (input: PlanMultiplyWithSwapInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanMultiplyWithSwapArgs = {
      account,
      collateralVault: input.collateralVault,
      collateralAmount: input.collateralAmount,
      collateralAsset: input.collateralAsset,
      collateralShareSource: input.collateralShareSource,
      collateralWrappedNativeInfo: input.collateralWrappedNativeInfo,
      swapQuote: input.swapQuote,
      swapperMode: input.swapperMode,
    }
    return sdk.executionService.planMultiplyWithSwap(args)
  }

  const planMultiplySameAsset = async (input: PlanMultiplySameAssetInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanMultiplySameAssetArgs = {
      account,
      collateralVault: input.collateralVault,
      collateralAmount: input.collateralAmount,
      collateralAsset: input.collateralAsset,
      collateralShareSource: input.collateralShareSource,
      collateralWrappedNativeInfo: input.collateralWrappedNativeInfo,
      longVault: input.longVault,
      liabilityVault: input.liabilityVault,
      liabilityAmount: input.liabilityAmount,
      receiver: input.receiver,
    }
    return sdk.executionService.planMultiplySameAsset(args)
  }

  const planTransfer = async (input: PlanTransferInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    const args: PlanTransferArgs = {
      account,
      vault: input.vaultAddress,
      from: input.from,
      to: input.to,
      amount: input.amount,
      enableCollateralTo: input.enableCollateralTo,
      disableCollateralFrom: input.disableCollateralFrom,
    }
    return sdk.executionService.planTransfer(args)
  }

  const planCleanup = async (input: PlanCleanupInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext()
    return sdk.executionService.planCleanup({
      account,
      subAccount: input.subAccount,
    })
  }

  // ---------------------------------------------------------------------------
  // Combined helpers — branch on `swapQuote` (or `isMax`) and delegate to the
  // appropriate underlying SDK planner. Call sites should prefer these over
  // doing the branch inline.
  // ---------------------------------------------------------------------------

  const planMultiply = (input: PlanMultiplyInput): Promise<TransactionPlan> => {
    if (input.swapQuote) {
      return planMultiplyWithSwap({
        collateralVault: input.collateralVault,
        collateralAmount: input.collateralAmount,
        collateralAsset: input.collateralAsset,
        collateralShareSource: input.collateralShareSource,
        collateralWrappedNativeInfo: input.collateralWrappedNativeInfo,
        swapQuote: input.swapQuote,
        swapperMode: input.swapperMode,
      })
    }
    return planMultiplySameAsset({
      collateralVault: input.collateralVault,
      collateralAmount: input.collateralAmount,
      collateralAsset: input.collateralAsset,
      collateralShareSource: input.collateralShareSource,
      collateralWrappedNativeInfo: input.collateralWrappedNativeInfo,
      longVault: input.longVault,
      liabilityVault: input.liabilityVault,
      liabilityAmount: input.liabilityAmount,
      receiver: input.receiver,
    })
  }

  const planRepayFromSource = (input: PlanRepayFromSourceInput): Promise<TransactionPlan> => {
    if (input.swapQuote) {
      return planRepayWithSwap({
        swapQuote: input.swapQuote,
        swapperMode: input.swapperMode,
        cleanupOnMax: input.cleanupOnMax,
      })
    }
    return planRepayFromDeposit({
      liabilityVault: input.liabilityVault,
      liabilityAmount: input.liabilityAmount,
      receiver: input.receiver,
      fromVault: input.fromVault,
      fromAccount: input.fromAccount,
      cleanupOnMax: input.cleanupOnMax,
    })
  }

  const planCollateralChange = (input: PlanCollateralChangeInput): Promise<TransactionPlan> => {
    if (input.swapQuote) {
      return planSwapCollateral({
        swapQuote: input.swapQuote,
        swapperMode: input.swapperMode,
      })
    }
    return planMigrateSameAssetCollateral({
      fromVault: input.fromVault,
      toVault: input.toVault,
      amount: input.amount,
      positionAccount: input.positionAccount,
      fromAsset: input.fromAsset,
      toAsset: input.toAsset,
      isMax: input.isMax,
      maxShares: input.maxShares,
      enableCollateralTo: input.enableCollateralTo,
      disableCollateralFrom: input.disableCollateralFrom,
    })
  }

  const planDebtChange = (input: PlanDebtChangeInput): Promise<TransactionPlan> => {
    if (input.swapQuote) {
      return planSwapDebt({
        swapQuote: input.swapQuote,
        swapperMode: input.swapperMode,
      })
    }
    return planMigrateSameAssetDebt({
      oldLiabilityVault: input.oldLiabilityVault,
      newLiabilityVault: input.newLiabilityVault,
      liabilityAccount: input.liabilityAccount,
      liabilityAmount: input.liabilityAmount,
      oldLiabilityAsset: input.oldLiabilityAsset,
      newLiabilityAsset: input.newLiabilityAsset,
      sweepExcess: input.sweepExcess,
      transferRemainingSharesToOwner: input.transferRemainingSharesToOwner,
    })
  }

  const planWithdrawOrRedeem = (input: PlanWithdrawOrRedeemInput): Promise<TransactionPlan> => {
    if (input.isMax) {
      if (input.shares === undefined) {
        throw new Error('planWithdrawOrRedeem: isMax requires shares')
      }
      if (input.swapQuote) {
        return planRedeemAndSwap({
          swapQuote: input.swapQuote,
          vaultAddress: input.vaultAddress,
          shares: input.shares,
          owner: input.owner,
          account: input.account,
        })
      }
      return planRedeem({
        vaultAddress: input.vaultAddress,
        owner: input.owner,
        receiver: input.receiver,
        disableCollateral: input.disableCollateral,
        shares: input.shares,
        account: input.account,
      })
    }
    if (input.assets === undefined) {
      throw new Error('planWithdrawOrRedeem: non-max requires assets')
    }
    if (input.swapQuote) {
      return planWithdrawAndSwap({
        swapQuote: input.swapQuote,
        vaultAddress: input.vaultAddress,
        assets: input.assets,
        owner: input.owner,
        account: input.account,
      })
    }
    return planWithdraw({
      vaultAddress: input.vaultAddress,
      owner: input.owner,
      receiver: input.receiver,
      disableCollateral: input.disableCollateral,
      assets: input.assets,
      account: input.account,
    })
  }

  // Returns the SDK's structured SimulateBatchResult unchanged. Consumers must
  // inspect `result.canExecute` and format failures via `formatSimulationFailure`
  // (see utils/tx-errors). Throwing here would flatten the SDK's chained
  // DecodedSmartContractError + insufficiency diagnostics into a bare string.
  const simulatePlan = async (plan: TransactionPlan) => {
    const owner = requireOwner()
    const cid = requireChainId()
    // Simulate via the fresh SDK so the internal state-override / batch
    // simulation reads pick up live chain state. simulateTransactionPlan runs
    // processPlanPlugins internally — TOS and Keyring items are injected by
    // the SDK; Lite no longer mutates plans here.
    const sdk = await getEulerSdkFresh()
    const result = await sdk.executionService.simulateTransactionPlan(
      cid,
      owner,
      plan,
      { stateOverrides: true },
    )
    return result
  }

  /**
   * Run plugins + resolve required approvals once and return the prepared
   * envelope. Subsequent simulate/execute calls take the envelope and skip the
   * internal plugin pipeline — net effect: plugin reads (TOS / Keyring / Pyth)
   * run exactly once per Review click instead of three times.
   *
   * Uses the **fast** SDK so the plugin's vault/account/oracle-adapter reads
   * hit the shared QueryClient cache populated by `useFreshAccount` at mount
   * and refreshed by `invalidateSdkQueries(PLAN_CRITICAL_QUERIES)` post-tx.
   * Time-sensitive Pyth/balance/allowance queries keep their short stale times
   * either way.
   */
  const prepareTransactionPlan = async (
    plan: TransactionPlan,
    options?: { account?: Account<IHasVaultAddress> },
  ): Promise<TransactionPlanPrepared> => {
    const owner = requireOwner()
    const cid = requireChainId()
    const sdk = await getEulerSdk()
    return sdk.executionService.prepareTransactionPlan({
      plan,
      chainId: cid,
      account: options?.account ?? owner,
      usePermit2: permit2Enabled.value,
    })
  }

  const simulatePreparedPlan = async (prepared: TransactionPlanPrepared) => {
    // Same rationale as prepareTransactionPlan: route through fast SDK so the
    // simulate-internal vault-type lookups + state-override reads hit cache.
    // The actual EVC batch eth_call (queryBatchSimulation) is still effectively
    // uncached because its cache key includes the plan's encoded calldata.
    const sdk = await getEulerSdk()
    return sdk.executionService.simulatePreparedTransactionPlan(prepared, {
      stateOverrides: true,
    })
  }

  const buildSendTransaction = (isOkx: boolean) => {
    let okxDelayPending = false
    const send = async ({ to, data, value }: { to: Address, data: Hex, value?: bigint }) => {
      if (okxDelayPending) {
        await new Promise(r => setTimeout(r, OKX_POST_APPROVE_DELAY_MS))
        okxDelayPending = false
      }
      const hash = await sendTransactionAsync({
        to,
        data: data as Hex,
        value: value ?? 0n,
      })
      if (isOkx && (data as Hex).toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) {
        okxDelayPending = true
      }
      return hash as Hash
    }
    return send
  }

  const finalizeExecution = (result: { receipts: TransactionReceipt[] }) => {
    let lastReceipt: TransactionReceipt | undefined
    if (result.receipts.length) {
      lastReceipt = result.receipts[result.receipts.length - 1]
    }
    // Mark plan-critical queries stale so the next Review-click after this tx
    // pulls fresh vault/account/factory state. The bumped 5-min staleTime
    // would otherwise serve cached pre-tx state into the new plan.
    // `triggerPortfolioRefresh` re-drives the rich portfolio data that the
    // portfolio page renders; the two are complementary.
    void invalidateSdkQueries([...PLAN_CRITICAL_QUERIES])
    triggerPortfolioRefresh()
    if (lastReceipt && SUBGRAPH_URL) {
      void waitForSubgraphBlock(SUBGRAPH_URL, lastReceipt.blockNumber)
        .then((caughtUp) => {
          if (caughtUp) {
            void invalidateSdkQueries([...PLAN_CRITICAL_QUERIES])
            triggerPortfolioRefresh()
          }
        })
        .catch(err => logWarn('useEulerTx/subgraphPoll', err))
    }
  }

  const executePlan = async (plan: TransactionPlan) => {
    if (isSpyMode.value) {
      throw new Error('Transactions are disabled in spy mode')
    }
    const owner = requireOwner()
    const cid = requireChainId()
    // Execute via the fresh SDK so the in-flight allowance / Permit2 reads
    // and post-tx wait-for-receipts use the on-chain path.
    // executeTransactionPlan runs processPlanPlugins internally for TOS/Keyring.
    const sdk = await getEulerSdkFresh()

    const isOkx = await isOkxWallet(getAccount(config).connector)
    const sendTransaction = buildSendTransaction(isOkx)

    const result = await sdk.executionService.executeTransactionPlan({
      plan,
      chainId: cid,
      account: owner,
      usePermit2: permit2Enabled.value,
      sendTransaction,
      signTypedData: async (typedData) => {
        const signature = await signTypedDataAsync(typedData as unknown as Parameters<typeof signTypedDataAsync>[0])
        return signature as Hex
      },
      onProgress: (_progress: TransactionPlanExecutionProgress) => {},
    })

    finalizeExecution(result)
    return result
  }

  const executePreparedPlan = async (prepared: TransactionPlanPrepared) => {
    if (isSpyMode.value) {
      throw new Error('Transactions are disabled in spy mode')
    }
    const sdk = await getEulerSdkFresh()
    const isOkx = await isOkxWallet(getAccount(config).connector)
    const sendTransaction = buildSendTransaction(isOkx)

    const result = await sdk.executionService.executePreparedTransactionPlan({
      prepared,
      sendTransaction,
      signTypedData: async (typedData) => {
        const signature = await signTypedDataAsync(typedData as unknown as Parameters<typeof signTypedDataAsync>[0])
        return signature as Hex
      },
      onProgress: (_progress: TransactionPlanExecutionProgress) => {},
    })

    finalizeExecution(result)
    return result
  }

  return {
    planDeposit,
    planWithdraw,
    planRedeem,
    planBorrow,
    planRepayFromWallet,
    planRepayFromDeposit,
    planRepayWithSwap,
    planDepositWithSwap,
    planSwapFromWallet,
    planSwapCollateral,
    planSwapDebt,
    planSwapAndBorrow,
    planSwapAndRepay,
    planWithdrawAndSwap,
    planRedeemAndSwap,
    planMigrateSameAssetCollateral,
    planMigrateSameAssetDebt,
    planMultiplyWithSwap,
    planMultiplySameAsset,
    planTransfer,
    planCleanup,
    // Combined helpers (preferred at call sites — branch on swapQuote / isMax).
    planMultiply,
    planRepayFromSource,
    planCollateralChange,
    planDebtChange,
    planWithdrawOrRedeem,
    simulatePlan,
    prepareTransactionPlan,
    simulatePreparedPlan,
    executePlan,
    executePreparedPlan,
  }
}
