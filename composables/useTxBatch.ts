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
 * plan is built against the previous layer's simulated account, so a withdraw
 * added after a deposit sees the deposit as if it were already mined. The
 * production path (one batch with interspersed lens reads + per-op errors,
 * exposed via a `layers` flag on `simulateTransactionPlan`) is a drop-in
 * replacement for `resimulate()` — the layer interface is unchanged.
 */

export interface BatchEntry {
  id: string
  label: string
  /** Builds this entry's plan against the simulated account of the previous layer. */
  buildPlan: (account: Account<IHasVaultAddress>) => Promise<TransactionPlan>
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
// Per-entry built plan (keyed by entry id) from the latest simulation — feeds the
// per-operation review modal so it shows the operation in its batch context.
const entryPlans = shallowRef<Record<string, TransactionPlan>>({})
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

const stitchAccount = (
  prevFull: Account<IHasVaultAddress>,
  touched: Account<IHasVaultAddress>,
): Account<IHasVaultAddress> => {
  // Shallow-clone every sub-account of the previous full account (copy the
  // positions array so we never mutate the source layer).
  const mergedSubs: Record<string, unknown> = {}
  for (const [addr, sa] of Object.entries(prevFull.subAccounts)) {
    if (sa) mergedSubs[addr] = { ...sa, positions: [...sa.positions] }
  }
  for (const [addr, tsa] of Object.entries(touched.subAccounts)) {
    if (!tsa) continue
    const existing = mergedSubs[addr] as { positions: { vaultAddress: Address }[] } | undefined
    if (!existing) {
      mergedSubs[addr] = { ...tsa, positions: [...tsa.positions] }
      continue
    }
    const byVault = new Map<string, unknown>()
    for (const p of existing.positions) byVault.set(getAddress(p.vaultAddress), p)
    for (const tp of tsa.positions) byVault.set(getAddress(tp.vaultAddress), tp)
    mergedSubs[addr] = {
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
  return new Account({
    chainId: prevFull.chainId,
    owner: prevFull.owner,
    isLockdownMode: touched.isLockdownMode,
    isPermitDisabledMode: touched.isPermitDisabledMode,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subAccounts: mergedSubs as any,
    populated: prevFull.populated,
  }) as Account<IHasVaultAddress>
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
      // Fully populate the base account (vault entities + USD prices) so layer 0
      // and the untouched positions stitched into later layers render with the
      // same data the simulated (touched) positions carry.
      const fetched = await sdk.accountService.fetchAccount(cid, ownerAddr, {
        populateVaults: true,
        populateMarketPrices: true,
      })
      const baseAccount = fetched.result as Account<IHasVaultAddress>

      // Build every entry's plan, each against the best-known prior layer so
      // share/max-based ops see earlier steps. (Fixed-amount deposit/withdraw
      // plans are layer-independent, so the base account is a safe fallback.)
      const cachedLayers = layers.value
      const plans: TransactionPlan[] = []
      for (let i = 0; i < entries.value.length; i++) {
        const priorAccount = cachedLayers[i]?.account ?? baseAccount
        plans.push(await entries.value[i].buildPlan(priorAccount))
      }
      // Expose each entry's contextual plan for its review modal.
      entryPlans.value = Object.fromEntries(entries.value.map((e, i) => [e.id, plans[i]!]))

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

  // Wire reactivity exactly once, in a detached scope that outlives any single
  // component (mirrors the pattern used by useEulerAccount).
  if (!scope) {
    scope = effectScope(true)
    scope.run(() => {
      // Any edit to the cart invalidates a prior Tenderly run (it simulated a
      // different merged plan), so drop the stale URL before re-simulating.
      watch(entries, () => {
        tenderly.clearSimulation()
        void resimulate()
      })
      watch([activeLayer, layers], syncOverlay)
      // Reset the cart when the account or chain changes — layers would be stale.
      watch([owner, chainId], () => {
        entries.value = []
        layers.value = []
        activeLayer.value = 0
        simError.value = undefined
        walletShortfalls.value = []
        tenderly.clearSimulation()
        syncOverlay()
      })
    })
  }

  const addEntry = (entry: Omit<BatchEntry, 'id'>) => {
    entries.value = [...entries.value, { ...entry, id: `entry-${++idSeq}` }]
  }

  const removeEntry = (id: string) => {
    entries.value = entries.value.filter(entry => entry.id !== id)
  }

  const clearBatch = () => {
    entries.value = []
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
  // active layer differs from the real (layer 0) account — i.e. positions the
  // simulation touched. The UI uses this to flag modified positions (e.g. a
  // dotted border) without any layer awareness of its own.
  const modifiedKeys = computed(() => {
    const set = new Set<string>()
    const active = activeLayer.value
    if (active <= 0) return set
    const cur = layers.value[active]?.account
    const base = layers.value[0]?.account
    if (!cur || !base) return set
    for (const [addr, sa] of Object.entries(cur.subAccounts)) {
      if (!sa) continue
      const baseSa = base.subAccounts[addr as Address]
      for (const p of sa.positions) {
        const vault = getAddress(p.vaultAddress)
        const bp = baseSa?.positions.find(x => getAddress(x.vaultAddress) === vault)
        if (!bp || bp.shares !== p.shares || bp.borrowed !== p.borrowed) {
          set.add(`${addr.toLowerCase()}:${vault.toLowerCase()}`)
        }
      }
    }
    return set
  })

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
