import { computed, effectScope, ref, shallowRef, watch, type EffectScope, type Ref } from 'vue'
import { getAddress, type Address } from 'viem'
import { Account, flattenBatchEntries, getEulerLabelProductByVault } from '@eulerxyz/euler-v2-sdk'
import type {
  IHasVaultAddress,
  Portfolio,
  TransactionPlan,
  VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { getCurrentEulerLabelsData } from '~/composables/useEulerLabels'
import { useTenderlySimulation } from '~/composables/useTenderlySimulation'
import { buildTenderlySimulationPayload } from '~/utils/tenderly-plan'
import { decodeBatchItemLabel } from '~/utils/stepDecoding'
import { formatSimulationFailure } from '~/utils/tx-errors'
import { logWarn } from '~/utils/errorHandling'
import { buildVisiblePortfolioPositionFilter } from '~/utils/portfolioPositionFilter'

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

export interface BatchEntry {
  id: string
  label: string
  /** Fixed transaction payload captured when the user added this entry. */
  plan: TransactionPlan
  /** Props for the per-operation review modal (OperationReviewModal), captured at
   *  add-time so the batch can show the same review the form would — minus the
   *  execute button. The contextual plan is supplied from the simulation. */
  review?: Record<string, unknown>
  /** Sub-account this operation targets, when known (position pages). Lets the
   *  batch rows show the same "Position N" tag as the portfolio. New positions
   *  (fresh deposits) leave this undefined and render no tag. */
  subAccount?: Address
  /** Multiply flows set this. A multiply is a borrow(+swap) at the plan level, so
   *  it can't be told apart from a plain borrow or a borrow-with-collateral-swap
   *  by the plan alone (and same-asset multiply has no swap step at all). This
   *  lite-only flag lets the batch list label it "Multiply …". */
  multiply?: boolean
}

export interface BatchEntryInput extends Omit<BatchEntry, 'id' | 'plan'> {
  /** Builds this entry once, at add-time, against the current batch end-state. */
  buildPlan: (account: Account<IHasVaultAddress>) => Promise<TransactionPlan>
}

export interface BatchLayer {
  /** Simulated account snapshot after this layer's entry (layer 0 = real). */
  account: Account<IHasVaultAddress>
  /** Visible-only (verified-filtered) portfolio projection. */
  portfolio?: Portfolio<VaultEntity>
  /** All-positions projection (for the "Show all" view). */
  portfolioAll?: Portfolio<VaultEntity>
  /**
   * Stitched wallet ERC20 balances (lowercased token → absolute balance) for the
   * assets the batch touched, at this layer: the real wallet balance with this
   * layer's simulated deposit/withdraw/borrow/repay applied.
   */
  walletBalances?: Record<string, bigint>
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

// "Simulate on Tenderly" for the whole batch — runs the exact merged plan
// through the server-side Tenderly endpoint and returns a shareable dashboard
// URL. Shared (module-level) so the result persists across the laptop drawer
// and the mobile full-page view. Mirrors the per-operation flow in
// OperationReviewModal, just fed the batch's merged plan instead of one op.
const tenderly = useTenderlySimulation()
const tenderlyEnabled = ref(false)
let tenderlyEnabledFetched = false

/**
 * Module-level overlay ref read by `useEulerAccount` so the portfolio is
 * layer-aware without threading the pointer through every consumer.
 * `undefined` ⇒ show real (layer 0) data.
 */
export const activeLayerPortfolioRef = shallowRef<Portfolio<VaultEntity> | undefined>(undefined)
/** All-positions overlay (for the "Show all" toggle). `undefined` ⇒ real data. */
export const activeLayerPortfolioAllRef = shallowRef<Portfolio<VaultEntity> | undefined>(undefined)
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
// Symbol/decimals for touched wallet tokens, for the wallet-changes summary.
const walletAssetMeta: Record<string, { symbol: string, decimals: number }> = {}

const syncOverlay = () => {
  const layer = activeLayer.value > 0 ? layers.value[activeLayer.value] : undefined
  activeLayerPortfolioRef.value = layer?.portfolio
  activeLayerPortfolioAllRef.value = layer?.portfolioAll

  // Active layer's stitched wallet balances (absolute) for touched tokens.
  activeLayerWalletBalancesRef.value = layer?.walletBalances ?? {}
  // Active layer's full stitched account (for share-balance / plan-account reads).
  activeLayerAccountRef.value = layer?.account
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

// Concise message from an execution / gas-estimate error. Viem errors expose a
// `shortMessage` (e.g. the decoded revert reason); fall back to the raw message.
const describeExecError = (error: unknown): string => {
  const e = error as { shortMessage?: string, details?: string, message?: string }
  return e?.shortMessage || e?.details || e?.message || String(error)
}

const fetchBaseAccountSnapshot = async (
  sdk: Awaited<ReturnType<typeof getEulerSdkFresh>>,
  chainId: number,
  owner: Address,
): Promise<Account<IHasVaultAddress>> => {
  const fetched = await sdk.accountService.fetchAccount(chainId, owner, {
    populateVaults: true,
    populateMarketPrices: true,
    populateUserRewards: true,
    vaultFetchOptions: {
      populateRewards: true,
    },
  })
  return fetched.result as Account<IHasVaultAddress>
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

type RewardedVault = IHasVaultAddress & {
  rewards?: unknown
  populated?: { rewards?: boolean }
}

type RewardedPosition = {
  vaultAddress: Address
  vault?: RewardedVault
  liquidity?: {
    vaultAddress: Address
    vault?: RewardedVault
    collaterals?: Array<{
      address: Address
      vault?: RewardedVault
    }>
  }
}

type StitchPosition = { vaultAddress: Address, shares?: bigint, borrowed?: bigint }
type StitchSubAccount = {
  positions: StitchPosition[]
  enabledControllers?: Address[]
  enabledCollaterals?: Address[]
  timestamp?: number
  lastAccountStatusCheckTimestamp?: number
  liquidity?: unknown
  liabilityValueUsd?: number
}

const collectRewardedVaults = (account: Account<IHasVaultAddress>): Map<string, RewardedVault> => {
  const byAddress = new Map<string, RewardedVault>()
  const addVault = (vault: RewardedVault | undefined) => {
    if (!vault?.rewards) return
    byAddress.set(getAddress(vault.address).toLowerCase(), vault)
  }

  for (const subAccount of Object.values(account.subAccounts)) {
    if (!subAccount) continue
    for (const position of subAccount.positions as RewardedPosition[]) {
      addVault(position.vault)
      addVault(position.liquidity?.vault)
      for (const collateral of position.liquidity?.collaterals ?? []) {
        addVault(collateral.vault)
      }
    }
  }

  return byAddress
}

const subAccountMapKey = (account: string): Address => getAddress(account) as Address

const mergePositionsByVault = (positions: StitchPosition[]): StitchPosition[] => {
  const byVault = new Map<string, StitchPosition>()
  for (const position of positions) {
    byVault.set(getAddress(position.vaultAddress), position)
  }
  return Array.from(byVault.values())
}

const carryVaultRewards = (position: RewardedPosition, rewardedVaults: Map<string, RewardedVault>) => {
  const carry = (vault: RewardedVault | undefined) => {
    if (!vault || vault.rewards) return
    const previous = rewardedVaults.get(getAddress(vault.address).toLowerCase())
    if (!previous?.rewards) return
    vault.rewards = previous.rewards
    vault.populated = {
      ...vault.populated,
      rewards: previous.populated?.rewards ?? true,
    }
  }

  carry(position.vault)
  carry(position.liquidity?.vault)
  for (const collateral of position.liquidity?.collaterals ?? []) {
    carry(collateral.vault)
  }
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

export const buildModifiedPositionKeySets = (
  current: Account<IHasVaultAddress> | undefined,
  base: Account<IHasVaultAddress> | undefined,
): ModifiedPositionKeySets => {
  const sets = emptyModifiedPositionKeySets()
  if (!current || !base) return sets

  for (const [addr, sa] of Object.entries(current.subAccounts)) {
    if (!sa) continue
    const subAccount = subAccountMapKey(addr)
    const baseSa = base.subAccounts[subAccount]
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

export const stitchAccount = (
  prevFull: Account<IHasVaultAddress>,
  touched: Account<IHasVaultAddress>,
): Account<IHasVaultAddress> => {
  const rewardedVaults = collectRewardedVaults(prevFull)
  // Shallow-clone every sub-account of the previous full account (copy the
  // positions array so we never mutate the source layer).
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
        ...sa.positions,
      ]),
    }
  }
  for (const [addr, tsa] of Object.entries(touched.subAccounts)) {
    if (!tsa) continue
    const key = subAccountMapKey(addr)
    const existing = mergedSubs[key]
    if (!existing) {
      for (const tp of tsa.positions) {
        carryVaultRewards(tp as RewardedPosition, rewardedVaults)
      }
      mergedSubs[key] = { ...tsa, positions: mergePositionsByVault([...tsa.positions]) }
      continue
    }
    const byVault = new Map<string, StitchPosition>()
    for (const p of existing.positions) byVault.set(getAddress(p.vaultAddress), p)
    for (const tp of tsa.positions) {
      carryVaultRewards(tp as RewardedPosition, rewardedVaults)
      byVault.set(getAddress(tp.vaultAddress), tp)
    }
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
      positions: Array.from(byVault.values()),
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

// The vault(s) an operation's core action targets, read off its plan. Used to
// resolve which market (Euler label product) the operation belongs to. Same
// action set the review-step decoder recognises.
const VAULT_ACTION_LABELS = new Set(['Supply', 'Deposit', 'Withdraw', 'Borrow', 'Repay'])
const collectVaultTargets = (plan?: TransactionPlan): Address[] => {
  if (!plan) return []
  const out: Address[] = []
  for (const item of plan) {
    if (item.type !== 'evcBatch') continue
    for (const bi of flattenBatchEntries(item.items)) {
      if (!VAULT_ACTION_LABELS.has(decodeBatchItemLabel(bi.data))) continue
      try {
        out.push(getAddress(bi.targetContract))
      }
      catch { /* skip malformed address */ }
    }
  }
  return out
}

const getEntryMarketLabelOverride = (entry: BatchEntry): string | undefined => {
  const label = entry.review?.marketLabel
  return typeof label === 'string' && label.trim() ? label : undefined
}

export const useTxBatch = () => {
  const { address: walletAddress, chainId: wagmiChainId } = useWagmi()
  const { isSpyMode, spyAddress } = useSpyMode()
  const { chainId: addressesChainId } = useEulerAddresses()

  const owner = computed(
    () => (isSpyMode.value ? spyAddress.value : walletAddress.value) as Address | undefined,
  )
  const chainId = computed(() => wagmiChainId.value ?? addressesChainId.value)
  const { prepareTransactionPlan, executePreparedPlan, estimateGasForPlan } = useEulerTx()

  const resimulate = async () => {
    const token = ++resimToken
    const o = owner.value
    const cid = chainId.value

    if (!o || !cid || entries.value.length === 0) {
      layers.value = []
      activeLayer.value = 0
      simError.value = undefined
      walletShortfalls.value = []
      lastMerged = null
      baseAccountSnapshot = null
      syncOverlay()
      return
    }

    isSimulating.value = true
    // NOTE: deliberately do NOT clear simError / walletShortfalls here. A new
    // simulation runs on every add/remove/reorder; clearing up-front would make a
    // prior error flicker away while the next sim is in flight. They're set
    // atomically on completion below (and cleared on the empty-batch path above).
    try {
      const sdk = await getEulerSdkFresh()
      const ownerAddr = getAddress(o)
      // Keep the real base state fixed for the lifetime of the cart. Entry plans
      // are immutable add-time payloads; later real-state drift should not cause
      // the whole batch to rebuild around a different base account.
      const baseAccount = baseAccountSnapshot
        ?? await fetchBaseAccountSnapshot(sdk, cid, ownerAddr)
      baseAccountSnapshot = baseAccount

      const plans = entries.value.map(entry => entry.plan)

      // One simulation, all layers. The SDK interleaves lens reads per
      // operation and returns simulatedAccounts = [base, afterOp0, afterOp1, …]
      // plus per-operation revert attribution via failedBatchItems.
      const merged = sdk.executionService.mergePlans(plans)
      lastMerged = merged
      const sim = await sdk.executionService.simulateTransactionPlan(
        cid,
        ownerAddr,
        merged,
        { stateOverrides: true },
      )

      if (token !== resimToken) return

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
      const simAccounts = (sim.simulatedAccounts ?? []) as Account<IHasVaultAddress>[]
      const fullLayers: Account<IHasVaultAddress>[] = [baseAccount]
      for (let i = 1; i < simAccounts.length; i++) {
        fullLayers.push(stitchAccount(fullLayers[i - 1]!, simAccounts[i]!))
      }

      // Wallet balances: same stitch as the account. The real wallet (from the
      // SDK wallet service) is the layer-0 base; each layer overlays the touched
      // assets' simulated balance. In-sim balances are forged, so the forge
      // cancels in the per-layer delta vs the pre-batch layer.
      const simWb = (sim.simulatedWalletBalances ?? []) as Record<string, bigint>[]
      const touchedTokens = simWb.length ? Object.keys(simWb[0] ?? {}) : []
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
      if (token !== resimToken) return
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
      const baseWb = simWb[0] ?? {}
      const walletLayers: Record<string, bigint>[] = simWb.map((wb) => {
        const out: Record<string, bigint> = {}
        for (const t of touchedTokens) {
          const delta = (wb[t] ?? 0n) - (baseWb[t] ?? 0n)
          const v = (realWallet[t] ?? 0n) + delta
          out[t] = v < 0n ? 0n : v
        }
        return out
      })

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
        if (typeof f.operationIndex === 'number') failedEntries.set(f.operationIndex, failureMessage)
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
          walletBalances: walletLayers[idx],
          failed,
          error: failed ? failedEntries.get(entryIdx) : undefined,
        }
      })
      activeLayer.value = layers.value.length - 1
      syncOverlay()
    }
    catch (error) {
      if (token !== resimToken) return
      logWarn('useTxBatch/resimulate', error)
      simError.value = error instanceof Error ? error.message : String(error)
    }
    finally {
      if (token === resimToken) isSimulating.value = false
    }
  }

  const runResimulate = (): Promise<void> => {
    const promise = resimulate()
    resimulatePromise = promise.finally(() => {
      if (resimulatePromise === promise) resimulatePromise = null
    })
    return resimulatePromise
  }

  // Wire reactivity exactly once, in a detached scope that outlives any single
  // component (mirrors the pattern used by useEulerAccount).
  if (!scope) {
    scope = effectScope(true)
    scope.run(() => {
      // Any edit to the cart invalidates a prior Tenderly run (it simulated a
      // different fixed plan list), so drop the stale URL before re-simulating.
      watch(entries, () => {
        tenderly.clearSimulation()
        void runResimulate()
      })
      watch([activeLayer, layers], syncOverlay)
      // Reset the cart when the account or chain changes — layers would be stale.
      watch([owner, chainId], () => {
        resimToken++
        entries.value = []
        layers.value = []
        activeLayer.value = 0
        isSimulating.value = false
        simError.value = undefined
        walletShortfalls.value = []
        lastMerged = null
        baseAccountSnapshot = null
        resimulatePromise = null
        tenderly.clearSimulation()
        syncOverlay()
      })
    })
  }

  const getEntryPlanningAccount = async (): Promise<Account<IHasVaultAddress>> => {
    const getCurrentFinalLayer = () => (
      entries.value.length > 0 && layers.value.length === entries.value.length + 1
        ? layers.value[layers.value.length - 1]?.account
        : undefined
    )

    const finalLayer = getCurrentFinalLayer()
    if (finalLayer) return finalLayer

    if (entries.value.length > 0) {
      await (resimulatePromise ?? runResimulate())
      const refreshedFinalLayer = getCurrentFinalLayer()
      if (refreshedFinalLayer) return refreshedFinalLayer
      throw new Error(simError.value ?? 'Batch simulation not loaded')
    }

    if (baseAccountSnapshot) return baseAccountSnapshot

    const o = owner.value
    const cid = chainId.value
    if (!o || !cid) throw new Error('Account not loaded')
    const sdk = await getEulerSdkFresh()
    baseAccountSnapshot = await fetchBaseAccountSnapshot(sdk, cid, getAddress(o))
    return baseAccountSnapshot
  }

  const addEntry = async (entry: BatchEntryInput) => {
    const add = async () => {
      const account = await getEntryPlanningAccount()
      const plan = await entry.buildPlan(account)
      const { buildPlan: _buildPlan, ...fixedEntry } = entry
      entries.value = [...entries.value, { ...fixedEntry, plan, id: `entry-${++idSeq}` }]
    }

    const nextAdd = addEntryQueue.then(add, add)
    addEntryQueue = nextAdd.catch(() => {})

    try {
      await nextAdd
    }
    catch (error) {
      logWarn('useTxBatch/addEntry', error)
      simError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  const removeEntry = (id: string) => {
    const nextEntries = entries.value.filter(entry => entry.id !== id)
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
      resimulatePromise = null
      tenderly.clearSimulation()
      syncOverlay()
    }
  }

  const clearBatch = () => {
    resimToken++
    entries.value = []
    layers.value = []
    activeLayer.value = 0
    isSimulating.value = false
    simError.value = undefined
    walletShortfalls.value = []
    lastMerged = null
    baseAccountSnapshot = null
    resimulatePromise = null
    tenderly.clearSimulation()
    syncOverlay()
  }

  const setActiveLayer = (layer: number) => {
    activeLayer.value = Math.max(0, Math.min(layer, layers.value.length - 1))
    syncOverlay()
  }

  /** Lazily check (once) whether the server has Tenderly credentials configured,
   *  so the UI can hide the button when simulation isn't available. */
  const fetchTenderlyEnabled = async (): Promise<boolean> => {
    if (tenderlyEnabledFetched) return tenderlyEnabled.value
    tenderlyEnabledFetched = true
    tenderlyEnabled.value = await tenderly.fetchEnabled()
    return tenderlyEnabled.value
  }

  /**
   * Run the whole batch through Tenderly: the exact merged plan executeBatch
   * would send, encoded as one EVC `batch` call with the SDK's derived state
   * overrides (so approvals/permits don't make it revert). Returns a dashboard
   * URL surfaced via `tenderlyUrl`. Works in spy mode too — it's a read-only
   * simulation, no signature required.
   */
  const simulateOnTenderly = async (): Promise<void> => {
    if (!lastMerged) return
    const o = owner.value
    const cid = chainId.value
    if (!o || !cid) return
    tenderly.clearSimulation()
    try {
      const sdk = await getEulerSdkFresh()
      const payload = await buildTenderlySimulationPayload({
        plan: lastMerged,
        owner: getAddress(o),
        chainId: cid,
        sdk,
      })
      if (!payload) {
        tenderly.simulationError.value = 'Tenderly simulation is not available for this batch.'
        return
      }
      await tenderly.simulate(payload)
    }
    catch (error) {
      logWarn('useTxBatch/simulateOnTenderly', error)
      tenderly.simulationError.value = 'Tenderly simulation failed.'
    }
  }

  /** The exact merged plan executeBatch would send (null until a successful
   *  simulation). The review modal prepares & decodes this to surface approvals. */
  const getMergedPlan = (): TransactionPlan | null => lastMerged

  /** Resolve approvals/permits/plugins for the merged batch plan, so the review
   *  modal can list the approvals the user will be asked to sign. */
  const prepareBatchPlan = async () => {
    if (!lastMerged) return null
    return prepareTransactionPlan(lastMerged)
  }

  /**
   * Execute the whole batch as one atomic transaction: the exact merged plan
   * that was simulated (all entries combined via mergePlans), prepared once
   * (approvals/permits/plugins) and sent as a single EVC batch. On success the
   * cart is cleared (executePreparedPlan triggers the portfolio refresh). In
   * spy mode executePreparedPlan refuses to sign, surfaced via execError.
   */
  const executeBatch = async () => {
    if (isExecuting.value || entries.value.length === 0 || !lastMerged) return
    // simError covers both a top-level EVC revert and a deferred status-check
    // failure; walletShortfalls covers an under-funded wallet. Either way the
    // real `batch` tx would revert, so refuse to send.
    if (simError.value || walletShortfalls.value.length > 0) return
    execError.value = undefined
    isExecuting.value = true
    try {
      // Final on-chain gas estimate before asking the user to sign. If the batch
      // would revert (against the current chain state, which may have moved since
      // the last simulation), surface the decoded reason and don't send.
      await estimateGasForPlan(lastMerged)
      const prepared = await prepareTransactionPlan(lastMerged)
      await executePreparedPlan(prepared)
      clearBatch()
    }
    catch (error) {
      logWarn('useTxBatch/executeBatch', error)
      execError.value = describeExecError(error)
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
  // Whether the batch can actually be sent on-chain: no per-op revert, no
  // batch-level error (top-level revert or deferred status-check failure), no
  // real-wallet shortfall, and not mid-flight. The simulated state still renders
  // when this is false — this only gates the Execute action.
  const canExecuteBatch = computed(() =>
    entries.value.length > 0
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
  const walletChanges = computed(() => {
    const last = layers.value.length - 1
    if (last <= 0) return [] as Array<{ token: string, symbol: string, decimals: number, delta: bigint }>
    const cur = layers.value[last]?.walletBalances
    const base = layers.value[0]?.walletBalances
    if (!cur || !base) return []
    const out: Array<{ token: string, symbol: string, decimals: number, delta: bigint }> = []
    for (const token of Object.keys(cur)) {
      const delta = (cur[token] ?? 0n) - (base[token] ?? 0n)
      if (delta === 0n) continue
      const meta = walletAssetMeta[token]
      out.push({ token, delta, symbol: meta?.symbol ?? '', decimals: meta?.decimals ?? 18 })
    }
    return out
  })
  const activeLayerData = computed(() => layers.value[activeLayer.value])
  const entryCount = computed(() => entries.value.length)

  // The context label each entry operates in. EVK entries derive it from the
  // op's vault target(s) on its plan → label product; Earn entries can carry
  // the Earn vault display name captured at add-time.
  const marketByEntryId = computed<Record<string, string>>(() => {
    const labels = getCurrentEulerLabelsData()
    const out: Record<string, string> = {}
    for (const entry of entries.value) {
      const marketLabelOverride = getEntryMarketLabelOverride(entry)
      if (marketLabelOverride) {
        out[entry.id] = marketLabelOverride
        continue
      }
      for (const addr of collectVaultTargets(entryPlans.value[entry.id])) {
        const name = getEulerLabelProductByVault(labels, addr)?.name
        if (name) {
          out[entry.id] = name
          break
        }
      }
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
    return buildModifiedPositionKeySets(cur, base)
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
    walletShortfalls,
    modifiedKeys,
    modifiedBalanceKeys,
    modifiedDebtKeys,
    walletChanges,
    entryCount,
    marketByEntryId,
    isDrawerOpen: drawerOpen,
    toggleDrawer: () => { drawerOpen.value = !drawerOpen.value },
    entryPlans,
    addEntry,
    removeEntry,
    clearBatch,
    setActiveLayer,
    executeBatch,
    // Tenderly "Simulate on Tenderly" for the whole batch.
    tenderlyEnabled,
    isTenderlySimulating: tenderly.isSimulating,
    tenderlyUrl: tenderly.simulationUrl,
    tenderlyError: tenderly.simulationError,
    fetchTenderlyEnabled,
    simulateOnTenderly,
    // For the Review batch modal.
    getMergedPlan,
    prepareBatchPlan,
  }
}
