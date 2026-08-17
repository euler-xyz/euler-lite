import { computed, effectScope, ref, shallowRef, watch, type EffectScope, type Ref } from 'vue'
import { formatUnits, getAddress, type Address, type Hex, type StateOverride } from 'viem'
import { Account, fetchErc20SlotHints, getEulerLabelProductByVault, mergeStateOverrides } from '@eulerxyz/euler-v2-sdk'
import type {
  IHasVaultAddress,
  Portfolio,
  PortfolioBorrowPosition,
  PortfolioSavingsPosition,
  SlotHints,
  TransactionPlan,
  TransactionPlanPrepared,
  VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import {
  getBatchPrefetchedBaseAccount,
  getBatchPrefetchedPlanningAccount,
  getBatchPrefetchedSlotHints,
  mergeBatchPrefetchedSlotHints,
} from '~/composables/batchPrefetchState'
import { getCurrentEulerLabelsData } from '~/composables/useEulerLabels'
import type { TrackedExecutionScope } from '~/composables/useSafeExecutionDetachment'
import {
  activeLayerVaultsRef,
  collectAccountVaults,
  mergeLayeredVaults,
  type LayeredVaultMap,
} from '~/composables/useLayeredVaults'
import { buildPlanMarketLabel, type DisplayStep } from '~/utils/stepDecoding'
import { formatSmartAmount } from '~/utils/string-utils'
import { formatSimulationFailure, getTxErrorMessage } from '~/utils/tx-errors'
import { logWarn } from '~/utils/errorHandling'
import { buildVisiblePortfolioPositionFilter } from '~/utils/portfolioPositionFilter'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'
import type { WalletExecutionContext } from '~/utils/walletExecutionContext'
import {
  assertPreparedPlanSignatureParity,
  type PreparedPlanSignatureSubstitution,
} from '~/utils/preparedPlanParity'

export interface BatchWalletChange {
  token: string
  symbol: string
  decimals: number
  delta: bigint
}

export interface BatchClosedPosition {
  subAccount: Address
  vault: Address
}

/**
 * Transaction batch builder ("shopping cart") with layered simulated state.
 *
 * Each entry is one operation the user adds (a deposit, a withdraw, …). The
 * batch keeps a stack of *world snapshots* (layers):
 *   - layer 0  = the real on-chain account (the live world)
 *   - layer i  = the simulated account after entries 1..i
 *
 * A single global pointer (`activeLayer`) selects which layer the rest of the
 * app reads. Layer 0 means "real state" (the app behaves exactly as before);
 * any non-zero layer is simulated state. Consumers stay layer-agnostic — they
 * keep reading `useEulerAccount().portfolio`, which transparently returns the
 * active layer's portfolio (see `activeLayerPortfolioRef`).
 *
 * Layered data source (for now): prefix re-simulation against the stock SDK.
 * `layer[i] = simulateTransactionPlan(mergePlans(entries[0..i]))` — the final
 * simulated account of a prefix *is* the world after that prefix. Each entry's
 * transaction plan is fixed at add-time against the current batch end-state;
 * later resimulations only replay stored plans. The production path (one batch
 * with interspersed lens reads + per-op errors, exposed via a `layers` flag on
 * `simulateTransactionPlan`) is a drop-in replacement for `resimulate()` — the
 * layer interface is unchanged.
 */

export interface BatchEntryExternalTx {
  to: Address
  data: Hex
  value?: bigint
  label?: string
}

export interface BatchEntryExecutionPrerequisites {
  /** Sent and mined before the reviewed prepared core is executed. */
  preTxs: BatchEntryExternalTx[]
  /** Wallet context used to build the prerequisite request. */
  walletContext: WalletExecutionContext
  /** Sent after the batch executes. Failures are non-fatal. */
  postTxs: BatchEntryExternalTx[]
  /** Revoke paired with each pre-transaction, in pre-transaction order. */
  postTxsByPreTx?: Array<BatchEntryExternalTx | undefined>
}

export interface BatchEntryExecutionCeremony {
  /**
   * Execution payload built from the same authorization resolution as the
   * prerequisite calls and review rows.
   */
  plan: TransactionPlan
  /** One authorization resolution shared by standard and Safe execution. */
  prerequisites?: BatchEntryExecutionPrerequisites
  /**
   * Review rows for the prerequisite grants, derived from this ceremony's
   * authorization resolution.
   */
  grantSteps: DisplayStep[]
  /** Review rows for the prerequisite revocations, from the same resolution. */
  revokeSteps: DisplayStep[]
  /**
   * Resolve wallet signatures only after the user confirms this reviewed
   * ceremony. The callback receives the ceremony freshness guard and returns
   * the same plan with real signature bytes.
   */
  resolveExecutionPlan?: (beforeWalletAction: () => void) => Promise<{
    plan: TransactionPlan
    signatureSubstitutions: readonly PreparedPlanSignatureSubstitution[]
  }>
  /** The review/copy plan contains placeholder authorization signatures. */
  usesPlaceholderSignatures?: boolean
}

/** One immutable batch review ceremony used for display, export, and execution. */
export interface PreparedBatchExecution {
  readonly generation: number
  readonly owner: Address
  readonly chainId: number
  readonly safeWallet: boolean
  readonly safeWalletResolved: boolean
  readonly connectorKey?: string
  readonly mode: 'standard' | 'safe-bundled'
  readonly prepared: TransactionPlanPrepared
  readonly resolvePreparedPlan?: (beforeWalletAction: () => void) => Promise<TransactionPlanPrepared>
  readonly usesPlaceholderSignatures: boolean
  readonly grants: readonly BatchEntryExternalTx[]
  readonly revokes: readonly BatchEntryExternalTx[]
  readonly prerequisites: readonly Readonly<BatchEntryExecutionPrerequisites>[]
  readonly reviewByEntryId: Readonly<Record<string, {
    readonly plan: TransactionPlan
    readonly grantSteps: readonly DisplayStep[]
    readonly revokeSteps: readonly DisplayStep[]
  }>>
}

export interface BatchEntry {
  id: string
  label: string
  /** Fixed transaction payload captured when the user added this entry. */
  plan: TransactionPlan
  /** Optional real execution payload builder for entries whose preview plan uses simulation-only state. */
  buildExecutionPlan?: (account: Account<IHasVaultAddress>) => Promise<TransactionPlan>
  /** Resolve the execution plan, authorization calls, and review rows together.
   *  Standard wallets broadcast the prerequisite calls around the prepared core;
   *  Safe wallets include the same calls in one atomic proposal. */
  buildExecutionCeremony?: (
    account: Account<IHasVaultAddress>,
  ) => Promise<BatchEntryExecutionCeremony>
  /** This entry's prerequisite calls belong inside one atomic Safe proposal. */
  bundleExecutionCeremony?: boolean
  /** Extra simulation-only overrides required by this entry, e.g. migration authorization. */
  stateOverrides?: StateOverride
  /** Props for the per-operation review modal (OperationReviewModal), captured at
   *  add-time so the batch can show the same review the form would — minus the
   *  execute button. The contextual plan is supplied from the simulation. */
  review?: Record<string, unknown>
  /** Sub-account this operation targets, when known (position pages). Lets the
   *  batch rows show the same "Position N" tag as the portfolio. New positions
   *  (fresh deposits) leave this undefined and render no tag. */
  subAccount?: Address
  /** Additional sub-accounts intentionally modified by this entry. Used when a
   *  position-scoped operation also moves balances to the owner account. */
  affectedSubAccounts?: Address[]
  /** Euler positions this operation intentionally closes. Used when a simulated
   *  layer omits a zeroed position instead of returning an explicit zero row. */
  closedPositions?: BatchClosedPosition[]
  /** Multiply flows set this. A multiply is a borrow(+swap) at the plan level, so
   *  it can't be told apart from a plain borrow or a borrow-with-collateral-swap
   *  by the plan alone (and same-asset multiply has no swap step at all). This
   *  lite-only flag lets the batch list label it "Multiply …". */
  multiply?: boolean
  /** Verbatim batch-row name, used as-is instead of the verb+symbol derived from
   *  `review`. Refinance flows set this to "Refinance <collateral>/<borrow>" so
   *  the row reads as the position it acts on rather than the swap leg's asset.
   *  Wallet-swap repay also uses this to name the debt asset while the review keeps
   *  the wallet input asset for step decoding. */
  nameOverride?: string
  /** Refresh external protocol positions after this entry executes in a batch. */
  refreshExternalMigrationPositions?: boolean
  /** Stable claim identifier for reward rows already queued in the batch. */
  rewardClaimKey?: string
}

type BatchEntryBuildResult = TransactionPlan | {
  plan: TransactionPlan
  stateOverrides?: StateOverride
}

type BatchEntryInputBase = Omit<BatchEntry, 'id' | 'plan'>

export type BatchEntryInput = BatchEntryInputBase & (
  {
    /** Builds this entry once, at add-time, against the current batch end-state. */
    buildPlan: (account: Account<IHasVaultAddress>) => Promise<BatchEntryBuildResult>
    requiresPlanningAccount?: true
  } | {
    /** Builds this entry once, at add-time, without a simulated account snapshot. */
    buildPlan: () => Promise<BatchEntryBuildResult>
    /** Set false for standalone plans that do not need the current simulated account. */
    requiresPlanningAccount: false
  }
)

export interface BatchLayer {
  /** Simulated account snapshot after this layer's entry (layer 0 = real). */
  account: Account<IHasVaultAddress>
  /** Visible-only (verified-filtered) portfolio projection. */
  portfolio?: Portfolio<VaultEntity>
  /** All-positions projection (for the "Show all" view). */
  portfolioAll?: Portfolio<VaultEntity>
  /** Cumulative simulated vault state for utilization-aware projections. */
  vaults?: LayeredVaultMap
  /**
   * Stitched wallet ERC20 balances (lowercased token → absolute balance) for the
   * assets the batch touched, at this layer: the real wallet balance with this
   * layer's simulated deposit/withdraw/borrow/repay applied.
   */
  walletBalances?: Record<string, bigint>
  /**
   * Raw simulated wallet balances (lowercased token → forged in-sim balance) for
   * this layer, straight from the SDK. Unlike `walletBalances` these are NOT
   * anchored to the real wallet or floored at zero, so the delta vs layer 0 is
   * the true amount the batch moves — including any portion forged by state
   * overrides when the wallet is underfunded. Used for the wallet-changes
   * summary so an underfunded supply still shows the full pulled amount.
   */
  walletBalancesSim?: Record<string, bigint>
  /** True when this entry's operation reverted / can't execute in the batch. */
  failed: boolean
  error?: string
}

/** A token the executed batch would overdraw from the real wallet. */
export interface WalletShortfall {
  /** Lowercased token address. */
  token: string
  /** How much more of the token the batch needs than the wallet holds. */
  amount: bigint
  symbol: string
  decimals: number
}

// --- module-scoped state (single shared cart for the session) ---
const entries: Ref<BatchEntry[]> = ref([])
const layers = shallowRef<BatchLayer[]>([])
const batchGeneration = ref(0)
const pendingAddCount = ref(0)
let addContextGeneration = 0
let batchPreparation: {
  generation: number
  promise: Promise<PreparedBatchExecution>
} | null = null

const invalidateBatchReview = () => {
  batchGeneration.value++
  batchPreparation = null
}

const invalidatePendingAddContext = () => {
  addContextGeneration++
}

interface BatchAddContext {
  generation: number
  owner?: Address
  chainId?: number
}

class BatchAddContextChangedError extends Error {
  constructor() {
    super('Wallet or batch changed while adding this operation — add it again.')
    this.name = 'BatchAddContextChangedError'
  }
}
// Per-entry fixed plan (keyed by entry id), used by the review modal and by the
// merged whole-batch plan. These are captured once when the entry is added.
const entryPlans = computed<Record<string, TransactionPlan>>(() =>
  Object.fromEntries(entries.value.map(entry => [entry.id, entry.plan])),
)
// Tokens the full batch would overdraw from the real wallet (execute-time gate).
const walletShortfalls = shallowRef<WalletShortfall[]>([])
const activeLayer = ref(0)
const isSimulating = ref(false)
const simError = ref<string | undefined>(undefined)
const isExecuting = ref(false)
const execError = ref<string | undefined>(undefined)
// Drawer expanded/collapsed state, shared so the mobile nav's "Batch" item and
// the drawer header toggle the same thing. On laptop this collapses the body; on
// mobile it shows/hides the whole bottom sheet (the nav item is the entry point).
const drawerOpen = ref(true)
// The merged plan from the most recent successful resimulation, reused by
// executeBatch so the executed batch is exactly what was simulated.
let lastMerged: TransactionPlan | null = null
let baseAccountSnapshot: Account<IHasVaultAddress> | null = null

/**
 * Module-level overlay ref read by `useEulerAccount` so the portfolio is
 * layer-aware without threading the pointer through every consumer.
 * `undefined` ⇒ show real (layer 0) data.
 */
export const activeLayerPortfolioRef = shallowRef<Portfolio<VaultEntity> | undefined>(undefined)
/** All-positions overlay (for the "Show all" toggle). `undefined` ⇒ real data. */
export const activeLayerPortfolioAllRef = shallowRef<Portfolio<VaultEntity> | undefined>(undefined)
/** Removed borrow positions reconstructed from layer 0 for the visible projection. */
export const activeLayerRemovedBorrowPositionsRef = shallowRef<PortfolioBorrowPosition<VaultEntity>[]>([])
/** Removed borrow positions reconstructed from layer 0 for the all-positions projection. */
export const activeLayerRemovedBorrowPositionsAllRef = shallowRef<PortfolioBorrowPosition<VaultEntity>[]>([])
/** Removed deposit positions reconstructed from layer 0 for the visible projection. */
export const activeLayerRemovedDepositPositionsRef = shallowRef<PortfolioSavingsPosition<VaultEntity>[]>([])
/** Removed deposit positions reconstructed from layer 0 for the all-positions projection. */
export const activeLayerRemovedDepositPositionsAllRef = shallowRef<PortfolioSavingsPosition<VaultEntity>[]>([])
/** Position keys (`${subAccount}:${vault}`) fully removed by the active simulated layer. */
export const activeLayerRemovedKeysRef = shallowRef<Set<string>>(new Set<string>())
/**
 * Stitched wallet balances (lowercased token → absolute balance) for the active
 * layer's touched assets. `useWallets` returns these in place of the real
 * balance for those tokens, so the wallet reflects batched deposits/withdrawals/
 * borrows/repays. Empty ⇒ real data (base layer or no batch).
 */
export const activeLayerWalletBalancesRef = shallowRef<Record<string, bigint>>({})
/**
 * The active layer's stitched (full) simulated Account, or `undefined` at the
 * base layer. Lets reads that don't go through the portfolio — e.g. vault share
 * balances and plan-time account snapshots — follow the simulated state.
 */
export const activeLayerAccountRef = shallowRef<Account<IHasVaultAddress> | undefined>(undefined)

let idSeq = 0
let resimToken = 0
let scope: EffectScope | undefined
let resimulatePromise: Promise<void> | null = null
let addEntryQueue: Promise<void> = Promise.resolve()
// Signatures of adds currently in flight. The "Add to batch" buttons stay
// enabled across the async plan build, so a rapid double-click would otherwise
// enqueue the same operation twice; we drop a duplicate while an identical add
// is still being processed.
const pendingAddSignatures = new Set<string>()
// Symbol/decimals for touched wallet tokens, for the wallet-changes summary.
const walletAssetMeta: Record<string, { symbol: string, decimals: number }> = {}
let batchSlotHints: SlotHints = {}

// TEMP DIAGNOSTICS — hunting an unreproducible "Batch simulation not loaded"
// error that some users hit when adding a second operation to the batch. Every
// call snapshots the full resim state machine (token, entry/layer counts,
// promise + error state) so a single field report is self-contained.
//
// IMPORTANT: client `logger.warn` is dropped unless `?verbose` /
// localStorage.euler_verbose=1 is set (see utils/logger.ts), so the trace level
// only shows up for devs / on the server. The moments that actually pin the bug
// (the throw, the version guard, supersessions that fire during a plan-time
// await) are logged at `severity: 'error'`, which surfaces in every browser.
// Remove this whole block (and its call sites) once the cause is captured.
const logBatchDiag = (
  event: string,
  extra?: Record<string, unknown>,
  severity: 'warn' | 'error' = 'warn',
) => {
  logWarn('useTxBatch/diag', event, {
    severity,
    data: {
      event,
      resimToken,
      hasResimPromise: resimulatePromise !== null,
      isSimulating: isSimulating.value,
      entryCount: entries.value.length,
      layerCount: layers.value.length,
      activeLayer: activeLayer.value,
      simError: simError.value ?? null,
      entries: entries.value.map(e => ({
        id: e.id,
        label: e.label,
        subAccount: e.subAccount,
        planItems: e.plan?.length ?? 0,
      })),
      ...extra,
    },
  })
}

const normalizeTokenKey = (token: string) => {
  try {
    return getAddress(token).toLowerCase()
  }
  catch {
    return token.toLowerCase()
  }
}

export const buildScopedEntrySubAccounts = (
  batchEntries: Pick<BatchEntry, 'subAccount' | 'affectedSubAccounts'>[],
): Set<string> | undefined => {
  const set = new Set<string>()

  for (const entry of batchEntries) {
    const accounts = [
      entry.subAccount,
      ...(entry.affectedSubAccounts ?? []),
    ].filter((account): account is Address => !!account)

    if (!accounts.length) return undefined

    for (const account of accounts) {
      try {
        set.add(getAddress(account).toLowerCase())
      }
      catch {
        return undefined
      }
    }
  }

  return set
}

const buildBorrowPortfolioPositionKey = (
  subAccount: string,
  borrow: string,
  collaterals: string[],
): string => {
  const normalizedSubAccount = getAddress(subAccount).toLowerCase()
  const normalizedBorrow = getAddress(borrow).toLowerCase()
  const normalizedCollaterals = collaterals
    .map(address => getAddress(address).toLowerCase())
    .sort()
    .join('|')
  return `${normalizedSubAccount}:${normalizedBorrow}:${normalizedCollaterals}`
}

const getReviewAddress = (review: Record<string, unknown>, key: string): string | undefined => {
  const value = review[key]
  return typeof value === 'string' ? value : undefined
}

const getReviewAddressArray = (review: Record<string, unknown>, key: string): string[] => {
  const value = review[key]
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : []
}

export const buildRefinanceReplacementBorrowPositionKeys = (
  batchEntries: Pick<BatchEntry, 'subAccount' | 'review'>[],
): Set<string> => {
  const keys = new Set<string>()

  for (const entry of batchEntries) {
    const review = entry.review
    if (
      review?.type !== 'refinance'
      || review.collateralChanged !== true
      || review.debtChanged !== true
      || !entry.subAccount
    ) continue

    const sourceDebtVault = getReviewAddress(review, 'sourceDebtVault')
    const sourceCollateralVaults = getReviewAddressArray(review, 'sourceCollateralVaults')
    if (!sourceDebtVault || !sourceCollateralVaults.length) continue

    try {
      keys.add(buildBorrowPortfolioPositionKey(entry.subAccount, sourceDebtVault, sourceCollateralVaults))
    }
    catch {
      // Optional UI metadata only; malformed addresses should not break overlay.
    }
  }

  return keys
}

const registerReviewAssetMeta = (review?: Record<string, unknown>) => {
  const asset = review?.asset as { address?: string, symbol?: string, decimals?: number } | undefined
  if (!asset?.address) return
  try {
    walletAssetMeta[normalizeTokenKey(asset.address)] = {
      symbol: asset.symbol ?? '',
      decimals: Number(asset.decimals ?? 18),
    }
  }
  catch {
    // Review metadata is display-only; ignore malformed optional addresses.
  }
}

const collectRequiredApprovalTokens = (plan: TransactionPlan): Address[] => {
  const tokens: Address[] = []
  const seen = new Set<string>()
  for (const item of plan) {
    if (item.type !== 'requiredApproval') continue
    try {
      const token = getAddress(item.token) as Address
      const key = token.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      tokens.push(token)
    }
    catch {
      // Ignore malformed optional metadata; simulation can still use SDK fallbacks.
    }
  }
  return tokens
}

const primeBatchSlotHintsFor = async (
  chainId: number,
  tokens: Address[],
  isCurrent: () => boolean = () => true,
): Promise<void> => {
  if (!tokens.length) return
  try {
    const sdk = await getEulerSdkFresh()
    const provider = sdk.providerService?.getProvider(chainId)
    if (!provider) return
    const permit2Address = sdk.deploymentService.getDeployment(chainId).addresses.coreAddrs.permit2 as Address
    const next: SlotHints = { ...batchSlotHints }
    await Promise.all(tokens.map(async (token) => {
      try {
        next[token] = await fetchErc20SlotHints(provider, token, {
          allowanceSpender: permit2Address,
        })
      }
      catch (error) {
        logWarn('useTxBatch/primeBatchSlotHintsFor', error)
      }
    }))
    if (isCurrent()) {
      batchSlotHints = next
      mergeBatchPrefetchedSlotHints(chainId, next)
    }
  }
  catch (error) {
    logWarn('useTxBatch/primeBatchSlotHintsFor', error)
  }
}

const redirectAfterBatchExecution = async (scope?: TrackedExecutionScope) => {
  try {
    // Success signal for a detached Safe completion toast, and the gate that
    // keeps a background-confirmed batch from yanking the user mid-flow.
    // Bound to THIS execution's record — a late tail can never mark or read
    // a successor execution.
    scope?.markSucceeded()
    if (scope?.suppressPostTxUi()) return
    const router = useRouter()
    const route = useRoute()
    const query: Record<string, string> = {}
    const network = route.query.network
    if (typeof network === 'string') query.network = network
    else if (Array.isArray(network) && typeof network[0] === 'string') query.network = network[0]
    await router.replace({ path: '/portfolio', query })
  }
  catch (error) {
    // The transaction has already mined. Navigation is best-effort and should
    // never turn a successful batch execution into an execution failure.
    logWarn('useTxBatch/redirectAfterBatchExecution', error)
  }
}

export const buildWalletChanges = (
  current: Record<string, bigint> | undefined,
  base: Record<string, bigint> | undefined,
  assetMeta: Record<string, { symbol: string, decimals: number }>,
): BatchWalletChange[] => {
  const out = new Map<string, BatchWalletChange>()

  if (current && base) {
    for (const token of Object.keys(current)) {
      const delta = (current[token] ?? 0n) - (base[token] ?? 0n)
      if (delta === 0n) continue
      const meta = assetMeta[token]
      out.set(token, { token, delta, symbol: meta?.symbol ?? '', decimals: meta?.decimals ?? 18 })
    }
  }

  return [...out.values()].filter(change => change.delta !== 0n)
}

export const collectWalletBalanceTokens = (
  layers: Record<string, bigint>[],
): string[] => Array.from(new Set(layers.flatMap(layer => Object.keys(layer))))

export const buildWalletBalanceLayers = (
  simulatedLayers: Record<string, bigint>[],
  realWallet: Record<string, bigint>,
): Record<string, bigint>[] => {
  const touchedTokens = collectWalletBalanceTokens(simulatedLayers)
  const baseWb = simulatedLayers[0] ?? {}
  return simulatedLayers.map((wb) => {
    const out: Record<string, bigint> = {}
    for (const token of touchedTokens) {
      const delta = (wb[token] ?? 0n) - (baseWb[token] ?? 0n)
      const value = (realWallet[token] ?? 0n) + delta
      out[token] = value < 0n ? 0n : value
    }
    return out
  })
}

/**
 * Align optional SDK vault snapshots with account layers. The only proven
 * shapes are no snapshots, one snapshot per operation, or a base snapshot plus
 * one per operation. Any other non-empty cardinality is ambiguous and must not
 * be indexed into earlier layers.
 */
export const normalizeSimulatedVaultLayers = <T>(
  rawLayers: T[][],
  operationCount: number,
): T[][] | null => {
  if (rawLayers.length === 0) return []
  if (rawLayers.length === operationCount) return [[], ...rawLayers]
  if (rawLayers.length === operationCount + 1) return rawLayers
  return null
}

/**
 * Mirror of the SDK simulator's `collectOperations` grouping: every top-level
 * entry of an evcBatch — a named operation or a loose item — is one
 * simulation operation, producing one state layer and one slot in the
 * `failedBatchItems.operationIndex` space. Non-evcBatch plan items produce
 * neither.
 */
export const countPlanOperations = (plan: TransactionPlan): number => {
  let count = 0
  for (const item of plan) {
    if (item.type !== 'evcBatch') continue
    count += item.items.length
  }
  return count
}

export interface BatchOperationEntryMap {
  /**
   * Operations the simulated plan carries ahead of the entries' own —
   * plan plugins (ToS registration, Pyth updates) prepend loose items, each
   * of which the simulator treats as its own operation.
   */
  pluginOperations: number
  /** Operations contributed by each cart entry, in entry order. */
  operationCounts: number[]
  /** Simulation layer index holding the state after entry i completed. */
  entryLayerIndices: number[]
  /** Cart entry owning an SDK operationIndex; null for plugin operations. */
  entryOfOperation: (operationIndex: number) => number | null
}

/**
 * Explicit SDK-operation ↔ cart-entry boundary map.
 *
 * Layer/failure cardinality cannot be inferred from entry count alone: a
 * single cart entry may contribute several operations (a collateral+debt
 * refinance is the concrete case), and plan plugins prepend operations of
 * their own. Entry operation counts come from the entry plans the cart
 * holds; the plugin prefix is the difference against the simulated plan's
 * operation count (plugins run inside `simulateTransactionPlan`, so the app
 * never holds the plan that was actually simulated). Known plugins prepend —
 * a negative difference means the shapes disagree and the caller must treat
 * the simulation as unusable.
 */
export const buildOperationEntryMap = (
  entryPlans: TransactionPlan[],
  simulatedOperationCount: number,
): BatchOperationEntryMap | null => {
  const operationCounts = entryPlans.map(countPlanOperations)
  const totalEntryOperations = operationCounts.reduce((sum, count) => sum + count, 0)
  const pluginOperations = simulatedOperationCount - totalEntryOperations
  if (pluginOperations < 0) return null

  const entryLayerIndices: number[] = []
  let cumulative = pluginOperations
  for (const count of operationCounts) {
    cumulative += count
    entryLayerIndices.push(cumulative)
  }

  return {
    pluginOperations,
    operationCounts,
    entryLayerIndices,
    entryOfOperation: (operationIndex: number) => {
      if (operationIndex < pluginOperations || operationIndex >= simulatedOperationCount) return null
      for (let i = 0; i < entryLayerIndices.length; i++) {
        if (operationIndex < entryLayerIndices[i]!) return i
      }
      return null
    },
  }
}

type BatchSimulationWalletBalances = {
  simulatedWalletBalances?: Record<string, bigint>[]
}

const syncOverlay = () => {
  const layer = activeLayer.value > 0 ? layers.value[activeLayer.value] : undefined
  activeLayerPortfolioRef.value = layer?.portfolio
  activeLayerPortfolioAllRef.value = layer?.portfolioAll
  if (layer) {
    const base = layers.value[0]
    const removedKeys = buildRemovedPositionKeySets(layer.account, base?.account)
    const refinanceReplacementBorrowPositionKeys = buildRefinanceReplacementBorrowPositionKeys(
      entries.value.slice(0, activeLayer.value),
    )
    activeLayerRemovedKeysRef.value = removedKeys
    activeLayerRemovedBorrowPositionsRef.value = getRemovedBorrowPositions(
      base?.portfolio,
      layer.portfolio,
      removedKeys,
      refinanceReplacementBorrowPositionKeys,
    )
    activeLayerRemovedBorrowPositionsAllRef.value = getRemovedBorrowPositions(
      base?.portfolioAll,
      layer.portfolioAll,
      removedKeys,
      refinanceReplacementBorrowPositionKeys,
    )
    activeLayerRemovedDepositPositionsRef.value = getRemovedDepositPositions(base?.portfolio, layer.portfolio, removedKeys)
    activeLayerRemovedDepositPositionsAllRef.value = getRemovedDepositPositions(base?.portfolioAll, layer.portfolioAll, removedKeys)
  }
  else {
    activeLayerRemovedKeysRef.value = new Set<string>()
    activeLayerRemovedBorrowPositionsRef.value = []
    activeLayerRemovedBorrowPositionsAllRef.value = []
    activeLayerRemovedDepositPositionsRef.value = []
    activeLayerRemovedDepositPositionsAllRef.value = []
  }

  // Active layer's stitched wallet balances (absolute) for touched tokens.
  activeLayerWalletBalancesRef.value = layer?.walletBalances ?? {}
  // Active layer's cumulative simulated vault snapshots. These are kept
  // separately from positions because a full withdrawal can remove its account
  // position while the vault's post-withdraw utilization remains relevant.
  activeLayerVaultsRef.value = layer?.vaults ?? {}
  // Active layer's full stitched account (for share-balance / plan-account reads).
  activeLayerAccountRef.value = layer?.account
}

const invalidateSimulationLayers = () => {
  layers.value = []
  activeLayer.value = 0
  walletShortfalls.value = []
  lastMerged = null
  syncOverlay()
}

/**
 * Build a human-readable message from a failed simulation. Note: only real
 * reverts (failedBatchItems / status checks / EVC error) drive per-operation
 * "failed" flags. The `insufficient*` diagnostics are advisory (real-balance,
 * an execute-time concern) — the simulator forges balances/allowances for the
 * eth_call, so the hypothetical post-state stays valid for any account.
 */
const describeFailure = (sim: Parameters<typeof formatSimulationFailure>[0]): string => {
  try {
    return formatSimulationFailure(sim) || 'Operation would revert'
  }
  catch {
    return 'Operation would revert'
  }
}

// Concise message from an execution / gas-estimate error. Gas estimation throws
// raw viem errors, so run them through the same decoder used by direct tx flows.
const describeExecError = async (error: unknown): Promise<string> => {
  try {
    return await getTxErrorMessage(error)
  }
  catch {
    const e = error as { shortMessage?: string, details?: string, message?: string }
    return e?.shortMessage || e?.details || e?.message || String(error)
  }
}

export const fetchBaseAccountSnapshot = async (
  sdk: Awaited<ReturnType<typeof getEulerSdkFresh>>,
  chainId: number,
  owner: Address,
): Promise<Account<IHasVaultAddress>> => {
  const fetched = await sdk.accountService.fetchAccount(chainId, owner, {
    populateAll: true,
  })
  return fetched.result as Account<IHasVaultAddress>
}

const isAccountForContext = (
  account: Account<IHasVaultAddress> | undefined,
  chainId: number,
  owner: Address,
): account is Account<IHasVaultAddress> => {
  if (!account || account.chainId !== chainId) return false
  try {
    return getAddress(account.owner) === owner
  }
  catch {
    return false
  }
}

/**
 * Prefetched accounts the forms already loaded, valid for this wallet context.
 *
 * Read straight from the registry rather than accepting them per entry: the refs
 * a page would hand over (`usePlanAccount().account`,
 * `useEulerAccount().portfolio`) are layer-aware and resolve to the active
 * *simulated* layer once the batch is non-empty, which must never be adopted as
 * the batch's own layer 0. The registry only ever holds pre-overlay loader
 * output, so chain + owner is the whole validation.
 */
const resolvePrefetchedAccounts = (
  chainId: number,
  owner: Address,
): {
  planningAccount?: Account<IHasVaultAddress>
  baseAccount?: Account<IHasVaultAddress>
} => {
  const planningAccount = getBatchPrefetchedPlanningAccount()
  const baseAccount = getBatchPrefetchedBaseAccount()
  return {
    planningAccount: isAccountForContext(planningAccount, chainId, owner) ? planningAccount : undefined,
    baseAccount: isAccountForContext(baseAccount, chainId, owner) ? baseAccount : undefined,
  }
}

/**
 * `simulateTransactionPlan` only returns the *touched* slice of the account —
 * the sub-accounts/vaults the batch actually interacted with (that's all the
 * interspersed lens reads cover). Positions the user already held in untouched
 * vaults are absent. So we stitch each simulated (touched) layer onto the full
 * account carried up from the previous layer: keep every untouched position,
 * and overlay the touched ones (by vault address) with their post-operation
 * state. Enabled collateral/controller lists come from the simulated layer
 * (the EVC lens read returns the complete post-op lists).
 */
// Vaults (targetContract) and accounts (onBehalfOfAccount) an entry's plan
// touches — used to attribute deferred status-check failures back to the entry.
const collectPlanTargets = (
  plan: TransactionPlan,
): { vaults: Set<string>, accounts: Set<string> } => {
  const vaults = new Set<string>()
  const accounts = new Set<string>()
  for (const item of plan) {
    if (item.type !== 'evcBatch') continue
    for (const entry of item.items) {
      const batchItems = 'items' in entry ? entry.items : [entry]
      for (const it of batchItems) {
        try {
          vaults.add(getAddress(it.targetContract).toLowerCase())
        }
        catch { /* skip malformed address */ }
        try {
          accounts.add(getAddress(it.onBehalfOfAccount).toLowerCase())
        }
        catch { /* skip malformed address */ }
      }
    }
  }
  return { vaults, accounts }
}

type PriceableVaultCollateral = {
  address?: string
  borrowLTV?: number
  liquidationLTV?: number
  marketPriceUsd?: number
  vault?: PriceableVault
}
type PriceableVault = IHasVaultAddress & {
  asset?: { decimals?: number }
  collaterals?: PriceableVaultCollateral[]
  getCollateralRiskPrice?: (collateralVault: PriceableVault) => { priceBorrowing: bigint, priceLiquidation: bigint } | undefined
  marketPriceUsd?: number
}
type StitchLiquidityCollateral = {
  address: Address
  vault?: PriceableVault
  value?: { borrowing?: bigint, liquidation?: bigint, oracleMid?: bigint }
  marketPriceUsd?: number
  valueUsd?: number
}
type StitchLiquidity = {
  vaultAddress: Address
  vault?: PriceableVault
  unitOfAccount?: Address
  daysToLiquidation?: unknown
  liabilityValue?: { borrowing?: bigint, liquidation?: bigint, oracleMid?: bigint }
  totalCollateralValue?: { borrowing?: bigint, liquidation?: bigint, oracleMid?: bigint }
  collaterals: StitchLiquidityCollateral[]
  liabilityValueUsd?: number
  totalCollateralValueUsd?: number
}
type StitchPosition = {
  account?: Address
  vaultAddress: Address
  vault?: PriceableVault
  asset?: Address
  shares?: bigint
  assets?: bigint
  borrowed?: bigint
  isController?: boolean
  isCollateral?: boolean
  balanceForwarderEnabled?: boolean
  rewardStreams?: unknown[]
  liquidity?: StitchLiquidity
  marketPriceUsd?: number
  suppliedValueUsd?: number
  borrowedValueUsd?: number
}
type StitchSubAccount = {
  positions: StitchPosition[]
  enabledControllers?: Address[]
  enabledCollaterals?: Address[]
  timestamp?: number
  lastAccountStatusCheckTimestamp?: number
  liquidity?: unknown
  liabilityValueUsd?: number
}

const subAccountMapKey = (account: string): Address => getAddress(account) as Address

const mergePositionsByVault = (positions: StitchPosition[]): StitchPosition[] => {
  const byVault = new Map<string, StitchPosition>()
  for (const position of positions) {
    byVault.set(getAddress(position.vaultAddress), position)
  }
  return Array.from(byVault.values())
}

const cloneLiquidityValue = (
  value: StitchLiquidityCollateral['value'] | StitchLiquidity['liabilityValue'] | StitchLiquidity['totalCollateralValue'] | undefined,
) => value ? { ...value } : undefined

const cloneLiquidity = (liquidity: StitchLiquidity | undefined): StitchLiquidity | undefined =>
  liquidity
    ? {
        ...liquidity,
        liabilityValue: cloneLiquidityValue(liquidity.liabilityValue),
        totalCollateralValue: cloneLiquidityValue(liquidity.totalCollateralValue),
        collaterals: liquidity.collaterals.map(collateral => ({
          ...collateral,
          value: cloneLiquidityValue(collateral.value),
        })),
      }
    : undefined

const clonePosition = (position: StitchPosition): StitchPosition => ({
  ...position,
  rewardStreams: position.rewardStreams ? [...position.rewardStreams] : undefined,
  liquidity: cloneLiquidity(position.liquidity),
})

const vaultMarketPrice = (vault: PriceableVault | undefined): number | undefined => {
  const price = vault?.marketPriceUsd
  return typeof price === 'number' && Number.isFinite(price) ? price : undefined
}

const vaultCollateralPrice = (collateral: PriceableVaultCollateral | undefined): number | undefined => {
  const price = collateral?.marketPriceUsd
  return typeof price === 'number' && Number.isFinite(price) ? price : undefined
}

const maybeAddressKey = (address: string | undefined): string | undefined => {
  if (!address) return undefined
  try {
    return getAddress(address).toLowerCase()
  }
  catch {
    return address.toLowerCase()
  }
}

const cloneWithPrototype = <T extends object>(source: T, patch: Partial<T>): T => {
  const clone = Object.create(Object.getPrototypeOf(source)) as T
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(source))
  return Object.assign(clone, patch)
}

const mergeVaultPriceMetadata = (
  touched: PriceableVault | undefined,
  existing: PriceableVault | undefined,
): PriceableVault | undefined => {
  if (!touched) return existing
  if (!existing) return touched

  const existingCollaterals = existing.collaterals ?? []
  const touchedCollaterals = touched.collaterals ?? []
  const existingByAddress = new Map<string, PriceableVaultCollateral>()
  for (const collateral of existingCollaterals) {
    const key = maybeAddressKey(collateral.address)
    if (key) existingByAddress.set(key, collateral)
  }

  const seen = new Set<string>()
  const mergedCollaterals = touchedCollaterals.map((collateral) => {
    const key = maybeAddressKey(collateral.address)
    if (key) seen.add(key)
    const existingCollateral = key ? existingByAddress.get(key) : undefined
    const price = vaultCollateralPrice(collateral) ?? vaultCollateralPrice(existingCollateral)
    return price === undefined || price === collateral.marketPriceUsd
      ? collateral
      : { ...collateral, marketPriceUsd: price }
  })

  for (const collateral of existingCollaterals) {
    const key = maybeAddressKey(collateral.address)
    if (key && seen.has(key)) continue
    mergedCollaterals.push({ ...collateral })
  }

  const marketPriceUsd = vaultMarketPrice(touched) ?? vaultMarketPrice(existing)
  const needsVaultPatch = mergedCollaterals.length !== touchedCollaterals.length
    || mergedCollaterals.some((collateral, index) => collateral !== touchedCollaterals[index])
    || (marketPriceUsd !== undefined && touched.marketPriceUsd === undefined)
  if (!needsVaultPatch) return touched

  return cloneWithPrototype(touched, {
    marketPriceUsd: touched.marketPriceUsd ?? marketPriceUsd,
    collaterals: mergedCollaterals.length ? mergedCollaterals : touched.collaterals,
  })
}

const vaultAssetDecimals = (vault: PriceableVault | undefined): number | undefined => {
  const decimals = vault?.asset?.decimals
  return typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 ? decimals : undefined
}

const tokenAmountToUsdValue = (
  amount: bigint | undefined,
  decimals: number | undefined,
  priceUsd: number | undefined,
): number | undefined => {
  if (amount === undefined || decimals === undefined || priceUsd === undefined) return undefined
  return Number(formatUnits(amount, decimals)) * priceUsd
}

const positionPriceUsd = (position: StitchPosition): number | undefined => {
  const price = position.marketPriceUsd ?? vaultMarketPrice(position.vault)
  return typeof price === 'number' && Number.isFinite(price) ? price : undefined
}

const hydratePositionMarketValues = (position: StitchPosition): StitchPosition => {
  const price = positionPriceUsd(position)
  const decimals = vaultAssetDecimals(position.vault)
  if (price !== undefined) position.marketPriceUsd = price

  const suppliedValueUsd = tokenAmountToUsdValue(position.assets, decimals, price)
  if (suppliedValueUsd !== undefined) position.suppliedValueUsd = suppliedValueUsd
  else if ((position.assets ?? 0n) === 0n && (position.shares ?? 0n) === 0n) position.suppliedValueUsd = 0

  const borrowedValueUsd = tokenAmountToUsdValue(position.borrowed, decimals, price)
  if ((position.borrowed ?? 0n) === 0n) position.borrowedValueUsd = undefined
  else if (borrowedValueUsd !== undefined) position.borrowedValueUsd = borrowedValueUsd

  return position
}

const mergePositionData = (
  existing: StitchPosition | undefined,
  touched: StitchPosition,
): StitchPosition => {
  const next = clonePosition(touched)
  const sameSuppliedAmount = existing
    && (existing.assets ?? 0n) === (next.assets ?? 0n)
    && (existing.shares ?? 0n) === (next.shares ?? 0n)
  const sameBorrowAmount = existing
    && (existing.borrowed ?? 0n) === (next.borrowed ?? 0n)

  next.vault = mergeVaultPriceMetadata(next.vault, existing?.vault)
  next.marketPriceUsd = next.marketPriceUsd ?? vaultMarketPrice(next.vault) ?? existing?.marketPriceUsd ?? vaultMarketPrice(existing?.vault)
  if (sameSuppliedAmount) next.suppliedValueUsd = next.suppliedValueUsd ?? existing?.suppliedValueUsd
  if (sameBorrowAmount) next.borrowedValueUsd = next.borrowedValueUsd ?? existing?.borrowedValueUsd
  if (!next.liquidity && existing?.liquidity && (next.borrowed ?? 0n) > 0n) {
    next.liquidity = cloneLiquidity(existing.liquidity)
  }
  if ((next.borrowed ?? 0n) === 0n) {
    next.liquidity = undefined
  }

  return hydratePositionMarketValues(next)
}

const positionByVault = (positions: StitchPosition[]): Map<string, StitchPosition> => {
  const byVault = new Map<string, StitchPosition>()
  for (const position of positions) {
    byVault.set(getAddress(position.vaultAddress), position)
  }
  return byVault
}

const getPositionUsdValue = (position: StitchPosition | undefined): number | undefined => {
  if (!position) return undefined
  if (position.suppliedValueUsd !== undefined) return position.suppliedValueUsd
  return tokenAmountToUsdValue(position.assets, vaultAssetDecimals(position.vault), positionPriceUsd(position))
}

const WAD = 10n ** 18n
const LTV_DECIMALS = 12n
const LTV_SCALE = 10n ** LTV_DECIMALS

const ltvToWad = (ltv: number | undefined): bigint | undefined => {
  if (ltv === undefined || !Number.isFinite(ltv)) return undefined
  return BigInt(Math.round(ltv * Number(LTV_SCALE))) * (WAD / LTV_SCALE)
}

const applyLtv = (value: bigint, ltv: number | undefined): bigint | undefined => {
  const ltvWad = ltvToWad(ltv)
  return ltvWad === undefined ? undefined : (value * ltvWad) / WAD
}

const USD_SCALE = 1_000_000_000n

const numberToUsdScaledBigint = (value: number | undefined): bigint | undefined => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  return BigInt(Math.round(value * Number(USD_SCALE)))
}

type RiskValueScale = {
  valueUsd: bigint
  oracleMid: bigint
}

const buildRiskValueScale = (liquidity: StitchLiquidity): RiskValueScale | undefined => {
  const liabilityUsd = numberToUsdScaledBigint(liquidity.liabilityValueUsd)
  if (liabilityUsd !== undefined && liabilityUsd > 0n && (liquidity.liabilityValue?.oracleMid ?? 0n) > 0n) {
    return { valueUsd: liabilityUsd, oracleMid: liquidity.liabilityValue!.oracleMid! }
  }

  const collateralUsd = numberToUsdScaledBigint(liquidity.totalCollateralValueUsd)
  if (collateralUsd !== undefined && collateralUsd > 0n && (liquidity.totalCollateralValue?.oracleMid ?? 0n) > 0n) {
    return { valueUsd: collateralUsd, oracleMid: liquidity.totalCollateralValue!.oracleMid! }
  }

  return undefined
}

const usdValueToRiskValue = (
  valueUsd: number | undefined,
  scale: RiskValueScale | undefined,
): bigint | undefined => {
  const scaledUsd = numberToUsdScaledBigint(valueUsd)
  if (scaledUsd === undefined || scale === undefined || scale.valueUsd === 0n) return undefined
  return (scaledUsd * scale.oracleMid) / scale.valueUsd
}

const getBorrowCollateralMeta = (
  borrowVault: PriceableVault | undefined,
  collateralAddress: Address,
): PriceableVaultCollateral | undefined =>
  borrowVault?.collaterals?.find(collateral => maybeAddressKey(collateral.address) === collateralAddress.toLowerCase())

const getEffectiveLiquidationLtv = (collateral: PriceableVaultCollateral | undefined): number | undefined => {
  const current = (collateral as { currentLiquidationLTV?: number } | undefined)?.currentLiquidationLTV
  return typeof current === 'number' && Number.isFinite(current) ? current : collateral?.liquidationLTV
}

const hasCollateralRiskPrice = (borrowVault: PriceableVault, collateralVault: PriceableVault): boolean => {
  try {
    const riskPrice = borrowVault.getCollateralRiskPrice?.(collateralVault)
    return (riskPrice?.priceBorrowing ?? 0n) > 0n || (riskPrice?.priceLiquidation ?? 0n) > 0n
  }
  catch {
    return false
  }
}

const buildCurrentCollateralLiquidityValue = (
  borrow: StitchPosition,
  collateralPosition: StitchPosition | undefined,
  existing: StitchLiquidityCollateral | undefined,
  scale: RiskValueScale | undefined,
): StitchLiquidityCollateral['value'] | undefined => {
  const borrowVault = borrow.vault
  const collateralAddress = collateralPosition?.vaultAddress ?? existing?.address
  const collateralMeta = collateralAddress
    ? getBorrowCollateralMeta(borrowVault, getAddress(collateralAddress) as Address)
    : undefined
  const collateralVault = collateralPosition?.vault ?? existing?.vault ?? collateralMeta?.vault
  if (!borrowVault || !collateralVault) return cloneLiquidityValue(existing?.value)

  const currentValueUsd = getPositionUsdValue(collateralPosition)
  const existingValueUsd = existing?.valueUsd
  const currentMatchesExistingUsd = currentValueUsd === undefined
    || (
      existingValueUsd !== undefined
      && numberToUsdScaledBigint(currentValueUsd) === numberToUsdScaledBigint(existingValueUsd)
    )

  // Prefer the lens-provided risk values. They are denominated in the borrow's
  // unit-of-account scale — the same scale as the (lens-sourced) liability they're
  // measured against — so health/LTV stay consistent. Re-deriving from
  // getCollateralRiskPrice instead lands in WAD (it scales the oracle price by
  // 10^(18 - uoaDecimals)); divided against a uoa-decimals liability that inflates
  // the health score and zeroes the LTV on sub-18-decimal markets (e.g. AUSD = 6).
  // Real (non-simulated) positions use the lens values directly; so must we.
  // Once the simulated collateral amount changes, however, the lens value is for
  // the old amount and must be rescaled before it is added to the stitched total.
  if ((existing?.value?.oracleMid ?? 0n) > 0n && currentMatchesExistingUsd) {
    return cloneLiquidityValue(existing?.value)
  }

  if ((existing?.value?.oracleMid ?? 0n) <= 0n && !hasCollateralRiskPrice(borrowVault, collateralVault)) {
    return undefined
  }

  // Collateral the borrow's lens read didn't include (e.g. one enabled later in
  // the batch by a collateral swap). Derive its risk value through the liability's
  // own usd<->risk ratio so it lands in the same unit-of-account scale, then
  // risk-adjust by the configured LTVs.
  const valueUsd = currentValueUsd ?? existingValueUsd
  const oracleMid = usdValueToRiskValue(valueUsd, scale)
  if (oracleMid === undefined) return cloneLiquidityValue(existing?.value)

  // Collateral the borrow vault doesn't accept (no meta) contributes zero
  // risk-adjusted value — not the full oracle price. Otherwise leftover
  // EVC-enabled collateral the controller won't credit would inflate the
  // simulated health/LTV. Likewise an unconfigured LTV defaults to zero.
  if (!collateralMeta) return cloneLiquidityValue(existing?.value)

  return {
    borrowing: applyLtv(oracleMid, collateralMeta.borrowLTV) ?? 0n,
    liquidation: applyLtv(oracleMid, getEffectiveLiquidationLtv(collateralMeta)) ?? 0n,
    oracleMid,
  }
}

const zeroLiquidityValue = (): NonNullable<StitchLiquidityCollateral['value']> => ({
  borrowing: 0n,
  liquidation: 0n,
  oracleMid: 0n,
})

const hydrateBorrowLiquidity = (
  borrow: StitchPosition,
  positions: StitchPosition[],
  enabledCollaterals: Address[] | undefined,
  baseEnabledCollaterals: Address[] | undefined,
): void => {
  const liquidity = borrow.liquidity
  if (!liquidity || (borrow.borrowed ?? 0n) === 0n) return

  const positionsByVault = positionByVault(positions)
  liquidity.vault = liquidity.vault ?? borrow.vault
  liquidity.liabilityValueUsd = borrow.borrowedValueUsd
  const borrowVaultKey = getAddress(borrow.vaultAddress).toLowerCase()

  const existingCollaterals = new Map<string, StitchLiquidityCollateral>()
  for (const collateral of liquidity.collaterals) {
    existingCollaterals.set(getAddress(collateral.address).toLowerCase(), collateral)
  }
  const enabledCollateralKeys = enabledCollaterals?.map(address => getAddress(address).toLowerCase())
  const enabledCollateralSet = enabledCollateralKeys ? new Set(enabledCollateralKeys) : undefined
  // Collaterals that were already enabled on the EVC *before* this batch ran.
  // Used to tell a collateral newly enabled by the batch (e.g. a collateral
  // swap) apart from a pre-existing, possibly empty, enablement.
  const baseEnabledCollateralSet = baseEnabledCollaterals
    ? new Set(baseEnabledCollaterals.map(address => getAddress(address).toLowerCase()))
    : undefined
  const collateralAddresses: Address[] = []
  const seen = new Set<string>()
  const addCollateralAddress = (address: string, requireEnabledOrValue: boolean) => {
    const key = getAddress(address).toLowerCase()
    if (seen.has(key)) return
    // A vault is never its own collateral. The EVC can list the borrow vault in
    // enabledCollaterals, and its own position carries debt (so it passes the
    // value guard below), but the controller grants it no LTV — the lens omits
    // it from liquidity.collaterals and so must we, or it surfaces as a spurious
    // zero-value collateral row.
    if (key === borrowVaultKey) return
    const collateralPosition = positionsByVault.get(getAddress(address))
    const hasBalance = hasPositionValue(collateralPosition)
    const isEnabled = enabledCollateralSet?.has(key) ?? true
    if (requireEnabledOrValue && enabledCollateralSet && !isEnabled && !hasBalance) return
    if (requireEnabledOrValue && enabledCollateralSet && !isEnabled) return
    if (requireEnabledOrValue && !hasBalance && !existingCollaterals.has(key)) return
    seen.add(key)
    collateralAddresses.push(getAddress(address) as Address)
  }
  for (const collateral of liquidity.collaterals) addCollateralAddress(collateral.address, true)
  // EVC-enabled collaterals. A collateral *newly* enabled by this batch (not in
  // the base enabled set) is added unconditionally, since its simulated balance
  // may not be populated on this position yet — this is what surfaces a
  // collateral-swap's new collateral. A collateral that was already enabled
  // before the batch is added under the same guard as the lens collaterals
  // above, so leftover enabled-but-empty vaults (an account can carry several)
  // don't show up as spurious zero-value collateral rows. When the base set is
  // unknown (a brand-new sub-account), every enabled collateral is treated as
  // newly enabled, preserving the prior unconditional behaviour.
  for (const collateral of enabledCollateralKeys ?? []) {
    const wasEnabledBeforeBatch = baseEnabledCollateralSet?.has(collateral) ?? false
    addCollateralAddress(collateral, wasEnabledBeforeBatch)
  }

  let totalCollateralValueUsd: number | undefined = collateralAddresses.length ? 0 : liquidity.totalCollateralValueUsd
  let hasMissingCollateralUsd = false
  const totalCollateralValue = collateralAddresses.length
    ? { borrowing: 0n, liquidation: 0n, oracleMid: 0n }
    : cloneLiquidityValue(liquidity.totalCollateralValue)
  const nextCollaterals: StitchLiquidityCollateral[] = []
  const riskValueScale = buildRiskValueScale(liquidity)

  for (const collateralAddress of collateralAddresses) {
    const key = collateralAddress.toLowerCase()
    const existing = existingCollaterals.get(key)
    const collateralPosition = positionsByVault.get(collateralAddress)
    const collateralMeta = getBorrowCollateralMeta(borrow.vault, collateralAddress)
    const value = buildCurrentCollateralLiquidityValue(borrow, collateralPosition, existing, riskValueScale) ?? zeroLiquidityValue()
    const vault = existing?.vault ?? collateralPosition?.vault ?? collateralMeta?.vault
    const valueUsd = getPositionUsdValue(collateralPosition) ?? existing?.valueUsd
    nextCollaterals.push({
      ...(existing ? { ...existing } : { address: collateralAddress }),
      address: collateralAddress,
      vault,
      marketPriceUsd: existing?.marketPriceUsd ?? vaultMarketPrice(vault) ?? collateralMeta?.marketPriceUsd,
      value,
      valueUsd: valueUsd ?? existing?.valueUsd,
    })

    if (totalCollateralValue) {
      totalCollateralValue.borrowing = (totalCollateralValue.borrowing ?? 0n) + (value.borrowing ?? 0n)
      totalCollateralValue.liquidation = (totalCollateralValue.liquidation ?? 0n) + (value.liquidation ?? 0n)
      totalCollateralValue.oracleMid = (totalCollateralValue.oracleMid ?? 0n) + (value.oracleMid ?? 0n)
    }
    if (valueUsd === undefined) {
      hasMissingCollateralUsd = true
      continue
    }
    totalCollateralValueUsd = (totalCollateralValueUsd ?? 0) + valueUsd
  }

  liquidity.collaterals = nextCollaterals
  if (totalCollateralValue) liquidity.totalCollateralValue = totalCollateralValue
  liquidity.totalCollateralValueUsd = hasMissingCollateralUsd ? undefined : totalCollateralValueUsd
}

const hydrateStitchedPositions = (
  positions: StitchPosition[],
  enabledCollaterals: Address[] | undefined,
  baseEnabledCollaterals: Address[] | undefined,
): StitchPosition[] => {
  for (const position of positions) hydratePositionMarketValues(position)
  for (const position of positions) hydrateBorrowLiquidity(position, positions, enabledCollaterals, baseEnabledCollaterals)
  return positions
}

export interface ModifiedPositionKeySets {
  any: Set<string>
  balance: Set<string>
  debt: Set<string>
}

const emptyModifiedPositionKeySets = (): ModifiedPositionKeySets => ({
  any: new Set<string>(),
  balance: new Set<string>(),
  debt: new Set<string>(),
})

const positionModifiedKey = (subAccount: Address, vault: Address): string =>
  `${subAccount.toLowerCase()}:${vault.toLowerCase()}`

const buildClosedPositionMap = (
  closedPositions: BatchClosedPosition[],
): Map<string, Set<string>> => {
  const bySubAccount = new Map<string, Set<string>>()
  for (const position of closedPositions) {
    const subAccount = getAddress(position.subAccount).toLowerCase()
    const vault = getAddress(position.vault).toLowerCase()
    const vaults = bySubAccount.get(subAccount) ?? new Set<string>()
    vaults.add(vault)
    bySubAccount.set(subAccount, vaults)
  }
  return bySubAccount
}

const applyClosedPositions = (
  account: Account<IHasVaultAddress>,
  closedPositions: BatchClosedPosition[],
): Account<IHasVaultAddress> => {
  if (!closedPositions.length) return account

  const closedBySubAccount = buildClosedPositionMap(closedPositions)
  const subAccounts: Record<string, StitchSubAccount> = {}
  let changed = false

  for (const [addr, sa] of Object.entries(account.subAccounts)) {
    if (!sa) continue
    const subAccount = subAccountMapKey(addr)
    const closedVaults = closedBySubAccount.get(subAccount.toLowerCase())
    const positions = sa.positions
      .filter((position) => {
        if (!closedVaults?.size) return true
        return !closedVaults.has(getAddress(position.vaultAddress).toLowerCase())
      })
      .map(position => clonePosition(position as StitchPosition))

    if (positions.length !== sa.positions.length) changed = true
    subAccounts[subAccount] = {
      ...sa,
      positions: hydrateStitchedPositions(positions, sa.enabledCollaterals, sa.enabledCollaterals),
    }
  }

  if (!changed) return account

  const next = new Account({
    chainId: account.chainId,
    owner: account.owner,
    isLockdownMode: account.isLockdownMode,
    isPermitDisabledMode: account.isPermitDisabledMode,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subAccounts: subAccounts as any,
    populated: account.populated,
  }) as Account<IHasVaultAddress>
  next.userRewards = account.userRewards
  next.populated.userRewards = account.populated.userRewards
  return next
}

const getAccountSubAccount = (
  account: Account<IHasVaultAddress>,
  subAccount: Address,
) => {
  const direct = account.subAccounts[subAccount]
  if (direct) return direct
  const normalized = subAccount.toLowerCase()
  return Object.entries(account.subAccounts).find(([addr]) => {
    try {
      return getAddress(addr).toLowerCase() === normalized
    }
    catch {
      return false
    }
  })?.[1]
}

const findAccountPosition = (
  account: Account<IHasVaultAddress>,
  subAccount: Address,
  vault: Address,
) => {
  const sa = getAccountSubAccount(account, subAccount)
  const normalizedVault = vault.toLowerCase()
  return sa?.positions.find((position) => {
    try {
      return getAddress(position.vaultAddress).toLowerCase() === normalizedVault
    }
    catch {
      return false
    }
  })
}

const hasPositionValue = (position: Pick<StitchPosition, 'shares' | 'borrowed'> | undefined): boolean =>
  ((position?.shares ?? 0n) !== 0n) || ((position?.borrowed ?? 0n) !== 0n)

export const buildModifiedPositionKeySets = (
  current: Account<IHasVaultAddress> | undefined,
  base: Account<IHasVaultAddress> | undefined,
): ModifiedPositionKeySets => {
  const sets = emptyModifiedPositionKeySets()
  if (!current || !base) return sets

  for (const [addr, sa] of Object.entries(current.subAccounts)) {
    if (!sa) continue
    const subAccount = subAccountMapKey(addr)
    const baseSa = getAccountSubAccount(base, subAccount)
    for (const p of sa.positions) {
      const vault = getAddress(p.vaultAddress) as Address
      const bp = baseSa?.positions.find(x => getAddress(x.vaultAddress) === vault)
      const key = positionModifiedKey(subAccount, vault)
      if ((bp?.shares ?? 0n) !== (p.shares ?? 0n)) {
        sets.balance.add(key)
        sets.any.add(key)
      }
      if ((bp?.borrowed ?? 0n) !== (p.borrowed ?? 0n)) {
        sets.debt.add(key)
        sets.any.add(key)
      }
    }
  }

  return sets
}

export const buildRemovedPositionKeySets = (
  current: Account<IHasVaultAddress> | undefined,
  base: Account<IHasVaultAddress> | undefined,
): Set<string> => {
  const removed = new Set<string>()
  if (!current || !base) return removed

  for (const [addr, sa] of Object.entries(base.subAccounts)) {
    if (!sa) continue
    const subAccount = subAccountMapKey(addr)
    for (const p of sa.positions) {
      if (!hasPositionValue(p)) continue
      const vault = getAddress(p.vaultAddress) as Address
      const currentPosition = findAccountPosition(current, subAccount, vault)
      if (!hasPositionValue(currentPosition)) {
        removed.add(positionModifiedKey(subAccount, vault))
      }
    }
  }

  return removed
}

export const filterPositionKeysByOwner = (
  keys: Set<string>,
  ownerSubAccount?: string,
  scopedSubAccounts?: Set<string>,
): Set<string> => {
  if (!ownerSubAccount || !scopedSubAccounts?.size || scopedSubAccounts.has(ownerSubAccount)) {
    return new Set(keys)
  }

  return new Set([...keys].filter((key) => {
    const [subAccount] = key.split(':')
    return subAccount !== ownerSubAccount
  }))
}

export const filterModifiedPositionKeySetsByOwner = (
  sets: ModifiedPositionKeySets,
  ownerSubAccount?: string,
  scopedSubAccounts?: Set<string>,
): ModifiedPositionKeySets => ({
  any: filterPositionKeysByOwner(sets.any, ownerSubAccount, scopedSubAccounts),
  balance: filterPositionKeysByOwner(sets.balance, ownerSubAccount, scopedSubAccounts),
  debt: filterPositionKeysByOwner(sets.debt, ownerSubAccount, scopedSubAccounts),
})

const getDepositPositionVaultAddress = (
  position: PortfolioSavingsPosition<VaultEntity>,
): Address => getAddress(position.position.vaultAddress) as Address

const getBorrowPositionVaultAddress = (
  position: PortfolioBorrowPosition<VaultEntity>,
): Address => getAddress(position.borrow.vaultAddress) as Address

const getBorrowPositionCollateralAddresses = (
  position: PortfolioBorrowPosition<VaultEntity>,
): Address[] => {
  const addresses = new Set<Address>()
  const add = (address: string | undefined) => {
    if (!address) return
    try {
      addresses.add(getAddress(address) as Address)
    }
    catch { /* skip malformed address */ }
  }

  for (const address of position.collateralVaults ?? []) add(address)
  add(position.collateral?.vaultAddress)
  add(position.collateralVault?.address)

  return Array.from(addresses)
}

const getBorrowPortfolioPositionKey = (position: PortfolioBorrowPosition<VaultEntity>): string => {
  return buildBorrowPortfolioPositionKey(
    position.subAccount,
    getBorrowPositionVaultAddress(position),
    getBorrowPositionCollateralAddresses(position),
  )
}

const getDepositPortfolioPositionKey = (position: PortfolioSavingsPosition<VaultEntity>): string =>
  positionModifiedKey(getAddress(position.subAccount) as Address, getDepositPositionVaultAddress(position))

const isRemovedBorrowPosition = (
  position: PortfolioBorrowPosition<VaultEntity>,
  removedKeys: Set<string>,
): boolean => {
  const subAccount = getAddress(position.subAccount) as Address
  const borrowKey = positionModifiedKey(subAccount, getBorrowPositionVaultAddress(position))
  const collateralKeys = getBorrowPositionCollateralAddresses(position).map(vault =>
    positionModifiedKey(subAccount, vault),
  )
  return removedKeys.has(borrowKey)
    && collateralKeys.length > 0
    && collateralKeys.every(key => removedKeys.has(key))
}

export const getRemovedBorrowPositions = (
  base: Portfolio<VaultEntity> | undefined,
  current: Portfolio<VaultEntity> | undefined,
  removedKeys: Set<string>,
  refinanceReplacementBorrowPositionKeys: Set<string> = new Set(),
): PortfolioBorrowPosition<VaultEntity>[] => {
  if (!base || !current) return []
  const currentKeys = new Set(current.borrows.map(getBorrowPortfolioPositionKey))
  return base.borrows.filter(position =>
    !currentKeys.has(getBorrowPortfolioPositionKey(position))
    && !refinanceReplacementBorrowPositionKeys.has(getBorrowPortfolioPositionKey(position))
    && isRemovedBorrowPosition(position, removedKeys),
  )
}

const getRemovedDepositPositions = (
  base: Portfolio<VaultEntity> | undefined,
  current: Portfolio<VaultEntity> | undefined,
  removedKeys: Set<string>,
): PortfolioSavingsPosition<VaultEntity>[] => {
  if (!base || !current) return []
  const currentKeys = new Set(current.savings.map(getDepositPortfolioPositionKey))
  return base.savings.filter((position) => {
    const key = getDepositPortfolioPositionKey(position)
    return !currentKeys.has(key) && removedKeys.has(key)
  })
}

export const stitchAccount = (
  prevFull: Account<IHasVaultAddress>,
  touched: Account<IHasVaultAddress>,
): Account<IHasVaultAddress> => {
  // Reward + intrinsic-APY metadata is populated directly on the simulated
  // vaults by simulateTransactionPlan (vaultFetchOptions), matching the base
  // account's populateAll. The simulated account only contains the touched
  // slice, so we merge positions first and then recompute USD fields that depend
  // on the full sub-account context.
  const mergedSubs: Record<string, StitchSubAccount> = {}
  for (const [addr, sa] of Object.entries(prevFull.subAccounts)) {
    if (!sa) continue
    const key = subAccountMapKey(addr)
    const existing = mergedSubs[key]
    mergedSubs[key] = {
      ...sa,
      ...(existing ?? {}),
      positions: mergePositionsByVault([
        ...(existing?.positions ?? []),
        ...sa.positions.map(position => clonePosition(position as StitchPosition)),
      ]),
    }
  }
  for (const [addr, tsa] of Object.entries(touched.subAccounts)) {
    if (!tsa) continue
    const key = subAccountMapKey(addr)
    const existing = mergedSubs[key]
    if (!existing) {
      mergedSubs[key] = {
        ...tsa,
        positions: hydrateStitchedPositions(
          mergePositionsByVault(tsa.positions.map(position => clonePosition(position as StitchPosition))),
          tsa.enabledCollaterals,
          // No base sub-account: every enabled collateral is treated as new.
          undefined,
        ),
      }
      continue
    }
    const byVault = new Map<string, StitchPosition>()
    for (const p of existing.positions) byVault.set(getAddress(p.vaultAddress), p)
    for (const tp of tsa.positions) {
      const vault = getAddress(tp.vaultAddress)
      byVault.set(vault, mergePositionData(byVault.get(vault), tp as StitchPosition))
    }
    // `existing` is still the pre-batch (prevFull) sub-account here — it isn't
    // overwritten with the simulated EVC state until below — so its enabled
    // collaterals are the base set against which `tsa.enabledCollaterals` is the
    // post-batch state.
    const positions = hydrateStitchedPositions(
      Array.from(byVault.values()),
      tsa.enabledCollaterals,
      existing.enabledCollaterals,
    )
    mergedSubs[key] = {
      ...existing,
      // Post-op EVC state for this sub-account comes from the simulated layer.
      enabledControllers: tsa.enabledControllers,
      enabledCollaterals: tsa.enabledCollaterals,
      timestamp: tsa.timestamp,
      lastAccountStatusCheckTimestamp: tsa.lastAccountStatusCheckTimestamp,
      // Carry the simulated liquidity so the health-factor / current-LTV /
      // liquidation-LTV getters (and the position summary + risk values that read
      // them) reflect the post-op state, not the stale base-layer liquidity.
      liquidity: (tsa as { liquidity?: unknown }).liquidity,
      liabilityValueUsd: (tsa as { liabilityValueUsd?: number }).liabilityValueUsd,
      positions,
    }
  }
  const account = new Account({
    chainId: prevFull.chainId,
    owner: prevFull.owner,
    isLockdownMode: touched.isLockdownMode,
    isPermitDisabledMode: touched.isPermitDisabledMode,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subAccounts: mergedSubs as any,
    populated: prevFull.populated,
  }) as Account<IHasVaultAddress>
  account.userRewards = touched.populated.userRewards
    ? touched.userRewards
    : prevFull.userRewards
  account.populated.userRewards = touched.populated.userRewards || prevFull.populated.userRewards
  return account
}

// Project a layer's account into both portfolio views the UI can show:
// `visible` mirrors the default verified-filtered view, `all` mirrors the
// "Show all" toggle. Using useEulerAccount's exact filter keeps the simulated
// view consistent with real-state filtering.
const projectPortfolio = (
  sdk: Awaited<ReturnType<typeof getEulerSdkFresh>>,
  account: Account<IHasVaultAddress>,
): { visible?: Portfolio<VaultEntity>, all?: Portfolio<VaultEntity> } => {
  const acc = account as Account<VaultEntity>
  let all: Portfolio<VaultEntity> | undefined
  let visible: Portfolio<VaultEntity> | undefined
  try {
    all = sdk.portfolioService.buildPortfolio(acc)
  }
  catch (error) {
    logWarn('useTxBatch/projectPortfolio(all)', error)
  }
  try {
    visible = sdk.portfolioService.buildPortfolio(acc, {
      positionFilter: buildVisiblePortfolioPositionFilter(),
    })
  }
  catch (error) {
    logWarn('useTxBatch/projectPortfolio(visible)', error)
    visible = all
  }
  return { visible, all }
}

const getEntryMarketLabelOverride = (entry: BatchEntry): string | undefined => {
  const label = entry.review?.marketLabel
  return typeof label === 'string' && label.trim() ? label : undefined
}

/**
 * Resolve the post-cart "final layer" account for planning the next batch op,
 * retrying across superseded resimulations.
 *
 * A resimulation can be superseded mid-flight (a newer run shares `resimToken`
 * and the loser returns early WITHOUT populating layers or `simError`), so a
 * single await can resolve before our final layer exists. Each pass awaits the
 * current run — `getInFlight() ?? startRun()` both starts a fresh run when none
 * is in flight AND awaits it — so every run this loop starts is awaited before
 * we re-check or fall through to the throw. (Critically: no run is ever started
 * on the terminal iteration without being awaited, which would otherwise re-throw
 * "Batch simulation not loaded" while a fresh run was still in flight.)
 *
 * Extracted from `getEntryPlanningAccount` so the superseded-run/retry invariant
 * is unit-testable without the SDK; see tests/composables/useTxBatch.test.ts.
 */
export const awaitFinalPlanningLayer = async <T>(opts: {
  getFinalLayer: () => T | undefined
  getSimError: () => string | undefined
  getInFlight: () => Promise<void> | null
  startRun: () => Promise<void>
  maxAttempts?: number
  onAttempt?: (info: { attempt: number, awaitedExisting: boolean, found: boolean }) => void
}): Promise<T> => {
  const { getFinalLayer, getSimError, getInFlight, startRun, maxAttempts = 8, onAttempt } = opts
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const inFlight = getInFlight()
    await (inFlight ?? startRun())
    const layer = getFinalLayer()
    onAttempt?.({ attempt, awaitedExisting: inFlight !== null, found: layer !== undefined })
    if (layer !== undefined) return layer
    // A real error is terminal; stop retrying and surface it below. Otherwise the
    // run was superseded — loop and await whatever run is current next pass.
    if (getSimError()) break
  }
  throw new Error(getSimError() ?? 'Batch simulation not loaded')
}

export const useTxBatch = () => {
  const { chainId: wagmiChainId, connector } = useWagmi()
  const { effectiveAddress } = useEffectiveAddress()
  const { chainId: addressesChainId } = useEulerAddresses()
  const { scheduleExternalMigrationRefreshes } = useExternalMigrationRefresh()

  const owner = computed(
    () => effectiveAddress.value as Address | undefined,
  )
  const chainId = computed(() => wagmiChainId.value ?? addressesChainId.value)
  const { prepareTransactionPlan, executePreparedPlan, executePreparedPlanWithPlainCalls, estimateGasForPreparedPlan, sendPlainTransactions } = useEulerTx()
  const { isSafeWallet, isSafeWalletResolved } = useSafeWallet()
  const connectorKey = computed(() => {
    const current = connector.value
    return current ? `${current.id}:${current.uid}` : undefined
  })
  const { restorePendingBeforeRetry, revokeAfterSuccess, revokeAfterAbort } = useMigrationAuthorizationFlow()
  const { getTokenByAddress } = useTokenList()
  const ownerSubAccountKey = computed(() => {
    try {
      return owner.value ? getAddress(owner.value).toLowerCase() : undefined
    }
    catch {
      return undefined
    }
  })

  const resimulate = async () => {
    const token = ++resimToken
    const o = owner.value
    const cid = chainId.value
    logBatchDiag('resimulate:start', { token, owner: o, chainId: cid })

    if (!o || !cid || entries.value.length === 0) {
      logBatchDiag('resimulate:empty-batch-reset', {
        token,
        reason: !o ? 'no-owner' : !cid ? 'no-chain' : 'no-entries',
      })
      layers.value = []
      activeLayer.value = 0
      simError.value = undefined
      execError.value = undefined
      walletShortfalls.value = []
      lastMerged = null
      baseAccountSnapshot = null
      batchSlotHints = {}
      syncOverlay()
      return
    }

    const ownerAddr = getAddress(o)
    const isResimulationContextCurrent = (): boolean => {
      if (token !== resimToken || chainId.value !== cid || !owner.value) return false
      try {
        return getAddress(owner.value) === ownerAddr
      }
      catch {
        return false
      }
    }

    isSimulating.value = true
    // NOTE: deliberately do NOT clear simError / walletShortfalls here. A new
    // simulation runs on every add/remove/reorder; clearing up-front would make a
    // prior error flicker away while the next sim is in flight. They're set
    // atomically on completion below (and cleared on the empty-batch path above).
    try {
      const sdk = await getEulerSdkFresh()
      // Keep the real base state fixed for the lifetime of the cart. Entry plans
      // are immutable add-time payloads; later real-state drift should not cause
      // the whole batch to rebuild around a different base account.
      const baseAccount = baseAccountSnapshot
        ?? resolvePrefetchedAccounts(cid, ownerAddr).baseAccount
        ?? await fetchBaseAccountSnapshot(sdk, cid, ownerAddr)
      if (!isResimulationContextCurrent()) {
        logBatchDiag('resimulate:superseded-after-base-fetch', { token, supersededBy: resimToken }, 'error')
        return
      }
      baseAccountSnapshot = baseAccount

      const plans = entries.value.map(entry => entry.plan)
      const extraStateOverrides = mergeStateOverrides(
        entries.value.flatMap(entry => entry.stateOverrides ?? []),
      )

      // One simulation, all layers. The SDK interleaves lens reads per
      // operation and returns simulatedAccounts = [base, afterOp0, afterOp1, …]
      // plus per-operation revert attribution via failedBatchItems.
      const merged = sdk.executionService.mergePlans(plans)
      const sim = await sdk.executionService.simulateTransactionPlan(
        cid,
        ownerAddr,
        merged,
        {
          stateOverrides: true,
          stateOverrideOptions: { slotHints: batchSlotHints },
          extraStateOverrides,
          // Populate the simulated vaults with reward campaigns + intrinsic
          // (e.g. staking) APY, exactly as the base account is via populateAll —
          // so the simulated portfolio's net APY / ROE and per-position
          // supply/borrow costs include them, including for vaults entered for
          // the first time in the batch (which the base account can't supply).
          // The chain-wide reward/intrinsic maps are cached (5-min staleTime,
          // shared QueryClient already filled by the real portfolio load), so
          // this adds no per-resim network cost in practice.
          vaultFetchOptions: { populateRewards: true, populateIntrinsicApy: true },
        },
      )

      if (!isResimulationContextCurrent()) {
        // A newer resimulation superseded this one after the sim resolved, so this
        // run bails before populating layers. When that happens during a plan-time
        // await it's exactly what surfaces as the misleading "Batch simulation not
        // loaded" (see getEntryPlanningAccount). Logged at error so it surfaces in
        // the field even without verbose mode.
        logBatchDiag('resimulate:superseded-after-sim', { token, supersededBy: resimToken }, 'error')
        return
      }
      lastMerged = merged

      // Two distinct failure shapes, both blocking but handled differently:
      //  - simulationError: the EVC call reverted at the top level (couldn't even
      //    decode the batch) — no per-layer state exists.
      //  - account/vault status-check failure: every batch item executed (so the
      //    per-layer simulated state IS populated — e.g. a borrow shows the debt
      //    and the borrowed tokens in the wallet), but the *deferred* health/vault
      //    checks at the end of the batch failed, so the real `batch` tx would
      //    revert. We still surface the simulated "impossible" position; we just
      //    flag the batch and block execution.
      const statusCheckFailed = !!(sim.accountStatusErrors?.length || sim.vaultStatusErrors?.length)
      // Set/clear atomically (see the note above resimulate's try): overwrite the
      // prior error only once this simulation resolves, so it doesn't flicker.
      simError.value = (sim.simulationError || statusCheckFailed) ? describeFailure(sim) : undefined

      // The SDK returns only the *touched* slice per layer (sim.simulatedAccounts
      // = [pre-batch, afterOp0, afterOp1, …]). Build full accounts by stitching:
      // layer 0 is the full real account; each subsequent layer overlays that
      // layer's touched positions onto the previous full account. This preserves
      // the user's existing positions in vaults the batch never touched.
      const rawSimAccounts = (sim.simulatedAccounts ?? []) as Account<IHasVaultAddress>[]
      const paddedSimAccounts = rawSimAccounts.length === plans.length
        ? [baseAccount, ...rawSimAccounts]
        : rawSimAccounts
      // The simulator emits one layer per SDK operation — where an operation
      // is any top-level batch unit, so plan plugins (ToS registration, Pyth
      // updates) contribute prefix operations and a single cart entry may
      // contribute several (collateral+debt refinance). Map those operations
      // back to cart entries explicitly: each entry's display layer is the
      // state after its LAST operation, plugin prefix layers fold into the
      // base, and failedBatchItems.operationIndex resolves through the same
      // map so failures mark the right row.
      const simulatedOperationCount = Math.max(0, paddedSimAccounts.length - 1)
      const operationMap = buildOperationEntryMap(plans, simulatedOperationCount)
      if (operationMap && operationMap.pluginOperations > 0) {
        logBatchDiag('resimulate:plugin-operations-mapped', {
          token,
          pluginOperations: operationMap.pluginOperations,
          operationCounts: operationMap.operationCounts,
          simulatedOperationCount,
        }, 'warn')
      }
      const selectEntryLayers = <T>(baseInclusiveLayers: T[]): T[] => [
        baseInclusiveLayers[0]!,
        ...(operationMap?.entryLayerIndices ?? []).map(k => baseInclusiveLayers[k]!),
      ]
      const simAccounts = operationMap ? selectEntryLayers(paddedSimAccounts) : paddedSimAccounts
      const rawSimVaultLayers = sim.simulatedVaultsLayers ?? []
      const normalizedSimVaultLayers = normalizeSimulatedVaultLayers(rawSimVaultLayers, simulatedOperationCount)
      const simVaultLayers = normalizedSimVaultLayers === null || normalizedSimVaultLayers.length === 0
        ? []
        : operationMap
          ? selectEntryLayers(normalizedSimVaultLayers)
          : normalizedSimVaultLayers
      if (normalizedSimVaultLayers === null) {
        logBatchDiag('resimulate:vault-layer-cardinality-invalid', {
          token,
          rawVaultLayers: rawSimVaultLayers.length,
          simulatedOperationCount,
          acceptedVaultLayerCounts: [0, simulatedOperationCount, simulatedOperationCount + 1],
        }, 'error')
      }
      // After entry-boundary selection a healthy sim yields exactly
      // entries + 1 layers (getCurrentFinalLayer's contract). A null map means
      // the simulated plan carries FEWER operations than the entry plans
      // declare — an SDK build without layered simulation, or a plan-shape
      // disagreement — and the layers cannot be trusted.
      logBatchDiag(
        'resimulate:sim-resolved',
        {
          token,
          rawSimAccounts: rawSimAccounts.length,
          simAccounts: simAccounts.length,
          plans: plans.length,
          simulatedOperationCount,
          pluginOperations: operationMap?.pluginOperations ?? null,
          expectedLayers: plans.length + 1,
          countMatchesExpected: simAccounts.length === plans.length + 1,
          simulationError: !!sim.simulationError,
          statusCheckFailed,
          simError: simError.value ?? null,
        },
        simAccounts.length === plans.length + 1 ? 'warn' : 'error',
      )
      if (!simError.value && !operationMap) {
        logBatchDiag('resimulate:version-guard-tripped', {
          token,
          simulatedOperationCount,
          plans: plans.length,
        }, 'error')
        simError.value = 'Batch simulation did not return per-operation state layers — the installed @eulerxyz/euler-v2-sdk build does not support the batch builder.'
      }

      // Preserve the SDK's per-layer vault snapshots independently from account
      // positions. This is the authoritative source for utilization after an
      // operation, including a full withdrawal that removes its zeroed position
      // from the simulated account. Older/final-only SDK shapes fall back to the
      // vault entities carried by each touched account slice.
      const vaultLayers: LayeredVaultMap[] = []
      let cumulativeVaults: LayeredVaultMap = {}
      for (let i = 0; i < simAccounts.length; i++) {
        cumulativeVaults = mergeLayeredVaults(cumulativeVaults, collectAccountVaults(simAccounts[i]))
        cumulativeVaults = mergeLayeredVaults(cumulativeVaults, simVaultLayers[i] ?? [])
        vaultLayers.push(cumulativeVaults)
      }

      const fullLayers: Account<IHasVaultAddress>[] = [baseAccount]
      const cumulativeClosedPositions: BatchClosedPosition[] = []
      for (let i = 1; i < simAccounts.length; i++) {
        const entry = entries.value[i - 1]
        if (entry?.closedPositions?.length) cumulativeClosedPositions.push(...entry.closedPositions)
        const stitched = stitchAccount(fullLayers[i - 1]!, simAccounts[i]!)
        const closed = applyClosedPositions(stitched, cumulativeClosedPositions)
        fullLayers.push(closed)
      }

      // Wallet balances: same stitch as the account. The real wallet (from the
      // SDK wallet service) is the layer-0 base; each layer overlays the touched
      // assets' simulated balance. In-sim balances are forged, so the forge
      // cancels in the per-layer delta vs the pre-batch layer.
      const normalizeWalletKey = (token: string) => {
        try {
          return getAddress(token).toLowerCase()
        }
        catch {
          return token.toLowerCase()
        }
      }
      const normalizeWalletBalances = (balances: Record<string, bigint>) => {
        const out: Record<string, bigint> = {}
        for (const [token, balance] of Object.entries(balances)) {
          out[normalizeWalletKey(token)] = balance
        }
        return out
      }
      const rawSimWb = (sim as BatchSimulationWalletBalances).simulatedWalletBalances ?? []
      // Same base-inclusive normalization + entry-boundary selection as the
      // account/vault layers, so wallet indices keep mapping to cart entries.
      const baseInclusiveSimWb = rawSimWb.length === simulatedOperationCount
        ? [{}, ...rawSimWb]
        : rawSimWb
      const selectedSimWb = operationMap && baseInclusiveSimWb.length === simulatedOperationCount + 1
        ? selectEntryLayers(baseInclusiveSimWb)
        : baseInclusiveSimWb
      const simWb = selectedSimWb.map(normalizeWalletBalances)
      const touchedTokens = collectWalletBalanceTokens(simWb)
      const realWallet: Record<string, bigint> = {}
      if (touchedTokens.length) {
        try {
          const wf = await sdk.walletService.fetchWallet(
            cid,
            ownerAddr,
            touchedTokens.map(t => ({ asset: getAddress(t), spenders: [] })),
          )
          for (const t of touchedTokens) realWallet[t] = wf.result.getBalance(getAddress(t))
        }
        catch (error) {
          logWarn('useTxBatch/fetchWallet', error)
        }
      }
      if (!isResimulationContextCurrent()) {
        // Superseded during the post-sim wallet fetch — same race as above, just a
        // later checkpoint. Bails before populating layers.
        logBatchDiag('resimulate:superseded-after-wallet-fetch', { token, supersededBy: resimToken }, 'error')
        return
      }
      // Asset metadata (symbol/decimals) for the touched tokens, resolved from
      // the simulated vault entities, for the wallet-changes summary.
      for (const vault of sim.simulatedVaults ?? []) {
        const asset = (vault as { asset?: { address?: string, symbol?: string, decimals?: number } }).asset
        if (asset?.address) {
          walletAssetMeta[getAddress(asset.address).toLowerCase()] = {
            symbol: asset.symbol ?? '',
            decimals: Number(asset.decimals ?? 18),
          }
        }
      }
      // Touched wallet tokens that aren't a simulated vault's underlying — e.g. a
      // swap output received straight into the wallet — get their symbol/decimals
      // from the token list, so the wallet-changes summary renders the real token
      // and amount instead of a raw "Token +0" (unknown symbol, default 18 dp).
      for (const token of touchedTokens) {
        if (walletAssetMeta[token]) continue
        const entry = getTokenByAddress(token)
        if (entry) {
          walletAssetMeta[token] = { symbol: entry.symbol, decimals: entry.decimals }
        }
      }
      const walletLayers = buildWalletBalanceLayers(simWb, realWallet)

      // Real-wallet shortfall: the SDK now computes this accurately from the
      // per-layer balances (running-min, nets out intra-batch funding). We just
      // enrich it with symbol/decimals for display.
      walletShortfalls.value = (sim.insufficientWalletAssets ?? []).map((s) => {
        const key = getAddress(s.token).toLowerCase()
        const meta = walletAssetMeta[key]
        return { token: key, amount: s.amount, symbol: meta?.symbol ?? '', decimals: meta?.decimals ?? 18 }
      })

      // Flag the entry that *itself* failed (entry i ⇒ layer i+1):
      //  - per-item reverts carry an operationIndex → that entry reverted.
      //  - a *vault* status check (e.g. a deposit breaching that vault's supply
      //    cap) is directly caused by the entry that deposits/borrows into it, so
      //    attribute it to that entry's plan.
      // NOT attributed: deferred *account* (health/liquidity) status checks. A
      // withdraw that leaves the account unhealthy doesn't itself revert — the
      // whole batch fails the end-of-batch health check. That's a batch-level
      // problem (banner + blocked execute), not a failure of any single row.
      const failureMessage = describeFailure(sim)
      const failedEntries = new Map<number, string>()
      for (const f of sim.failedBatchItems ?? []) {
        const failedIndex = 'operationIndex' in f && typeof f.operationIndex === 'number' ? f.operationIndex : f.index
        if (typeof failedIndex !== 'number') continue
        // operationIndex counts plugin prefix operations too — resolve it to
        // the owning cart entry through the boundary map. A failing plugin
        // operation belongs to no row; block the batch instead of leaving
        // hasFailedOps (and the Execute gate) silently green.
        const entryIdx = operationMap ? operationMap.entryOfOperation(failedIndex) : failedIndex
        if (entryIdx === null) {
          if (!simError.value) simError.value = failureMessage
          continue
        }
        if (!failedEntries.has(entryIdx)) failedEntries.set(entryIdx, failureMessage)
      }
      const planTargets = plans.map(collectPlanTargets)
      for (const e of sim.vaultStatusErrors ?? []) {
        const v = getAddress(e.vault).toLowerCase()
        const idx = planTargets.findIndex(t => t.vaults.has(v))
        if (idx >= 0 && !failedEntries.has(idx)) failedEntries.set(idx, failureMessage)
      }

      layers.value = fullLayers.map((acc, idx) => {
        const projected = projectPortfolio(sdk, acc)
        const entryIdx = idx - 1
        const failed = idx > 0 && failedEntries.has(entryIdx)
        return {
          account: acc,
          portfolio: projected.visible,
          portfolioAll: projected.all,
          vaults: vaultLayers[idx] ?? {},
          walletBalances: walletLayers[idx],
          walletBalancesSim: simWb[idx] ?? {},
          failed,
          error: failed ? failedEntries.get(entryIdx) : undefined,
        }
      })
      activeLayer.value = layers.value.length - 1
      syncOverlay()
      // Completion checkpoint: layerCount/entryCount come from the helper snapshot.
      // getCurrentFinalLayer needs layerCount === entryCount + 1; escalate to error
      // if this run finished without satisfying that (the bug condition).
      logBatchDiag(
        'resimulate:complete',
        { token, layersBuilt: layers.value.length },
        layers.value.length === entries.value.length + 1 ? 'warn' : 'error',
      )
    }
    catch (error) {
      if (!isResimulationContextCurrent()) {
        logBatchDiag('resimulate:superseded-in-catch', { token, supersededBy: resimToken }, 'error')
        return
      }
      logBatchDiag('resimulate:threw', { token, error: error instanceof Error ? error.message : String(error) }, 'error')
      logWarn('useTxBatch/resimulate', error)
      invalidateSimulationLayers()
      simError.value = error instanceof Error ? error.message : String(error)
    }
    finally {
      if (isResimulationContextCurrent()) isSimulating.value = false
    }
  }

  const runResimulate = (): Promise<void> => {
    // Compare against the *wrapped* promise we store, not the raw resimulate()
    // promise — otherwise the guard never matches and resimulatePromise is never
    // cleared, leaving callers (getEntryPlanningAccount) awaiting a stale run.
    const wrapped: Promise<void> = resimulate().finally(() => {
      // `cleared === false` means a newer run already replaced this promise, so a
      // caller awaiting `resimulatePromise` will pick up the newer run next pass.
      const cleared = resimulatePromise === wrapped
      if (cleared) resimulatePromise = null
      logBatchDiag('runResimulate:settled', { cleared })
    })
    resimulatePromise = wrapped
    logBatchDiag('runResimulate:kicked')
    return wrapped
  }

  // Wire reactivity exactly once, in a detached scope that outlives any single
  // component (mirrors the pattern used by useEulerAccount).
  if (!scope) {
    scope = effectScope(true)
    scope.run(() => {
      watch(entries, () => {
        logBatchDiag('watch:entries-changed')
        void runResimulate()
      })
      watch([activeLayer, layers], syncOverlay)
      // Reset the cart when the account or chain changes — layers would be stale.
      watch([owner, chainId], () => {
        logBatchDiag('watch:owner-or-chain-reset', {}, 'error')
        invalidatePendingAddContext()
        invalidateBatchReview()
        resimToken++
        entries.value = []
        layers.value = []
        activeLayer.value = 0
        isSimulating.value = false
        simError.value = undefined
        execError.value = undefined
        walletShortfalls.value = []
        lastMerged = null
        baseAccountSnapshot = null
        batchSlotHints = {}
        resimulatePromise = null
        syncOverlay()
      })
      // Safe classification is part of a bundled ceremony's wallet context.
      // Connector detection can change without changing the owner or chain.
      watch([isSafeWallet, isSafeWalletResolved, connectorKey], () => {
        invalidateBatchReview()
      })
    })
  }

  const getEntryPlanningAccount = async (
    isAddContextCurrent: () => boolean,
  ): Promise<Account<IHasVaultAddress>> => {
    const getCurrentFinalLayer = () => (
      entries.value.length > 0 && layers.value.length === entries.value.length + 1
        ? layers.value[layers.value.length - 1]?.account
        : undefined
    )

    const finalLayer = getCurrentFinalLayer()
    logBatchDiag('getEntryPlanningAccount:enter', { fastPathHit: finalLayer !== undefined })
    if (finalLayer) return finalLayer

    if (entries.value.length > 0) {
      // Retry across superseded resimulations until the final layer for the
      // present entries settles or a real error appears (see awaitFinalPlanningLayer).
      try {
        return await awaitFinalPlanningLayer<Account<IHasVaultAddress>>({
          getFinalLayer: getCurrentFinalLayer,
          getSimError: () => simError.value,
          getInFlight: () => resimulatePromise,
          startRun: runResimulate,
          // Found on attempt 0 is the healthy path (warn/quiet). Not finding it —
          // i.e. the awaited run resolved without our layers — is the suspected
          // race; log at error so we capture each re-attempt in the field.
          onAttempt: ({ attempt, awaitedExisting, found }) =>
            logBatchDiag('getEntryPlanningAccount:attempt', {
              attempt,
              awaitedExisting,
              finalLayerFound: found,
            }, found ? 'warn' : 'error'),
        })
      }
      catch (error) {
        // This is THE event we're hunting. Full state is in the helper snapshot.
        logBatchDiag('getEntryPlanningAccount:throw', {
          thrownMessage: simError.value ?? 'Batch simulation not loaded',
        }, 'error')
        throw error
      }
    }

    const o = owner.value
    const cid = chainId.value
    if (!o || !cid) {
      logBatchDiag('getEntryPlanningAccount:account-not-loaded', { owner: o, chainId: cid }, 'error')
      throw new Error('Account not loaded')
    }
    const ownerAddress = getAddress(o)
    // Only reachable with an empty cart (non-empty carts return the final layer
    // above), so `baseAccountSnapshot` is null here and adopting the prefetched
    // base cannot displace a snapshot already pinned for this cart.
    const { planningAccount, baseAccount } = resolvePrefetchedAccounts(cid, ownerAddress)

    if (baseAccount) {
      baseAccountSnapshot = baseAccount
    }
    if (planningAccount) {
      logBatchDiag('getEntryPlanningAccount:prefetched-planning-account')
      return planningAccount
    }
    if (baseAccount) {
      logBatchDiag('getEntryPlanningAccount:prefetched-base-account')
      return baseAccount
    }
    if (baseAccountSnapshot) {
      logBatchDiag('getEntryPlanningAccount:base-snapshot-cached')
      return baseAccountSnapshot
    }

    logBatchDiag('getEntryPlanningAccount:base-snapshot-fetch', { owner: o, chainId: cid })
    const sdk = await getEulerSdkFresh()
    const fetched = await fetchBaseAccountSnapshot(sdk, cid, ownerAddress)
    if (!isAddContextCurrent()) throw new BatchAddContextChangedError()
    baseAccountSnapshot = fetched
    return fetched
  }

  const captureAddContext = (): BatchAddContext => {
    let currentOwner: Address | undefined
    try {
      currentOwner = owner.value ? getAddress(owner.value) : undefined
    }
    catch {
      currentOwner = undefined
    }
    return {
      generation: addContextGeneration,
      owner: currentOwner,
      chainId: chainId.value,
    }
  }

  const isAddContextCurrent = (context: BatchAddContext): boolean => {
    if (context.generation !== addContextGeneration || context.chainId !== chainId.value) return false
    try {
      const currentOwner = owner.value ? getAddress(owner.value) : undefined
      return currentOwner === context.owner
    }
    catch {
      return context.owner === undefined
    }
  }

  const assertAddContextCurrent = (context: BatchAddContext) => {
    if (!isAddContextCurrent(context)) throw new BatchAddContextChangedError()
  }

  const addEntry = async (entry: BatchEntryInput) => {
    const addContext = captureAddContext()
    // Ignore a rapid duplicate click while an identical add is still in flight
    // (same target sub-account + label). Sequential re-adds are unaffected — the
    // signature is released once the add settles.
    const signature = `${addContext.generation}|${addContext.owner ?? ''}|${addContext.chainId ?? ''}|${entry.subAccount ?? ''}|${entry.label}`
    if (pendingAddSignatures.has(signature)) return
    pendingAddSignatures.add(signature)
    pendingAddCount.value++
    // Invalidate synchronously when the edit starts, not after its async plan
    // build finishes, so an open review cannot execute while an add is pending.
    invalidateBatchReview()

    const add = async () => {
      assertAddContextCurrent(addContext)
      execError.value = undefined
      logBatchDiag('addEntry:building', {
        label: entry.label,
        subAccount: entry.subAccount,
        requiresPlanningAccount: entry.requiresPlanningAccount !== false,
      })
      // Account-free entries never reach `getEntryPlanningAccount`, so seed layer 0
      // from the prefetched base here too — otherwise resimulate would refetch it.
      const preflightChainId = chainId.value
      const currentOwner = owner.value
      if (!baseAccountSnapshot && preflightChainId && currentOwner) {
        try {
          const { baseAccount } = resolvePrefetchedAccounts(preflightChainId, getAddress(currentOwner))
          if (baseAccount) baseAccountSnapshot = baseAccount
        }
        catch {
          // Account-free entries can still build without a valid wallet context.
          // The simulator will surface the normal account-loading error later.
        }
      }
      let planningAccount: Account<IHasVaultAddress> | undefined
      if (entry.requiresPlanningAccount !== false) {
        planningAccount = await getEntryPlanningAccount(() => isAddContextCurrent(addContext))
        assertAddContextCurrent(addContext)
      }
      const buildResult = entry.requiresPlanningAccount === false
        ? await entry.buildPlan()
        : await entry.buildPlan(planningAccount!)
      assertAddContextCurrent(addContext)
      const plan = Array.isArray(buildResult) ? buildResult : buildResult.plan
      const builtStateOverrides = Array.isArray(buildResult) ? undefined : buildResult.stateOverrides
      const cid = chainId.value
      if (cid) {
        batchSlotHints = {
          ...getBatchPrefetchedSlotHints(cid),
          ...batchSlotHints,
        }
        // Probe only what no form or earlier batch entry has resolved yet.
        const missingSlotHintTokens = collectRequiredApprovalTokens(plan)
          .filter(token => batchSlotHints[token] === undefined)
        await primeBatchSlotHintsFor(cid, missingSlotHintTokens, () => isAddContextCurrent(addContext))
      }
      assertAddContextCurrent(addContext)
      const {
        buildPlan: _buildPlan,
        requiresPlanningAccount: _requiresPlanningAccount,
        ...fixedEntry
      } = entry
      registerReviewAssetMeta(fixedEntry.review)
      // A ceremony can be prepared while this async add is building against
      // the prior cart. Advance again at the commit edge so that ceremony is
      // stale before the completed entry becomes visible.
      invalidateBatchReview()
      entries.value = [...entries.value, {
        ...fixedEntry,
        ...(builtStateOverrides ? { stateOverrides: builtStateOverrides } : {}),
        plan,
        id: `entry-${++idSeq}`,
      }]
      logBatchDiag('addEntry:added', { label: entry.label, newEntryCount: entries.value.length })
    }

    const nextAdd = addEntryQueue.then(add, add)
    addEntryQueue = nextAdd.catch(() => {})

    try {
      await nextAdd
    }
    catch (error) {
      logBatchDiag('addEntry:threw', {
        label: entry.label,
        error: error instanceof Error ? error.message : String(error),
      }, 'error')
      logWarn('useTxBatch/addEntry', error)
      if (!(error instanceof BatchAddContextChangedError)) {
        simError.value = error instanceof Error ? error.message : String(error)
      }
      throw error
    }
    finally {
      pendingAddSignatures.delete(signature)
      pendingAddCount.value = Math.max(0, pendingAddCount.value - 1)
    }
  }

  const removeEntry = (id: string) => {
    const nextEntries = entries.value.filter(entry => entry.id !== id)
    execError.value = undefined
    if (nextEntries.length === entries.value.length) return
    invalidatePendingAddContext()
    invalidateBatchReview()
    entries.value = nextEntries
    if (nextEntries.length === 0) {
      resimToken++
      layers.value = []
      activeLayer.value = 0
      isSimulating.value = false
      simError.value = undefined
      walletShortfalls.value = []
      lastMerged = null
      baseAccountSnapshot = null
      batchSlotHints = {}
      resimulatePromise = null
      syncOverlay()
    }
  }

  const clearBatch = () => {
    invalidatePendingAddContext()
    invalidateBatchReview()
    resimToken++
    entries.value = []
    layers.value = []
    activeLayer.value = 0
    isSimulating.value = false
    simError.value = undefined
    execError.value = undefined
    walletShortfalls.value = []
    lastMerged = null
    baseAccountSnapshot = null
    batchSlotHints = {}
    resimulatePromise = null
    syncOverlay()
  }

  /**
   * Remove exactly the entries a landed execution covered, keeping any the
   * user added while the broadcast was in flight. Runs when execution
   * succeeded but the cart is no longer the reviewed generation for the same
   * wallet: clearing everything would discard unexecuted work, while keeping
   * everything would leave already-executed entries queued to run again. The
   * ceremony's review index carries the executed entry ids. A wallet-context
   * change is already handled by the owner/chain watcher emptying the cart, so
   * this only ever filters same-wallet successors, and the surviving entries
   * resimulate through the entries watcher.
   */
  const retireExecutedEntries = (ceremony: PreparedBatchExecution) => {
    const executedIds = new Set(Object.keys(ceremony.reviewByEntryId))
    const nextEntries = entries.value.filter(entry => !executedIds.has(entry.id))
    if (nextEntries.length === entries.value.length) return
    execError.value = undefined
    invalidatePendingAddContext()
    invalidateBatchReview()
    entries.value = nextEntries
    if (nextEntries.length === 0) {
      resimToken++
      layers.value = []
      activeLayer.value = 0
      isSimulating.value = false
      simError.value = undefined
      walletShortfalls.value = []
      lastMerged = null
      baseAccountSnapshot = null
      batchSlotHints = {}
      resimulatePromise = null
      syncOverlay()
    }
  }

  const setActiveLayer = (layer: number) => {
    activeLayer.value = Math.max(0, Math.min(layer, layers.value.length - 1))
    syncOverlay()
  }

  const dismissExecutionError = () => {
    execError.value = undefined
  }

  /** The latest merged preview plan (null until a successful simulation).
   *  The review modal prepares & decodes this to surface approvals. */
  const getMergedPlan = (): TransactionPlan | null => lastMerged

  /** Resolve approvals/permits/plugins for the merged batch plan, so the review
   *  modal can list the approvals the user will be asked to sign. */
  const prepareBatchPlan = async () => {
    if (!lastMerged) return null
    return (await prepareBatchExecution()).prepared
  }

  const getExecutionPlanningAccount = async (entryIndex: number): Promise<Account<IHasVaultAddress>> => {
    const getLayerAccount = () => layers.value[entryIndex]?.account

    const layerAccount = getLayerAccount()
    if (layerAccount) return layerAccount

    if (entries.value.length > 0) {
      await (resimulatePromise ?? runResimulate())
      const refreshedLayerAccount = getLayerAccount()
      if (refreshedLayerAccount) return refreshedLayerAccount
      throw new Error(simError.value ?? 'Batch simulation not loaded')
    }

    if (baseAccountSnapshot) return baseAccountSnapshot

    const o = owner.value
    const cid = chainId.value
    if (!o || !cid) throw new Error('Account not loaded')
    const executionOwner = getAddress(o)
    const executionGeneration = batchGeneration.value
    const sdk = await getEulerSdkFresh()
    const fetched = await fetchBaseAccountSnapshot(sdk, cid, executionOwner)
    if (
      executionGeneration !== batchGeneration.value
      || chainId.value !== cid
      || !owner.value
      || getAddress(owner.value) !== executionOwner
    ) {
      throw new Error('Batch or wallet changed since review preparation — reopen review and try again.')
    }
    baseAccountSnapshot = fetched
    return fetched
  }

  /**
   * A Safe executes ceremony prerequisites inside the batch proposal.
   */
  const willBundlePrerequisites = computed(() =>
    isSafeWallet.value
    && entries.value.some(entry => entry.bundleExecutionCeremony),
  )

  const isBatchExecutionCurrent = (ceremony: PreparedBatchExecution): boolean => {
    if (
      pendingAddCount.value > 0
      || ceremony.generation !== batchGeneration.value
    ) {
      return false
    }
    return isBatchExecutionWalletCurrent(ceremony)
  }

  const isBatchExecutionWalletCurrent = (ceremony: PreparedBatchExecution): boolean => {
    if (
      ceremony.chainId !== chainId.value
      || ceremony.safeWallet !== isSafeWallet.value
      || !isSafeWalletResolved.value
      || ceremony.safeWalletResolved !== isSafeWalletResolved.value
      || ceremony.connectorKey !== connectorKey.value
      || !owner.value
    ) return false
    try {
      return getAddress(owner.value) === ceremony.owner
    }
    catch {
      return false
    }
  }

  const assertBatchExecutionCurrent = (ceremony: PreparedBatchExecution) => {
    if (!isBatchExecutionCurrent(ceremony)) {
      throw new Error('Batch or wallet changed since review preparation — reopen review and try again.')
    }
  }

  /**
   * Resolve one ceremony per cart generation for every wallet/execution mode.
   * Concurrent review modals share the same in-flight promise and immutable
   * result; stale work can finish but cannot be used after a cart or wallet
   * context change.
   */
  const prepareBatchExecution = (): Promise<PreparedBatchExecution> => {
    if (pendingAddCount.value > 0) {
      return Promise.reject(new Error('An operation is still being added — wait for the batch to finish updating.'))
    }
    if (!lastMerged || entries.value.length === 0) {
      return Promise.reject(new Error('Batch simulation not loaded'))
    }
    if (!isSafeWalletResolved.value) {
      return Promise.reject(new Error('Wallet type is still loading — wait before reviewing the batch.'))
    }

    const generation = batchGeneration.value
    if (batchPreparation?.generation === generation) return batchPreparation.promise

    const currentOwner = owner.value
    const currentChainId = chainId.value
    if (!currentOwner || !currentChainId) return Promise.reject(new Error('Account not loaded'))
    const reviewOwner = getAddress(currentOwner)
    const reviewSafeWallet = isSafeWallet.value
    const reviewSafeWalletResolved = isSafeWalletResolved.value
    const reviewConnectorKey = connectorKey.value
    const mode = willBundlePrerequisites.value ? 'safe-bundled' : 'standard'

    const preparationPromise = (async (): Promise<PreparedBatchExecution> => {
      const { plans, planResolvers, usesPlaceholderSignatures, grants, revokes, prerequisites, reviewByEntryId } = mode === 'safe-bundled'
        ? await collectBundledExecution()
        : await collectStandardExecution()
      const sdk = await getEulerSdkFresh()
      const executionPlan = sdk.executionService.mergePlans(plans)
      const prepared = await prepareTransactionPlan(executionPlan)
      const resolvePreparedPlan = planResolvers.some(Boolean)
        ? async (beforeWalletAction: () => void): Promise<TransactionPlanPrepared> => {
          const resolvedPlans: TransactionPlan[] = []
          const signatureSubstitutions: PreparedPlanSignatureSubstitution[] = []
          for (const [index, plan] of plans.entries()) {
            beforeWalletAction()
            const resolver = planResolvers[index]
            if (resolver) {
              const resolved = await resolver(beforeWalletAction)
              resolvedPlans.push(resolved.plan)
              signatureSubstitutions.push(...resolved.signatureSubstitutions)
            }
            else {
              resolvedPlans.push(plan)
            }
            beforeWalletAction()
          }
          const resolvedPlan = sdk.executionService.mergePlans(resolvedPlans)
          const resolvedPrepared = await prepareTransactionPlan(resolvedPlan)
          beforeWalletAction()
          assertPreparedPlanSignatureParity({
            reviewed: prepared,
            resolved: resolvedPrepared,
            substitutions: signatureSubstitutions,
          })
          return resolvedPrepared
        }
        : undefined
      const frozenReview = Object.freeze(Object.fromEntries(
        Object.entries(reviewByEntryId).map(([entryId, review]) => [entryId, Object.freeze({
          plan: review.plan,
          grantSteps: Object.freeze([...review.grantSteps]),
          revokeSteps: Object.freeze([...review.revokeSteps]),
        })]),
      ))
      const frozenPrerequisites = Object.freeze(prerequisites.map(prerequisite => Object.freeze({
        ...prerequisite,
        preTxs: Object.freeze(prerequisite.preTxs.map(tx => Object.freeze({ ...tx }))),
        postTxs: Object.freeze(prerequisite.postTxs.map(tx => Object.freeze({ ...tx }))),
        postTxsByPreTx: prerequisite.postTxsByPreTx
          ? Object.freeze(prerequisite.postTxsByPreTx.map(tx => tx ? Object.freeze({ ...tx }) : undefined))
          : undefined,
        walletContext: Object.freeze({ ...prerequisite.walletContext }),
      })))
      const ceremony: PreparedBatchExecution = Object.freeze({
        generation,
        owner: reviewOwner,
        chainId: currentChainId,
        safeWallet: reviewSafeWallet,
        safeWalletResolved: reviewSafeWalletResolved,
        connectorKey: reviewConnectorKey,
        mode,
        prepared,
        resolvePreparedPlan,
        usesPlaceholderSignatures,
        grants: Object.freeze(grants.map(tx => Object.freeze({ ...tx }))),
        revokes: Object.freeze(revokes.map(tx => Object.freeze({ ...tx }))),
        prerequisites: frozenPrerequisites,
        reviewByEntryId: frozenReview,
      })
      assertBatchExecutionCurrent(ceremony)
      return ceremony
    })()

    const trackedPromise = preparationPromise.catch((error) => {
      if (batchPreparation?.promise === trackedPromise) batchPreparation = null
      throw error
    })
    batchPreparation = { generation, promise: trackedPromise }
    return trackedPromise
  }

  /**
   * Build the exact standard ceremony. Prerequisite-bearing entries use their
   * simulation variant for the prepared core and freeze the standalone grants
   * that make that core executable. Entries without prerequisites resolve their
   * ordinary execution plan during review.
   */
  const collectStandardExecution = async () => {
    const plans: TransactionPlan[] = []
    const planResolvers: Array<BatchEntryExecutionCeremony['resolveExecutionPlan']> = []
    let usesPlaceholderSignatures = false
    const grants: BatchEntryExternalTx[] = []
    const revokes: BatchEntryExternalTx[] = []
    const prerequisites: BatchEntryExecutionPrerequisites[] = []
    const reviewByEntryId: Record<string, {
      plan: TransactionPlan
      grantSteps: DisplayStep[]
      revokeSteps: DisplayStep[]
    }> = {}

    for (const [index, entry] of entries.value.entries()) {
      if (entry.buildExecutionCeremony) {
        const execution = await entry.buildExecutionCeremony(await getExecutionPlanningAccount(index))
        const prerequisite = execution.prerequisites
        plans.push(execution.plan)
        planResolvers.push(execution.resolveExecutionPlan)
        usesPlaceholderSignatures ||= execution.usesPlaceholderSignatures === true
        if (prerequisite) {
          prerequisites.push(prerequisite)
          grants.push(...prerequisite.preTxs)
          if (prerequisite.postTxsByPreTx) {
            for (const revoke of prerequisite.postTxsByPreTx) {
              if (revoke) revokes.unshift(revoke)
            }
          }
          else {
            revokes.push(...prerequisite.postTxs)
          }
        }
        reviewByEntryId[entry.id] = {
          plan: execution.plan,
          grantSteps: prerequisite
            ? execution.grantSteps.map(step => ({ ...step, isSeparateTx: true }))
            : execution.grantSteps,
          revokeSteps: prerequisite
            ? execution.revokeSteps.map(step => ({ ...step, isSeparateTx: true }))
            : execution.revokeSteps,
        }
        continue
      }

      const plan = entry.buildExecutionPlan
        ? await entry.buildExecutionPlan(await getExecutionPlanningAccount(index))
        : entry.plan
      plans.push(plan)
      planResolvers.push(undefined)
      reviewByEntryId[entry.id] = { plan, grantSteps: [], revokeSteps: [] }
    }

    return { plans, planResolvers, usesPlaceholderSignatures, grants, revokes, prerequisites, reviewByEntryId }
  }

  /**
   * Assemble the bundled ceremony: each entry's simulation-variant plan plus
   * its grant/revoke calls. Grants keep entry order; revokes unwind in
   * reverse entry order (each entry's own revokes are already reversed).
   */
  const collectBundledExecution = async () => {
    const plans: TransactionPlan[] = []
    const planResolvers: Array<BatchEntryExecutionCeremony['resolveExecutionPlan']> = []
    let usesPlaceholderSignatures = false
    const grants: BatchEntryExternalTx[] = []
    const revokesByEntry: BatchEntryExternalTx[][] = []
    const reviewByEntryId: Record<string, {
      plan: TransactionPlan
      grantSteps: DisplayStep[]
      revokeSteps: DisplayStep[]
    }> = {}
    for (const [index, entry] of entries.value.entries()) {
      if (entry.buildExecutionCeremony) {
        const bundled = await entry.buildExecutionCeremony(await getExecutionPlanningAccount(index))
        const prerequisite = bundled.prerequisites
        plans.push(bundled.plan)
        planResolvers.push(bundled.resolveExecutionPlan)
        usesPlaceholderSignatures ||= bundled.usesPlaceholderSignatures === true
        grants.push(...(prerequisite?.preTxs ?? []))
        revokesByEntry.push(prerequisite?.postTxs ?? [])
        reviewByEntryId[entry.id] = {
          plan: bundled.plan,
          grantSteps: bundled.grantSteps,
          revokeSteps: bundled.revokeSteps,
        }
        continue
      }
      const plan = entry.buildExecutionPlan
        ? await entry.buildExecutionPlan(await getExecutionPlanningAccount(index))
        : entry.plan
      plans.push(plan)
      planResolvers.push(undefined)
      revokesByEntry.push([])
      reviewByEntryId[entry.id] = { plan, grantSteps: [], revokeSteps: [] }
    }
    return { plans, planResolvers, usesPlaceholderSignatures, grants, revokes: revokesByEntry.reverse().flat(), prerequisites: [], reviewByEntryId }
  }

  /**
   * Send the ceremony's frozen prerequisite grants before its prepared core.
   * Each call is sent separately so ceremony freshness is checked immediately
   * before and after every irreversible broadcast.
   */
  const sendExecutionPrerequisites = async (
    ceremony: PreparedBatchExecution,
    grantedRevokes: MigrationAuthorizationRevoke[],
  ): Promise<void> => {
    for (const prerequisites of ceremony.prerequisites) {
      let grantWalletContext: WalletExecutionContext | undefined
      for (const [preTxIndex, preTx] of prerequisites.preTxs.entries()) {
        assertBatchExecutionCurrent(ceremony)
        await sendPlainTransactions([preTx], {
          walletContext: prerequisites.walletContext,
          beforeBroadcast: () => assertBatchExecutionCurrent(ceremony),
          onBroadcast: (_index, walletContext) => {
            grantWalletContext = walletContext
            const revoke = prerequisites.postTxsByPreTx?.[preTxIndex]
            if (revoke) {
              grantedRevokes.unshift({ transaction: revoke, walletContext })
            }
          },
        })
        assertBatchExecutionCurrent(ceremony)
      }
      // Entries without a one-to-one mapping retain the original all-or-nothing
      // behavior. Migration entries always provide postTxsByPreTx so partial or
      // receipt-ambiguous grant sequences can unwind precisely.
      if (!prerequisites.postTxsByPreTx && prerequisites.postTxs.length) {
        if (!grantWalletContext) {
          throw new Error('Cannot restore prerequisite transactions without their wallet context')
        }
        grantedRevokes.push(...prerequisites.postTxs.map(transaction => ({
          transaction,
          walletContext: grantWalletContext,
        })))
      }
    }
  }

  /** Execute the immutable ceremony produced for the current batch review. */
  const executeBatch = async (
    scope?: TrackedExecutionScope,
    reviewedExecution?: PreparedBatchExecution,
  ) => {
    if (pendingAddCount.value > 0) {
      execError.value = 'An operation is still being added — wait for the batch to finish updating.'
      return
    }
    if (isExecuting.value || entries.value.length === 0 || !lastMerged) return
    // simError covers both a top-level EVC revert and a deferred status-check
    // failure; walletShortfalls covers an under-funded wallet. Either way the
    // real `batch` tx would revert, so refuse to send.
    if (simError.value || walletShortfalls.value.length > 0 || hasFailedOps.value) return
    execError.value = undefined
    isExecuting.value = true
    const attemptGeneration = batchGeneration.value
    const attemptOwner = owner.value ? getAddress(owner.value) : undefined
    const attemptChainId = chainId.value
    const attemptConnectorKey = connectorKey.value
    const attemptSafeWallet = isSafeWallet.value
    const attemptSafeWalletResolved = isSafeWalletResolved.value
    const isAttemptCurrent = () => {
      if (
        attemptGeneration !== batchGeneration.value
        || attemptChainId !== chainId.value
        || attemptConnectorKey !== connectorKey.value
        || attemptSafeWallet !== isSafeWallet.value
        || attemptSafeWalletResolved !== isSafeWalletResolved.value
        || !attemptOwner
        || !owner.value
      ) return false
      try {
        return attemptOwner === getAddress(owner.value)
      }
      catch {
        return false
      }
    }
    const grantedRevokes: MigrationAuthorizationRevoke[] = []
    let execution = reviewedExecution
    try {
      if (!await restorePendingBeforeRetry()) return
      execution ??= await prepareBatchExecution()
      assertBatchExecutionCurrent(execution)
      const shouldRefreshExternalMigrationPositions = entries.value.some(entry => entry.refreshExternalMigrationPositions)
      const prepared = execution.resolvePreparedPlan
        ? await execution.resolvePreparedPlan(() => assertBatchExecutionCurrent(execution!))
        : execution.prepared
      assertBatchExecutionCurrent(execution)

      if (execution.mode === 'safe-bundled') {
        // No standalone gas estimate — grants are unmined until the
        // proposal executes; the cart's continuous simulation (which runs
        // with the entries' authorization state overrides) is the
        // pre-flight validation. Atomicity also removes the unwind
        // bookkeeping: a failed proposal reverts its grants with it.
        assertBatchExecutionCurrent(execution)
        const result = await executePreparedPlanWithPlainCalls(prepared, {
          before: execution.grants,
          after: execution.revokes,
        }, {
          allowSingleCall: true,
          beforeBroadcast: () => assertBatchExecutionCurrent(execution),
        })
        if (!result) {
          // The review described ONE proposal; never silently degrade to
          // the sequential multi-proposal ceremony.
          throw new Error('Safe connection unavailable — the reviewed single-proposal submission cannot run. Reconnect your Safe and retry.')
        }
        if (!isBatchExecutionCurrent(execution)) {
          retireExecutedEntries(execution)
          scope?.markSucceeded()
          return
        }
        clearBatch()
        if (shouldRefreshExternalMigrationPositions) scheduleExternalMigrationRefreshes()
        await redirectAfterBatchExecution(scope)
        return
      }

      await sendExecutionPrerequisites(execution, grantedRevokes)
      assertBatchExecutionCurrent(execution)
      // Final on-chain gas estimate before the irreversible core broadcast. If
      // chain state moved since review, surface the decoded reason and retain
      // the cart. A pending edit during this await invalidates the ceremony.
      await estimateGasForPreparedPlan(prepared)
      assertBatchExecutionCurrent(execution)
      await executePreparedPlan(prepared, {
        beforeBroadcast: () => assertBatchExecutionCurrent(execution),
      })
      await revokeAfterSuccess(grantedRevokes, {
        shouldNotify: () => isBatchExecutionWalletCurrent(execution!),
      })
      if (!isBatchExecutionCurrent(execution)) {
        retireExecutedEntries(execution)
        scope?.markSucceeded()
        return
      }
      clearBatch()
      if (shouldRefreshExternalMigrationPositions) scheduleExternalMigrationRefreshes()
      await redirectAfterBatchExecution(scope)
    }
    catch (error) {
      logWarn('useTxBatch/executeBatch', error)
      // The batch never landed, so no granted authorization should be left
      // standing. Entries stay in the cart for a retry, which re-grants.
      await revokeAfterAbort(grantedRevokes, {
        shouldNotify: () => !execution || isBatchExecutionWalletCurrent(execution),
      })
      const decodedError = await describeExecError(error)
      if (execution ? isBatchExecutionCurrent(execution) : isAttemptCurrent()) {
        execError.value = decodedError
      }
    }
    finally {
      isExecuting.value = false
    }
  }

  const isSimulated = computed(() => activeLayer.value > 0 && layers.value.length > 0)
  const hasFailedOps = computed(() => layers.value.some(layer => layer.failed))
  // The real wallet can't cover what the full batch spends (net of intra-batch
  // funding). Surfaced as "Not enough balance" and blocks execution — the
  // simulation forges balances, so without this the cart would look executable.
  const hasInsufficientBalance = computed(() => walletShortfalls.value.length > 0)
  // Human-readable shortfall, e.g. "Not enough wallet balance. Missing 0.01 wstETH".
  // The batch still simulates (balances are forged) — this just explains why it
  // can't execute, mirroring how a failed health check blocks an otherwise-valid
  // simulation.
  const insufficientBalanceMessage = computed(() => {
    if (!walletShortfalls.value.length) return ''
    const missing = walletShortfalls.value
      .map(s => `${formatSmartAmount(formatUnits(s.amount, s.decimals))} ${s.symbol || 'token'}`)
      .join(', ')
    return `Not enough wallet balance. Missing ${missing}`
  })
  // Whether the batch can actually be sent on-chain: no per-op revert, no
  // batch-level error (top-level revert or deferred status-check failure), no
  // real-wallet shortfall, and not mid-flight. The simulated state still renders
  // when this is false — this only gates the Execute action.
  const canExecuteBatch = computed(() =>
    entries.value.length > 0
    && pendingAddCount.value === 0
    && !isSimulating.value
    && !isExecuting.value
    && !hasFailedOps.value
    && !simError.value
    && !hasInsufficientBalance.value,
  )

  // Net wallet balance changes from real (layer 0) to the *final* layer — the
  // summary of what the whole batch does to the wallet (deposited/withdrawn/…).
  // Computed against the last layer (not the active one) so the summary stays
  // visible whether the eye toggle is showing the simulated or the real state.
  // Uses the raw simulated balances (not the zero-floored `walletBalances`), so
  // an underfunded supply still shows the full amount pulled from the wallet —
  // the part forged by state overrides included — rather than collapsing to 0.
  const walletChanges = computed(() => {
    const last = layers.value.length - 1
    if (last <= 0) return [] as BatchWalletChange[]
    const cur = layers.value[last]?.walletBalancesSim
    const base = layers.value[0]?.walletBalancesSim
    return buildWalletChanges(cur, base, walletAssetMeta)
  })
  const activeLayerData = computed(() => layers.value[activeLayer.value])
  const entryCount = computed(() => entries.value.length)
  const scopedEntrySubAccounts = computed<Set<string> | undefined>(() => {
    return buildScopedEntrySubAccounts(entries.value)
  })

  // The context label each entry operates in. EVK entries derive it from the
  // op's vault target(s) on its plan → label product(s), joined with " / " when
  // the op spans markets (same shape as the positions list's pair label); Earn
  // entries can carry the Earn vault display name captured at add-time.
  const marketByEntryId = computed<Record<string, string>>(() => {
    const labels = getCurrentEulerLabelsData()
    const out: Record<string, string> = {}
    for (const entry of entries.value) {
      const market = getEntryMarketLabelOverride(entry) ?? buildPlanMarketLabel(
        entryPlans.value[entry.id],
        addr => getEulerLabelProductByVault(labels, addr)?.name,
      )
      if (market) out[entry.id] = market
    }
    return out
  })

  // Position keys (`${subAccount}:${vault}`, lowercased) whose state on the
  // active layer differs from the real (layer 0) account. Balance keys track
  // share/supply changes; debt keys track borrowed changes. The position UI
  // uses this to mark only the card surface that changed.
  const modifiedPositionKeySets = computed(() => {
    const active = activeLayer.value
    if (active <= 0) return emptyModifiedPositionKeySets()
    const cur = layers.value[active]?.account
    const base = layers.value[0]?.account
    return filterModifiedPositionKeySetsByOwner(
      buildModifiedPositionKeySets(cur, base),
      ownerSubAccountKey.value,
      scopedEntrySubAccounts.value,
    )
  })
  const modifiedKeys = computed(() => modifiedPositionKeySets.value.any)
  const modifiedBalanceKeys = computed(() => modifiedPositionKeySets.value.balance)
  const modifiedDebtKeys = computed(() => modifiedPositionKeySets.value.debt)

  return {
    entries,
    layers,
    activeLayer,
    activeLayerData,
    activeLayerPortfolio: activeLayerPortfolioRef,
    isSimulated,
    isSimulating,
    simError,
    isExecuting,
    execError,
    hasFailedOps,
    canExecuteBatch,
    hasInsufficientBalance,
    insufficientBalanceMessage,
    walletShortfalls,
    modifiedKeys,
    modifiedBalanceKeys,
    modifiedDebtKeys,
    removedKeys: activeLayerRemovedKeysRef,
    walletChanges,
    entryCount,
    hasPendingAdds: computed(() => pendingAddCount.value > 0),
    marketByEntryId,
    isDrawerOpen: drawerOpen,
    toggleDrawer: () => { drawerOpen.value = !drawerOpen.value },
    entryPlans,
    addEntry,
    removeEntry,
    clearBatch,
    dismissExecutionError,
    setActiveLayer,
    executeBatch,
    willBundlePrerequisites,
    prepareBatchExecution,
    isBatchExecutionCurrent,
    prepareBundledExecution: prepareBatchExecution,
    isBundledExecutionCurrent: isBatchExecutionCurrent,
    // For the Review batch modal.
    getMergedPlan,
    prepareBatchPlan,
  }
}
