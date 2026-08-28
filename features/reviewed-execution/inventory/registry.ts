/**
 * Frozen Stage A inventory for the reviewed reviewed execution.
 *
 * Keep this registry exhaustive. The inventory test compares these owners with
 * the production source tree so a new planner, review launcher, batch form, or
 * wallet write cannot appear without an explicit reviewed execution migration decision.
 */

export type InventoryDisposition = 'v2' | 'legacy-in-scope' | 'excluded' | 'absent'

export interface OperationInventoryRow {
  id: string
  family: string
  plannerOwner: string
  entryOwners: readonly string[]
  review: 'operation' | 'batch' | 'operation-and-batch' | 'none'
  disposition: InventoryDisposition
  notes?: string
}

export const OPERATION_INVENTORY: readonly OperationInventoryRow[] = [
  { id: 'deposit', family: 'supply', plannerOwner: 'useEulerTx.planDeposit', entryOwners: ['lend', 'earn', 'position/supply'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'deposit-with-swap', family: 'supply', plannerOwner: 'useEulerTx.planDepositWithSwap', entryOwners: ['lend', 'position/supply'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'withdraw', family: 'withdraw', plannerOwner: 'useEulerTx.planWithdraw', entryOwners: ['lend', 'earn', 'position/withdraw'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'redeem', family: 'withdraw', plannerOwner: 'useEulerTx.planRedeem', entryOwners: ['lend', 'earn', 'position/withdraw'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'withdraw-and-swap', family: 'withdraw', plannerOwner: 'useEulerTx.planWithdrawAndSwap', entryOwners: ['lend', 'position/withdraw'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'redeem-and-swap', family: 'withdraw', plannerOwner: 'useEulerTx.planRedeemAndSwap', entryOwners: ['lend'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'borrow', family: 'borrow', plannerOwner: 'useEulerTx.planBorrow', entryOwners: ['borrow-pair', 'position/borrow'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'swap-and-borrow', family: 'borrow', plannerOwner: 'useEulerTx.planSwapAndBorrow', entryOwners: ['borrow-pair', 'position/borrow'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'repay-from-wallet', family: 'repay', plannerOwner: 'useEulerTx.planRepayFromWallet', entryOwners: ['position/repay'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'repay-from-deposit', family: 'repay', plannerOwner: 'useEulerTx.planRepayFromDeposit', entryOwners: ['position/repay'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'repay-with-swap', family: 'repay', plannerOwner: 'useEulerTx.planRepayWithSwap', entryOwners: ['position/repay'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'swap-and-repay', family: 'repay', plannerOwner: 'useEulerTx.planSwapAndRepay', entryOwners: ['position/repay'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'wallet-swap', family: 'swap', plannerOwner: 'useEulerTx.planSwapFromWallet', entryOwners: ['swap'], review: 'operation', disposition: 'v2' },
  { id: 'collateral-swap', family: 'swap', plannerOwner: 'useEulerTx.planSwapCollateral', entryOwners: ['lend/collateral', 'position/repay'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'debt-swap', family: 'swap', plannerOwner: 'useEulerTx.planSwapDebt', entryOwners: ['position/refinance'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'same-asset-collateral-migration', family: 'refinance', plannerOwner: 'useEulerTx.planMigrateSameAssetCollateral', entryOwners: ['position/refinance'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'same-asset-debt-migration', family: 'refinance', plannerOwner: 'useEulerTx.planMigrateSameAssetDebt', entryOwners: ['position/refinance'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'multiply-with-swap', family: 'multiply', plannerOwner: 'useEulerTx.planMultiplyWithSwap', entryOwners: ['borrow-pair', 'position/multiply'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'multiply-same-asset', family: 'multiply', plannerOwner: 'useEulerTx.planMultiplySameAsset', entryOwners: ['borrow-pair', 'position/multiply'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'transfer', family: 'position', plannerOwner: 'useEulerTx.planTransfer', entryOwners: ['position'], review: 'operation', disposition: 'v2' },
  { id: 'cleanup', family: 'position', plannerOwner: 'useEulerTx.planCleanup', entryOwners: ['borrow', 'repay', 'refinance'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'cross-protocol-migration', family: 'migration', plannerOwner: 'positionMigrationService.planMigration', entryOwners: ['position/migrate', 'position/borrow/swap'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'reward-claim', family: 'reward', plannerOwner: 'rewardsService.buildClaimPlan', entryOwners: ['portfolio/rewards'], review: 'operation-and-batch', disposition: 'v2' },
  { id: 'reul-unlock', family: 'reward', plannerOwner: 'reulLockService.buildUnlockPlan', entryOwners: ['portfolio/rewards'], review: 'operation', disposition: 'v2' },
  { id: 'fee-flow-buy', family: 'fee-flow', plannerOwner: 'none', entryOwners: [], review: 'none', disposition: 'absent', notes: 'No production Lite caller on the Stage A baseline.' },
  { id: 'liquidation', family: 'liquidation', plannerOwner: 'none', entryOwners: [], review: 'none', disposition: 'absent', notes: 'No production Lite execution caller on the Stage A baseline.' },
] as const

export interface SourceCountInventoryRow {
  source: string
  expectedOccurrences: number
}

/** Every current `addBatchEntry(...)` production call site, grouped by owner. */
export const BATCH_FORM_SOURCE_INVENTORY: readonly SourceCountInventoryRow[] = [
  { source: 'components/entities/portfolio/PortfolioSdkRewardItem.vue', expectedOccurrences: 1 },
  { source: 'pages/borrow/[collateral]/[borrow]/index.vue', expectedOccurrences: 2 },
  { source: 'pages/earn/[vault]/[subAccount]/withdraw.vue', expectedOccurrences: 1 },
  { source: 'pages/earn/[vault]/index.vue', expectedOccurrences: 1 },
  { source: 'pages/lend/[vault]/[subAccount]/swap.vue', expectedOccurrences: 1 },
  { source: 'pages/lend/[vault]/[subAccount]/withdraw.vue', expectedOccurrences: 2 },
  { source: 'pages/lend/[vault]/index.vue', expectedOccurrences: 2 },
  { source: 'pages/position/[number]/borrow/index.vue', expectedOccurrences: 1 },
  { source: 'pages/position/[number]/borrow/swap.vue', expectedOccurrences: 2 },
  { source: 'pages/position/[number]/migrate.vue', expectedOccurrences: 1 },
  { source: 'pages/position/[number]/multiply.vue', expectedOccurrences: 1 },
  { source: 'pages/position/[number]/repay.vue', expectedOccurrences: 4 },
  { source: 'pages/position/[number]/supply.vue', expectedOccurrences: 2 },
  { source: 'pages/position/[number]/withdraw.vue', expectedOccurrences: 3 },
] as const

export interface BatchPerformanceCase {
  id: string
  source: string
  route: string
  setup: string
  actionLocator: '[data-testid="add-to-batch"]'
  expectedRowIdentity: string
}

/**
 * The production-browser performance matrix expands branches within one form
 * into distinct cases. Every case measures trusted-handler entry to the first
 * painted batch row; preparation is deliberately delayed in that suite.
 */
export const BATCH_PERFORMANCE_REGISTRY: readonly BatchPerformanceCase[] = [
  { id: 'reward-claim', source: 'components/entities/portfolio/PortfolioSdkRewardItem.vue', route: '/portfolio/rewards', setup: 'selected SDK reward claim', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'reward claim key' },
  { id: 'borrow-pair-borrow', source: 'pages/borrow/[collateral]/[borrow]/index.vue', route: '/borrow/:collateral/:borrow', setup: 'valid borrow tab', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'borrow intent id' },
  { id: 'borrow-pair-multiply', source: 'pages/borrow/[collateral]/[borrow]/index.vue', route: '/borrow/:collateral/:borrow', setup: 'valid multiply tab', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'multiply intent id' },
  { id: 'earn-withdraw', source: 'pages/earn/[vault]/[subAccount]/withdraw.vue', route: '/earn/:vault/:subAccount/withdraw', setup: 'valid withdraw amount', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'withdraw intent id' },
  { id: 'earn-deposit', source: 'pages/earn/[vault]/index.vue', route: '/earn/:vault', setup: 'valid deposit amount', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'deposit intent id' },
  { id: 'lend-collateral-swap', source: 'pages/lend/[vault]/[subAccount]/swap.vue', route: '/lend/:vault/:subAccount/swap', setup: 'valid selected quote', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'collateral-swap intent id' },
  { id: 'lend-withdraw-swap', source: 'pages/lend/[vault]/[subAccount]/withdraw.vue', route: '/lend/:vault/:subAccount/withdraw', setup: 'valid swap output', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'withdraw-swap intent id' },
  { id: 'lend-withdraw-direct', source: 'pages/lend/[vault]/[subAccount]/withdraw.vue', route: '/lend/:vault/:subAccount/withdraw', setup: 'valid direct withdraw', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'withdraw intent id' },
  { id: 'lend-deposit-swap', source: 'pages/lend/[vault]/index.vue', route: '/lend/:vault', setup: 'valid pay-with quote', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'deposit-swap intent id' },
  { id: 'lend-deposit-direct', source: 'pages/lend/[vault]/index.vue', route: '/lend/:vault', setup: 'valid direct deposit', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'deposit intent id' },
  { id: 'position-borrow', source: 'pages/position/[number]/borrow/index.vue', route: '/position/:number/borrow', setup: 'valid borrow amount', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'borrow intent id' },
  { id: 'inbound-migration', source: 'pages/position/[number]/borrow/swap.vue', route: '/position/:number/borrow/swap', setup: 'external source route', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'migration intent id' },
  { id: 'refinance', source: 'pages/position/[number]/borrow/swap.vue', route: '/position/:number/borrow/swap', setup: 'Euler refinance route', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'refinance intent id' },
  { id: 'outbound-migration', source: 'pages/position/[number]/migrate.vue', route: '/position/:number/migrate', setup: 'valid migration target', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'migration intent id' },
  { id: 'position-multiply', source: 'pages/position/[number]/multiply.vue', route: '/position/:number/multiply', setup: 'valid multiply amount', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'multiply intent id' },
  { id: 'repay-wallet-swap', source: 'pages/position/[number]/repay.vue', route: '/position/:number/repay', setup: 'wallet tab with swap', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'repay-swap intent id' },
  { id: 'repay-wallet-direct', source: 'pages/position/[number]/repay.vue', route: '/position/:number/repay', setup: 'wallet tab same asset', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'repay intent id' },
  { id: 'repay-collateral', source: 'pages/position/[number]/repay.vue', route: '/position/:number/repay', setup: 'collateral tab', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'repay-collateral intent id' },
  { id: 'repay-savings', source: 'pages/position/[number]/repay.vue', route: '/position/:number/repay', setup: 'savings tab', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'repay-savings intent id' },
  { id: 'position-supply-swap', source: 'pages/position/[number]/supply.vue', route: '/position/:number/supply', setup: 'valid pay-with quote', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'supply-swap intent id' },
  { id: 'position-supply-direct', source: 'pages/position/[number]/supply.vue', route: '/position/:number/supply', setup: 'valid direct supply', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'supply intent id' },
  { id: 'position-withdraw-swap', source: 'pages/position/[number]/withdraw.vue', route: '/position/:number/withdraw', setup: 'valid swap output', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'withdraw-swap intent id' },
  { id: 'position-redeem', source: 'pages/position/[number]/withdraw.vue', route: '/position/:number/withdraw', setup: 'full withdrawal', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'redeem intent id' },
  { id: 'position-withdraw-direct', source: 'pages/position/[number]/withdraw.vue', route: '/position/:number/withdraw', setup: 'partial direct withdrawal', actionLocator: '[data-testid="add-to-batch"]', expectedRowIdentity: 'withdraw intent id' },
] as const

export const REVIEW_VARIANTS = [
  'supply', 'withdraw', 'borrow', 'repay', 'swap', 'transfer', 'refinance', 'migration',
  'reward', 'brevis-reward', 'fuul-reward', 'turtle-reward', 'reul-unlock',
  'disableCollateral', 'swap-supply', 'swap-withdraw', 'swap-borrow', 'batch',
] as const

export const REVIEW_SOURCE_INVENTORY: readonly SourceCountInventoryRow[] = [
  { source: 'components/BatchContents.vue', expectedOccurrences: 2 },
  { source: 'components/entities/portfolio/PortfolioSdkRewardItem.vue', expectedOccurrences: 1 },
  { source: 'components/entities/reward/RewardUnlockItem.vue', expectedOccurrences: 1 },
  { source: 'composables/borrow/useBorrowForm.ts', expectedOccurrences: 2 },
  { source: 'composables/borrow/useMultiplyForm.ts', expectedOccurrences: 1 },
  { source: 'composables/position/useCollateralForm.ts', expectedOccurrences: 1 },
  { source: 'composables/repay/useCollateralSwapRepay.ts', expectedOccurrences: 1 },
  { source: 'composables/repay/useSavingsRepay.ts', expectedOccurrences: 1 },
  { source: 'composables/repay/useWalletRepay.ts', expectedOccurrences: 1 },
  { source: 'composables/repay/useWalletSwapRepay.ts', expectedOccurrences: 1 },
  { source: 'composables/useSwapPageLogic.ts', expectedOccurrences: 1 },
  { source: 'pages/earn/[vault]/[subAccount]/withdraw.vue', expectedOccurrences: 1 },
  { source: 'pages/earn/[vault]/index.vue', expectedOccurrences: 1 },
  { source: 'pages/lend/[vault]/[subAccount]/withdraw.vue', expectedOccurrences: 1 },
  { source: 'pages/lend/[vault]/index.vue', expectedOccurrences: 1 },
  { source: 'pages/position/[number]/borrow/index.vue', expectedOccurrences: 1 },
  { source: 'pages/position/[number]/borrow/swap.vue', expectedOccurrences: 2 },
  { source: 'pages/position/[number]/index.vue', expectedOccurrences: 1 },
  { source: 'pages/position/[number]/migrate.vue', expectedOccurrences: 1 },
  { source: 'pages/position/[number]/multiply.vue', expectedOccurrences: 1 },
] as const

export const PREVIEW_PREPARATION_INVENTORY = [
  { producer: 'useFreshAccount', cache: 'batchPrefetchState planning account', identity: ['owner', 'chain'] },
  { producer: 'useEulerAccount', cache: 'batchPrefetchState base account', identity: ['owner', 'chain'] },
  { producer: 'useStateOverrideOptions.primeSlotHintsFor', cache: 'form ref and batch slot-hint registry', identity: ['chain', 'token'] },
  { producer: 'useSwapQuotesParallel consumers', cache: 'quote and plugin prefetch refs', identity: ['owner', 'chain', 'quote request', 'account snapshot'] },
  { producer: 'useEulerTx.prefetchPluginData', cache: 'page-owned prefetch ref', identity: ['owner', 'chain', 'representative plan'] },
  { producer: 'useTxBatch.resimulate', cache: 'whole-cart layers and reviewed execution preparation cache', identity: ['owner', 'chain', 'ordered intent revisions', 'generation'] },
  { producer: 'migration preview loaders', cache: 'prepared and simulation refs', identity: ['owner', 'chain', 'target', 'authorization mode', 'quote'] },
  { producer: 'multiply/repay/lend prepared simulations', cache: 'form prepared-plan refs', identity: ['owner', 'chain', 'form snapshot', 'quote', 'plugin prefetch', 'slot hints'] },
] as const

export const WALLET_WRITE_SOURCE_INVENTORY = [
  { source: 'composables/useReviewedExecution.ts', disposition: 'v2' },
  { source: 'features/reviewed-execution/adapters/eoa.ts', disposition: 'v2' },
  { source: 'features/reviewed-execution/adapters/safe.ts', disposition: 'v2' },
  { source: 'composables/cowswap/useCowSwapExecutionCore.ts', disposition: 'excluded' },
] as const
