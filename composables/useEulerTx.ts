import { getAddress, type Address, type Hash, type Hex, type TransactionReceipt } from 'viem'
import type {
  Account,
  CollateralShareSource,
  IHasVaultAddress,
  PluginPrefetchData,
  SimulationStateOverrideOptions,
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
  GetMigrationAuthorizationArgs,
  GetMigrationPositionArgs,
  ListMigrationTargetsArgs,
  MigrationAuthorizationRequest,
  MigrationPosition,
  MigrationTarget,
  PlanMigrationArgs,
  PlanMigrationSimulationResult,
  SignedMigrationAuthorization,
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
import { getEulerSdkForChain, getEulerSdkFresh, buildSubgraphProxyApiPath } from '~/composables/useEulerSdk'
import {
  encodeMigrationAuthorizationTxs,
  type MigrationAuthorizationRevoke,
  type PlainTxRequest,
} from '~/utils/migrationAuthorizationTxs'
import { logWarn } from '~/utils/errorHandling'
import { invalidateSdkQueries } from '~/utils/sdk-query-cache'
import { INVALIDATE_AFTER_TX } from '~/utils/sdk-query-policy'
import { waitForSubgraphBlock } from '~/utils/subgraph'
import { profAsync } from '~/utils/profiler'
import {
  getSafeWalletProvider,
  waitForSafeTransactionExecution,
  type ReceiptClientLike,
} from '~/utils/safeWalletTransactions'
import {
  assertWalletExecutionContext,
  type WalletExecutionContext,
} from '~/utils/walletExecutionContext'

const OKX_POST_APPROVE_DELAY_MS = 3000
const ERC20_APPROVE_SELECTOR = '0x095ea7b3'
const PLACEHOLDER_AUTHORIZATION_SIGNATURE = `0x${'00'.repeat(65)}` as Hex
const SUB_ACCOUNT_SNAPSHOT_FETCH_OPTIONS = {
  populateVaults: false,
  populateMarketPrices: false,
  populateUserRewards: false,
} as const
type PrefetchPluginAccount = Account<IHasVaultAddress> | Address

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
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
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
  skipCleanup?: boolean
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
  /** Caller has already attached the borrow sub-account snapshot to `account`; skip the per-plan refresh. */
  subAccountSnapshotApplied?: boolean
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
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export interface PlanRepayFromDepositInput {
  liabilityVault: Address
  liabilityAmount: bigint
  receiver: Address
  fromVault: Address
  fromAccount: Address
  cleanupOnMax?: boolean
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export interface PlanRepayWithSwapInput {
  swapQuote: SwapQuote
  cleanupOnMax?: boolean
  swapperMode?: SwapperMode
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export interface PlanDepositWithSwapInput {
  swapQuote: SwapQuote
  amount: bigint
  tokenIn: Address
  enableCollateral?: boolean
  wrappedNativeInfo?: WrappedNativeInfo
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export interface PlanSwapFromWalletInput {
  swapQuote: SwapQuote
  amount: bigint
  tokenIn: Address
  wrappedNativeInfo?: WrappedNativeInfo
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export interface PlanSwapCollateralInput {
  swapQuote: SwapQuote
  swapperMode?: SwapperMode
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export interface PlanSwapDebtInput {
  swapQuote: SwapQuote
  swapperMode?: SwapperMode
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
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
  skipCleanup?: boolean
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
  /** Caller has already attached the borrow sub-account snapshot to `account`; skip the per-plan refresh. */
  subAccountSnapshotApplied?: boolean
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
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
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
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
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
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export interface PlanMultiplyWithSwapInput {
  collateralVault: Address
  collateralAmount: bigint
  collateralAsset: Address
  collateralShareSource?: CollateralShareSource
  collateralWrappedNativeInfo?: WrappedNativeInfo
  swapQuote: SwapQuote
  swapperMode?: SwapperMode
  skipCleanup?: boolean
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
  /** Caller has already attached the receiver sub-account snapshot to `account`; skip the per-plan refresh. */
  subAccountSnapshotApplied?: boolean
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
  skipCleanup?: boolean
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
  /** Caller has already attached the receiver sub-account snapshot to `account`; skip the per-plan refresh. */
  subAccountSnapshotApplied?: boolean
}

export interface PlanTransferInput {
  vaultAddress: Address
  from: Address
  to: Address
  amount: bigint
  enableCollateralTo?: boolean
  disableCollateralFrom?: boolean
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export interface PlanCleanupInput {
  subAccount: Address
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
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
  skipCleanup?: boolean
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
  /** Caller has already attached the receiver sub-account snapshot to `account`; skip the per-plan refresh. */
  subAccountSnapshotApplied?: boolean
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
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
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
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
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
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
}

export interface PlanRefinancePositionInput {
  collateral?: Omit<PlanCollateralChangeInput, 'account'>
  debt?: Omit<PlanDebtChangeInput, 'account'>
  /** Pre-fetched account snapshot. When provided, plan construction skips its own freshPlanContext fetch. */
  account?: Account<IHasVaultAddress>
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
  const { signaturesEnabled } = useSignaturePreference()
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
   * Uses the "fresh" SDK (always on-chain adapters, short `FORM_STALE_TIMES`
   * windows on plan-critical reads). When the caller provides a pre-fetched
   * Account (typically from `useFreshAccount`'s race-replace cache), it's
   * reused verbatim — no plan-time `fetchAccount` round-trip. Otherwise the
   * Account is fetched here for totalShares/totalAssets asset/share
   * conversion, sub-account positions for `getPosition`, controller flags for
   * `isControllerEnabled`, etc.
   *
   * That fetch is on-chain-backed but is not a forced refetch: it resolves
   * through the shared QueryClient at each row's form stale time (a minute for
   * `queryAccountVaults`), so a recent snapshot is reused rather than re-read
   * from the latest block. Post-tx `invalidateAfterTx` eviction is what
   * guarantees a re-read after the user's own state changes.
   *
   * Cheap reads in this fetch path (labels, ABIs, deployments, prices) still
   * hit the QueryClient cache shared with the fast SDK, so the extra RPC
   * cost is bounded to the position-critical queries.
   */
  const freshPlanContext = async (preloaded?: Account<IHasVaultAddress>) => {
    const owner = requireOwner()
    const cid = requireChainId()
    const sdk = await profAsync('sdk', 'getEulerSdkFresh', () => getEulerSdkFresh())
    if (preloaded) return { sdk, account: preloaded }
    const fetched = await profAsync('sdk', 'fetchAccount', () => sdk.accountService.fetchAccount(cid, owner))
    return { sdk, account: fetched.result }
  }

  // Refresh the sub-account's position list at plan time. The Account snapshot
  // we plan against (whether freshly fetched or carried over from
  // `useFreshAccount`) reflects the last portfolio refresh — it can include a
  // stale controller flag on the receiver sub-account (e.g. a controller that
  // was disabled after the snapshot was taken). The SDK planners read
  // `isControllerEnabled` to decide whether to emit `enableController` items,
  // so a stale flag here means the plan skips the enable and the EVC batch
  // reverts. Re-fetching the sub-account snapshot lets `setSubAccount` overwrite
  // those flags with on-chain truth. Mirrors prod's pre-plan refresh.
  const attachSubAccountSnapshot = async (
    sdk: Awaited<ReturnType<typeof getEulerSdkFresh>>,
    account: Account<IHasVaultAddress>,
    subAccount: Address,
  ) => {
    const existingSubAccount = account.getSubAccount(getAddress(subAccount))
    const vaults = [
      ...new Set(existingSubAccount?.positions.map(position => getAddress(position.vaultAddress)) ?? []),
    ]
    const fetched = await profAsync('sdk', 'fetchSubAccount', () => sdk.accountService.fetchSubAccount(
      account.chainId,
      getAddress(subAccount),
      vaults,
      SUB_ACCOUNT_SNAPSHOT_FETCH_OPTIONS,
    ), { vaults: vaults.length })
    fetched.errors.forEach(issue => logWarn('useEulerTx/attachSubAccountSnapshot', issue))
    if (fetched.result) {
      account.setSubAccount(
        existingSubAccount && fetched.result.positions.length === 0 && existingSubAccount.positions.length > 0
          ? { ...fetched.result, positions: existingSubAccount.positions }
          : fetched.result,
      )
    }
  }

  const planDeposit = async (input: PlanDepositInput): Promise<TransactionPlan> => {
    const owner = requireOwner()
    const { sdk, account } = await freshPlanContext(input.account)
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
    const { sdk, account } = await freshPlanContext(input.account)
    if (!input.subAccountSnapshotApplied) {
      await attachSubAccountSnapshot(sdk, account, input.borrowAccount)
    }
    const args: PlanBorrowArgs = {
      account,
      vault: input.vaultAddress,
      amount: input.amount,
      borrowAccount: input.borrowAccount,
      receiver: input.receiver ?? owner,
      collateral: input.collateral,
      skipCleanup: input.skipCleanup,
    }
    return sdk.executionService.planBorrow(args)
  }

  const planRepayFromWallet = async (input: PlanRepayFromWalletInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext(input.account)
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
    const { sdk, account } = await freshPlanContext(input.account)
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
    const { sdk, account } = await freshPlanContext(input.account)
    const args: PlanRepayWithSwapArgs = {
      account,
      swapQuote: input.swapQuote,
      cleanupOnMax: input.cleanupOnMax,
      swapperMode: input.swapperMode,
    }
    return sdk.executionService.planRepayWithSwap(args)
  }

  const planDepositWithSwap = async (input: PlanDepositWithSwapInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext(input.account)
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
    const { sdk, account } = await freshPlanContext(input.account)
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
    const { sdk, account } = await freshPlanContext(input.account)
    const args: PlanSwapCollateralArgs = {
      account,
      swapQuote: input.swapQuote,
      swapperMode: input.swapperMode,
    }
    return sdk.executionService.planSwapCollateral(args)
  }

  const planSwapDebt = async (input: PlanSwapDebtInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext(input.account)
    const args: PlanSwapDebtArgs = {
      account,
      swapQuote: input.swapQuote,
      swapperMode: input.swapperMode,
    }
    return sdk.executionService.planSwapDebt(args)
  }

  const planSwapAndBorrow = async (input: PlanSwapAndBorrowInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext(input.account)
    const borrowAccount = input.borrowAccount ?? input.swapQuote.accountOut
    if (!input.subAccountSnapshotApplied) {
      await attachSubAccountSnapshot(sdk, account, borrowAccount)
    }
    const args: PlanSwapAndBorrowFromWalletArgs = {
      account,
      swapQuote: input.swapQuote,
      amount: input.amount,
      tokenIn: input.tokenIn,
      borrowVault: input.borrowVault,
      borrowAmount: input.borrowAmount,
      borrowAccount,
      collateralVault: input.collateralVault,
      receiver: input.receiver,
      wrappedNativeInfo: input.wrappedNativeInfo,
      skipCleanup: input.skipCleanup,
    }
    return sdk.executionService.planSwapAndBorrowFromWallet(args)
  }

  const planSwapAndRepay = async (input: PlanSwapAndRepayInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext(input.account)
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
    const { sdk, account } = await freshPlanContext(input.account)
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
    const { sdk, account } = await freshPlanContext(input.account)
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
    return profAsync('sdk', 'planMultiplyWithSwap.total', async () => {
      const { sdk, account } = await profAsync('sdk', 'planMultiplyWithSwap.freshPlanContext', () => freshPlanContext(input.account))
      if (!input.subAccountSnapshotApplied) {
        await profAsync('sdk', 'planMultiplyWithSwap.attachSubAccount', () => attachSubAccountSnapshot(sdk, account, input.swapQuote.accountIn))
      }
      const args: PlanMultiplyWithSwapArgs = {
        account,
        collateralVault: input.collateralVault,
        collateralAmount: input.collateralAmount,
        collateralAsset: input.collateralAsset,
        collateralShareSource: input.collateralShareSource,
        collateralWrappedNativeInfo: input.collateralWrappedNativeInfo,
        swapQuote: input.swapQuote,
        swapperMode: input.swapperMode,
        skipCleanup: input.skipCleanup,
      }
      return profAsync('sdk', 'planMultiplyWithSwap.sdkCall', async () => sdk.executionService.planMultiplyWithSwap(args))
    })
  }

  const planMultiplySameAsset = async (input: PlanMultiplySameAssetInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext(input.account)
    if (!input.subAccountSnapshotApplied) {
      await attachSubAccountSnapshot(sdk, account, input.receiver)
    }
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
      skipCleanup: input.skipCleanup,
    }
    return sdk.executionService.planMultiplySameAsset(args)
  }

  const planTransfer = async (input: PlanTransferInput): Promise<TransactionPlan> => {
    const { sdk, account } = await freshPlanContext(input.account)
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
    const { sdk, account } = await freshPlanContext(input.account)
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
        skipCleanup: input.skipCleanup,
        account: input.account,
        subAccountSnapshotApplied: input.subAccountSnapshotApplied,
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
      skipCleanup: input.skipCleanup,
      account: input.account,
      subAccountSnapshotApplied: input.subAccountSnapshotApplied,
    })
  }

  const planRepayFromSource = (input: PlanRepayFromSourceInput): Promise<TransactionPlan> => {
    if (input.swapQuote) {
      return planRepayWithSwap({
        swapQuote: input.swapQuote,
        swapperMode: input.swapperMode,
        cleanupOnMax: input.cleanupOnMax,
        account: input.account,
      })
    }
    return planRepayFromDeposit({
      liabilityVault: input.liabilityVault,
      liabilityAmount: input.liabilityAmount,
      receiver: input.receiver,
      fromVault: input.fromVault,
      fromAccount: input.fromAccount,
      cleanupOnMax: input.cleanupOnMax,
      account: input.account,
    })
  }

  const planCollateralChange = (input: PlanCollateralChangeInput): Promise<TransactionPlan> => {
    if (input.swapQuote) {
      return planSwapCollateral({
        swapQuote: input.swapQuote,
        swapperMode: input.swapperMode,
        account: input.account,
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
      account: input.account,
    })
  }

  const planDebtChange = (input: PlanDebtChangeInput): Promise<TransactionPlan> => {
    if (input.swapQuote) {
      return planSwapDebt({
        swapQuote: input.swapQuote,
        swapperMode: input.swapperMode,
        account: input.account,
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
      account: input.account,
    })
  }

  const planRefinancePosition = async (input: PlanRefinancePositionInput): Promise<TransactionPlan> => {
    if (!input.collateral && !input.debt) {
      throw new Error('planRefinancePosition: collateral or debt change is required')
    }

    const { sdk, account } = await freshPlanContext(input.account)
    const plans: TransactionPlan[] = []

    if (input.collateral) {
      plans.push(
        input.collateral.swapQuote
          ? sdk.executionService.planSwapCollateral({
              account,
              swapQuote: input.collateral.swapQuote,
              swapperMode: input.collateral.swapperMode,
            })
          : sdk.executionService.planMigrateSameAssetCollateral({
              account,
              fromVault: input.collateral.fromVault,
              toVault: input.collateral.toVault,
              amount: input.collateral.amount,
              positionAccount: input.collateral.positionAccount,
              fromAsset: input.collateral.fromAsset,
              toAsset: input.collateral.toAsset,
              isMax: input.collateral.isMax,
              maxShares: input.collateral.maxShares,
              enableCollateralTo: input.collateral.enableCollateralTo,
              disableCollateralFrom: input.collateral.disableCollateralFrom,
            }),
      )
    }

    if (input.debt) {
      plans.push(
        input.debt.swapQuote
          ? sdk.executionService.planSwapDebt({
              account,
              swapQuote: input.debt.swapQuote,
              swapperMode: input.debt.swapperMode,
            })
          : sdk.executionService.planMigrateSameAssetDebt({
              account,
              oldLiabilityVault: input.debt.oldLiabilityVault,
              newLiabilityVault: input.debt.newLiabilityVault,
              liabilityAccount: input.debt.liabilityAccount,
              liabilityAmount: input.debt.liabilityAmount,
              oldLiabilityAsset: input.debt.oldLiabilityAsset,
              newLiabilityAsset: input.debt.newLiabilityAsset,
              sweepExcess: input.debt.sweepExcess,
              transferRemainingSharesToOwner: input.debt.transferRemainingSharesToOwner,
            }),
      )
    }

    return sdk.executionService.mergePlans(plans)
  }

  const getMigrationAuthorization = async (input: GetMigrationAuthorizationArgs): Promise<MigrationAuthorizationRequest | undefined> => {
    const sdk = await getEulerSdkFresh()
    return sdk.positionMigrationService.getAuthorization(input)
  }

  const getMigrationPosition = async (input: GetMigrationPositionArgs): Promise<MigrationPosition> => {
    const sdk = await getEulerSdkFresh()
    return sdk.positionMigrationService.getPosition(input)
  }

  const listMigrationTargets = async (input: ListMigrationTargetsArgs): Promise<MigrationTarget[]> => {
    const sdk = await getEulerSdkFresh()
    return sdk.positionMigrationService.listTargets(input)
  }

  const signMigrationAuthorization = async (
    request: MigrationAuthorizationRequest,
  ): Promise<SignedMigrationAuthorization> => {
    if (isSpyMode.value) {
      throw new Error('Authorization signatures are disabled in spy mode')
    }
    if (request.kind !== 'typedData') {
      throw new Error('Transaction-based migration authorization is not supported in this flow')
    }
    const currentAccount = getAccount(config)
    assertWalletExecutionContext({
      expectedAccount: request.owner,
      expectedChainId: request.chainId,
      currentAccount: currentAccount.address,
      currentChainId: currentAccount.chainId,
    })
    const signature = await signTypedDataAsync(request.typedData as unknown as Parameters<typeof signTypedDataAsync>[0])
    const postMigrationAuthorization = request.postMigrationAuthorization
      ? await signMigrationAuthorization(request.postMigrationAuthorization)
      : undefined
    return {
      request,
      signature: signature as Hex,
      ...(postMigrationAuthorization ? { postMigrationAuthorization } : {}),
    }
  }

  const buildPlaceholderMigrationAuthorization = (
    request: MigrationAuthorizationRequest,
  ): SignedMigrationAuthorization => {
    const postMigrationAuthorization = request.postMigrationAuthorization
      ? buildPlaceholderMigrationAuthorization(request.postMigrationAuthorization)
      : undefined

    return {
      request,
      signature: PLACEHOLDER_AUTHORIZATION_SIGNATURE,
      ...(postMigrationAuthorization ? { postMigrationAuthorization } : {}),
    }
  }

  const planCrossProtocolMigration = async (input: PlanMigrationArgs): Promise<TransactionPlan> => {
    const sdk = await getEulerSdkFresh()
    return sdk.positionMigrationService.planMigration(input)
  }

  const planCrossProtocolMigrationSimulation = async (input: PlanMigrationArgs): Promise<PlanMigrationSimulationResult> => {
    const sdk = await getEulerSdkFresh()
    return sdk.positionMigrationService.planMigrationSimulation(input)
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
  const simulatePlan = async (plan: TransactionPlan, stateOverrideOptions?: SimulationStateOverrideOptions) => {
    const owner = requireOwner()
    const cid = requireChainId()
    // Simulate via the fresh SDK so the internal state-override / batch
    // simulation reads pick up live chain state. simulateTransactionPlan runs
    // processPlanPlugins internally — the SDK injects TOS and Keyring items,
    // and Lite passes the plan through unchanged here.
    const sdk = await getEulerSdkFresh()
    const result = await sdk.executionService.simulateTransactionPlan(
      cid,
      owner,
      plan,
      { stateOverrides: true, stateOverrideOptions },
    )
    return result
  }

  /**
   * Run plugins + resolve required approvals once and return the prepared
   * envelope. Subsequent simulate/execute calls take the envelope and skip the
   * internal plugin pipeline — net effect: plugin reads (TOS / Keyring / Pyth)
   * run exactly once per Review click instead of three times.
   *
   * Pass `prefetch` (from `prefetchPluginData`) to short-circuit the plugin's
   * per-call I/O — Pyth Hermes pull, keyring vault-config reads etc. — so
   * per-quote prepare in a sweep is cheap.
   */
  const prepareTransactionPlan = async (
    plan: TransactionPlan,
    options?: {
      account?: PrefetchPluginAccount
      chainId?: number
      prefetch?: PluginPrefetchData
      usePermit2?: boolean
    },
  ): Promise<TransactionPlanPrepared> => {
    return profAsync('sdk', 'prepareTransactionPlan', async () => {
      const owner = requireOwner()
      const cid = options?.chainId ?? requireChainId()
      const sdk = await getEulerSdkForChain(cid)
      return sdk.executionService.prepareTransactionPlan({
        plan,
        chainId: cid,
        account: options?.account ?? owner,
        usePermit2: options?.usePermit2 ?? signaturesEnabled.value,
        prefetch: options?.prefetch,
      })
    })
  }

  // Real on-chain gas estimate for a plan. Throws (with the decoded revert
  // reason) if the transaction would revert, so callers can surface it before
  // asking the user to sign.
  const estimateGasForPlan = async (plan: TransactionPlan): Promise<bigint> => {
    const owner = requireOwner()
    const cid = requireChainId()
    const sdk = await getEulerSdkForChain(cid)
    return sdk.executionService.estimateGasForTransactionPlan(cid, owner, plan)
  }

  /**
   * Resolve each plugin's prefetch payload for a representative plan once per
   * form-load. Pass the returned record to prepare/simulate/estimate via the
   * `prefetch` option so per-quote calls skip Hermes / keyring reads.
   */
  const prefetchPluginData = async (
    plan: TransactionPlan,
    options?: { account?: PrefetchPluginAccount },
  ): Promise<PluginPrefetchData> => {
    return profAsync('sdk', 'prefetchPluginData', async () => {
      const owner = requireOwner()
      const cid = requireChainId()
      const sdk = await getEulerSdkForChain(cid)
      return sdk.executionService.prefetchPluginDataForPlan(
        plan,
        options?.account ?? owner,
        cid,
      )
    })
  }

  const simulatePreparedPlan = async (prepared: TransactionPlanPrepared, stateOverrideOptions?: SimulationStateOverrideOptions) => {
    return profAsync('sdk', 'simulatePreparedTransactionPlan', async () => {
      const sdk = await getEulerSdkForChain(prepared.chainId)
      return sdk.executionService.simulatePreparedTransactionPlan(prepared, {
        stateOverrides: true,
        stateOverrideOptions,
      })
    })
  }

  const buildSendTransaction = ({
    isOkx,
    expectedAccount,
    expectedChainId,
    resolveHash,
  }: {
    isOkx: boolean
    expectedAccount: Address
    expectedChainId: number
    resolveHash?: (hash: Hash) => Promise<Hash>
  }) => {
    let okxDelayPending = false
    const send = async ({ to, data, value }: { to: Address, data: Hex, value?: bigint }) => {
      if (okxDelayPending) {
        await new Promise(r => setTimeout(r, OKX_POST_APPROVE_DELAY_MS))
        okxDelayPending = false
      }
      const currentAccount = getAccount(config)
      assertWalletExecutionContext({
        expectedAccount,
        expectedChainId,
        currentAccount: currentAccount.address,
        currentChainId: currentAccount.chainId,
      })
      const hash = await sendTransactionAsync({
        account: expectedAccount,
        chainId: expectedChainId,
        to,
        data: data as Hex,
        value: value ?? 0n,
      })
      if (isOkx && (data as Hex).toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) {
        okxDelayPending = true
      }
      const submittedHash = hash as Hash
      return resolveHash ? resolveHash(submittedHash) : submittedHash
    }
    return send
  }

  /**
   * Send standalone transactions sequentially, waiting for each to be mined.
   *
   * Used for migration authorization grants and revokes, which cannot live in
   * the EVC batch (the EVC forwards batch items as itself, so a msg.sender-based
   * grant would be attributed to the EVC) and cannot be merged into the plan
   * (`mergePlans` rejects contractCall items).
   */
  const sendPlainTransactions = async (
    txs: readonly PlainTxRequest[],
    options?: {
      onBroadcast?: (index: number, walletContext: WalletExecutionContext) => void
      walletContext?: WalletExecutionContext
    },
  ): Promise<TransactionReceipt[]> => {
    if (isSpyMode.value) {
      throw new Error('Transactions are disabled in spy mode')
    }
    if (!txs.length) return []

    const walletContext = options?.walletContext ?? {
      account: requireOwner(),
      chainId: requireChainId(),
    }
    const owner = walletContext.account
    const cid = walletContext.chainId
    const sdk = await getEulerSdkFresh()
    const provider = sdk.providerService?.getProvider(cid)
    if (!provider) {
      throw new Error('No provider available to confirm the transaction')
    }

    const connector = getAccount(config).connector
    const [isOkx, safeWalletProvider] = await Promise.all([
      isOkxWallet(connector),
      getSafeWalletProvider(connector),
    ])
    const send = buildSendTransaction({
      isOkx,
      expectedAccount: owner,
      expectedChainId: cid,
    })

    const receipts: TransactionReceipt[] = []
    let lastBroadcastData: Hex | undefined
    try {
      for (const [index, tx] of txs.entries()) {
        const hash = await send(tx)
        lastBroadcastData = tx.data
        // Once a hash exists the transaction may land even if receipt polling
        // fails, so cleanup must start tracking it before awaiting confirmation.
        options?.onBroadcast?.(index, walletContext)
        const receipt = safeWalletProvider
          ? (await waitForSafeTransactionExecution({
              submittedHash: hash,
              walletProvider: safeWalletProvider,
              publicClient: provider,
            })).receipt
          : await provider.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') {
          throw new Error('Authorization transaction reverted')
        }
        receipts.push(receipt)
      }
    }
    finally {
      // buildSendTransaction only applies its post-approve delay to the next send
      // from the same closure. The batch or abort cleanup builds another closure,
      // so flush a trailing broadcast approve even when receipt polling failed.
      if (isOkx && lastBroadcastData?.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) {
        await new Promise(r => setTimeout(r, OKX_POST_APPROVE_DELAY_MS))
      }
    }

    return receipts
  }

  /**
   * Grant a migration authorization on-chain instead of signing it, and return
   * the revoke transactions to send once the batch has settled.
   *
   * The grants must be mined before the migration plan is built: the SDK
   * connectors read the live allowance to decide whether the batch needs a
   * permit item, and throw when it does but no signature was supplied.
   */
  const executeMigrationAuthorizationGrants = async (
    request: MigrationAuthorizationRequest,
    broadcastRevokes: MigrationAuthorizationRevoke[] = [],
  ): Promise<MigrationAuthorizationRevoke[]> => {
    const { grants, revokesByGrant } = encodeMigrationAuthorizationTxs(request)
    await sendPlainTransactions(grants, {
      // The request was prepared for this exact owner/network. Do not let a
      // wallet switch during the preceding SDK reads retarget the grant.
      walletContext: { account: request.owner, chainId: request.chainId },
      onBroadcast: (index, walletContext) => {
        const revoke = revokesByGrant[index]
        if (revoke) {
          broadcastRevokes.unshift({ transaction: revoke, walletContext })
        }
      },
    })
    return broadcastRevokes
  }

  /** Attempt every revoke and return the successful and failed subsets. */
  const sendMigrationAuthorizationRevokes = async (
    revokes: readonly MigrationAuthorizationRevoke[],
  ): Promise<{
    restored: MigrationAuthorizationRevoke[]
    failed: MigrationAuthorizationRevoke[]
  }> => {
    const restored: MigrationAuthorizationRevoke[] = []
    const failed: MigrationAuthorizationRevoke[] = []
    for (const revoke of revokes) {
      try {
        await sendPlainTransactions([revoke.transaction], {
          walletContext: revoke.walletContext,
        })
        restored.push(revoke)
      }
      catch (err) {
        logWarn('useEulerTx/migrationRevoke', err)
        failed.push(revoke)
      }
    }
    return { restored, failed }
  }

  const runPostTxSubgraphSync = async (cid: number, targetBlock: bigint) => {
    // Poll the SDK's subgraph proxy (not a separately-resolved upstream) so the
    // head we wait on is the same one serving queryAccountVaults.
    const caughtUp = await waitForSubgraphBlock(buildSubgraphProxyApiPath(cid), targetBlock)
    if (!caughtUp) {
      logWarn('useEulerTx/subgraphPoll', new Error(`subgraph did not catch up to block ${targetBlock} in time`))
      return
    }
    void invalidateSdkQueries([...INVALIDATE_AFTER_TX])
    triggerPortfolioRefresh()
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
    void invalidateSdkQueries([...INVALIDATE_AFTER_TX])
    triggerPortfolioRefresh()
    const cid = chainId.value
    if (lastReceipt && cid) {
      void runPostTxSubgraphSync(cid, lastReceipt.blockNumber)
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
    const provider = sdk.providerService?.getProvider(cid)
    if (!provider) {
      throw new Error('No provider available to confirm the transaction')
    }

    const connector = getAccount(config).connector
    const [isOkx, safeWalletProvider] = await Promise.all([
      isOkxWallet(connector),
      getSafeWalletProvider(connector),
    ])
    const sendTransaction = buildSendTransaction({
      isOkx,
      expectedAccount: owner,
      expectedChainId: cid,
      resolveHash: safeWalletProvider
        ? async submittedHash => (await waitForSafeTransactionExecution({
          submittedHash,
          walletProvider: safeWalletProvider,
          publicClient: provider as ReceiptClientLike,
        })).hash
        : undefined,
    })

    const result = await sdk.executionService.executeTransactionPlan({
      plan,
      chainId: cid,
      account: owner,
      usePermit2: signaturesEnabled.value,
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
    const provider = sdk.providerService?.getProvider(prepared.chainId)
    if (!provider) {
      throw new Error('No provider available to confirm the transaction')
    }
    const connector = getAccount(config).connector
    const [isOkx, safeWalletProvider] = await Promise.all([
      isOkxWallet(connector),
      getSafeWalletProvider(connector),
    ])
    const preparedOwner = typeof prepared.account === 'string'
      ? getAddress(prepared.account)
      : getAddress(prepared.account.owner)
    const sendTransaction = buildSendTransaction({
      isOkx,
      expectedAccount: preparedOwner,
      expectedChainId: prepared.chainId,
      resolveHash: safeWalletProvider
        ? async submittedHash => (await waitForSafeTransactionExecution({
          submittedHash,
          walletProvider: safeWalletProvider,
          publicClient: provider as ReceiptClientLike,
        })).hash
        : undefined,
    })

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

  /**
   * Attach a fresh snapshot of a sub-account onto a pre-loaded Account. Call
   * once per form interaction (after the receiver/borrow sub-account is known
   * and before fanning out per-quote plan builds) to amortise what would
   * otherwise be N `fetchSubAccount` round-trips. Per-quote planners then pass
   * `subAccountSnapshotApplied: true` to skip the inner refresh.
   */
  const preloadSubAccountSnapshot = async (
    account: Account<IHasVaultAddress>,
    subAccount: Address,
  ) => {
    const sdk = await getEulerSdkFresh()
    await attachSubAccountSnapshot(sdk, account, subAccount)
  }

  return {
    preloadSubAccountSnapshot,
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
    planRefinancePosition,
    getMigrationPosition,
    listMigrationTargets,
    getMigrationAuthorization,
    signMigrationAuthorization,
    buildPlaceholderMigrationAuthorization,
    executeMigrationAuthorizationGrants,
    sendMigrationAuthorizationRevokes,
    sendPlainTransactions,
    planCrossProtocolMigration,
    planCrossProtocolMigrationSimulation,
    planWithdrawOrRedeem,
    simulatePlan,
    prepareTransactionPlan,
    estimateGasForPlan,
    prefetchPluginData,
    simulatePreparedPlan,
    executePlan,
    executePreparedPlan,
  }
}
