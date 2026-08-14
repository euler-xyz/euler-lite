# Transaction Building & Composite Operations

This document describes how euler-lite constructs, simulates, reviews, and executes Euler protocol transactions.

## Overview

Protocol actions are represented as SDK `TransactionPlan` values from `@eulerxyz/euler-v2-sdk`. Lite owns page state, form validation, review display, and wallet wiring. The SDK owns protocol call planning, approval resolution, Permit2 handling, simulation, gas/state overrides, and execution sequencing.

The main app entry point is `composables/useEulerTx.ts`.

## SDK TransactionPlan

An SDK `TransactionPlan` is an ordered array of plan items:

```typescript
type TransactionPlan = TransactionPlanItem[]

type TransactionPlanItem =
  | { type: 'requiredApproval'; token: Address; owner: Address; spender: Address; amount: bigint; resolved?: Approval[] }
  | { type: 'evcBatch'; items: EVCBatchEntry[] }
  | { type: 'contractCall'; chainId: number; to: Address; abi: Abi; functionName: string; args: readonly unknown[]; value: bigint }
  | { type: 'cowSwap'; kind: CowSwapPlanKind; chainId: number; params: object }
```

`evcBatch` items contain SDK `EVCBatchItem` calls:

```typescript
type EVCBatchItem = {
  targetContract: Address
  onBehalfOfAccount: Address
  value: bigint
  data: Hex
}
```

The SDK also supports grouped `EVCBatchOperation` entries inside a batch. Lite flattens those groups only for review display and calldata copy.

## Planning Surface

`useEulerTx()` wraps the SDK execution service and provides the page-facing helpers:

- `planDeposit`, `planWithdraw`, `planRedeem`, `planBorrow`
- `planRepayFromWallet`, `planRepayFromDeposit`, `planRepayWithSwap`
- `planDepositWithSwap`, `planSwapFromWallet`, `planSwapAndBorrow`, `planSwapAndRepay`
- `planSwapCollateral`, `planSwapDebt`
- `planWithdrawAndSwap`, `planRedeemAndSwap`
- `planMigrateSameAssetCollateral`, `planMigrateSameAssetDebt`
- `planMultiplyWithSwap`, `planMultiplySameAsset`, `planTransfer`, `planCleanup`

Combined helpers keep page code simpler where a workflow can use either a same-asset or swap path:

- `planMultiply`
- `planRepayFromSource`
- `planCollateralChange`
- `planDebtChange`
- `planWithdrawOrRedeem`

The wrapper supplies the current SDK `Account`, wallet/sub-account owner, chain id, the effective gasless-signature flag (`usePermit2` from `signaturesEnabled`, with an extra Safe pin at execute time), and wallet callbacks. The quote and vault inputs stay explicit at the page/composable boundary.

## Execution Flow

1. A page or workflow composable builds a `TransactionPlan` with `useEulerTx()`.
2. `useTransactionPlanSimulation().runSimulation(plan)` applies operation guards and calls `sdk.executionService.simulateTransactionPlan(...)`.
3. The review modal prepares the plan with `preparePlanForReview(plan)`.
4. `preparePlanForReview` applies operation guards and calls `sdk.executionService.resolveRequiredApprovals(...)`.
5. The review modal renders the prepared plan via `utils/stepDecoding.ts`.
6. Confirming calls the workflow callback, which executes the plan through `executePlan(plan)`.
7. `executePlan` applies operation guards, calls `sdk.executionService.executeTransactionPlan(...)`, forwards wagmi `sendTransaction` / `signTypedData` callbacks, and refreshes portfolio state after receipts.

The review modal is fail-closed: if preparation does not produce a plan, it shows an error and disables confirmation.

## Approvals and Gasless Signatures

Plans may include `requiredApproval` items. During review and execution, `resolveRequiredApprovals` resolves each approval to either:

- an ERC-20 approval transaction, or
- a Permit2 signature request.

`executeTransactionPlan` sends approval transactions before the main EVC batch and inserts Permit2 signature data into the next batch where required.

### User preference (`useSignaturePreference`)

Users choose whether message signatures are enabled via **Settings → Gasless signatures** (`components/entities/wallet/SignatureSettings.vue`). The **stored** preference defaults to **on**. The **effective** value is read everywhere through `composables/useSignaturePreference.ts` as `signaturesEnabled`.

Do not treat the stored preference as the value that reaches planning or execution. A connected Safe (or pending Safe detection) forces the effective flag off without rewriting storage, so reconnecting a regular wallet restores the user's choice.

| Concern | Detail |
| ------- | ------ |
| Storage key | `signatures-enabled` (`SIGNATURES_PREFERENCE_STORAGE_KEY`) |
| Legacy key | `permit2-enabled` — copied once into the new key by `seedSignaturePreference`, then removed |
| Default stored | `true` (gasless / typed-data path) |
| Effective `signaturesEnabled` | `userPreference && !signaturesForcedOff` |
| Forced off | `isSafeWallet` or `!isSafeWalletResolved` — fail closed while Safe detection is pending; Settings switch is disabled. Copy explaining the Safe restriction appears only after a Safe is positively identified. |
| `prepareTransactionPlan` | Accepts `options?.usePermit2 ?? signaturesEnabled.value` (effective value, not the raw stored toggle) |
| `executePlan` | Independently pins `usePermit2: isKnownSafe ? false : signaturesEnabled.value` (no per-call override). `isKnownSafe` is a Safe provider or `isSafeConnectorIdentity(connector)`, so a known Safe never takes Permit2 even if provider acquisition failed. |
| `executePreparedPlan` | Same Safe pin: if the envelope was prepared before detection resolved, re-resolve approvals with `usePermit2: false` (or strip the flag when no Permit2 items resolved) |

When the **effective** flag is **off**, approval-capable flows fall back to on-chain approval transactions instead of Permit2 (and other) message signatures. Users can still turn the setting off on regular wallets that cannot sign typed data reliably. Safe wallets do not use that toggle: they are forced onto the approval / batched-transaction path.

Do not treat this as an Incentra- or rewards-specific switch — it is a global Lite setting for every message signature the app collects, then narrowed by the Safe override above.

### Cross-protocol migrations

Outgoing migrate (`pages/position/[number]/migrate.vue`) threads the same **effective** flag as `useSignatures`:

- **On** → `authorizationKind: 'typedData'`; Morpho can append a signed post-migration disable (`removeAuthorizationAfterMigration`) inside the batch.
- **Off** → `authorizationKind: 'transaction'`; connectors return `msg.sender` grant txs instead of a signed disable. The ceremony then splits by wallet:
  - **Regular wallets** — standalone grant transactions, then the migration, then separate post-settle revoke/restore steps (`isSeparateTx: true`).
  - **Safe wallets** — review latches `bundledReview` and executes grant + migration + revoke as one atomic Safe proposal (`sendMigrationAsSafeBundle` / `executePreparedPlanWithPlainCalls`). Review rows pass `{ bundled: true }` so `isSeparateTx` is false. Confirmation revalidates that the wallet is still a Safe; a degraded or unavailable Safe connection throws rather than silently falling back to sequential grants. The batch cart uses the same atomic path when `useTxBatch` can bundle prerequisites (`willBundlePrerequisites`: every prerequisite-bearing entry provides `buildBundledExecution`).

Inbound external migrate (`pages/position/[number]/borrow/swap.vue`) uses the same `bundledReview` latch and sequential-vs-atomic split.

`composables/useMigrationAuthorizationFlow.ts` owns restore/revoke queuing after success or abort **only on the sequential (non-bundled) fallback**, where a temporary authorization can remain standing. Failed restorations stay queued and must complete before another migration retry. The atomic Safe bundle includes the revokes in the same proposal, so that flow does not leave a standing grant for the sequential restorer to unwind.

## Operation Guards

`utils/operationGuardRegistry.ts` stores plan transformers and blockers. Guards are applied before simulation, review preparation, and execution.

Current guard families include:

- Terms of use signing
- Keyring credential injection for private vaults
- Unverified-vault acknowledgement

Transformers receive and return SDK `TransactionPlan` values. For example, `utils/keyring-injection.ts` prepends a Keyring `createCredential` `EVCBatchItem` to every `evcBatch` item.

## Review Display

`components/entities/operation/OperationReviewModal.vue` displays a prepared SDK plan. It uses:

- `preparePlanForReview` for guard application and approval resolution
- `buildTransactionPlanDisplaySteps` for human-readable step labels and asset amounts
- `flattenBatchEntries` and `encodeBatch` for calldata copy and Tenderly simulation
- `deriveStateOverrides` for Tenderly state overrides

Copy calldata includes approval transactions, encoded EVC batches, and direct contract calls. Permit2 signatures are shown in the review steps but are not copyable calldata until the wallet signs them.

## Simulation Performance Tuning

For fan-out flows (per-quote estimate sweeps, leverage explorers) and heavy single-shot flows, Lite threads two SDK helpers through `useEulerTx` and `useTransactionPlanSimulation` so the per-call RPC + plugin cost collapses to roughly "local plan assembly":

- `composables/useStateOverrideOptions.ts` (`buildStateOverrideOptions` + `primeSlotHintsFor`) — wraps the SDK's `SimulationStateOverrideOptions` for the page. `buildStateOverrideOptions({ noBalanceOverride })` snapshots the wallet balances the form already holds, attaches pre-fetched ERC20 slot hints, and (when the form validates "Not enough balance" up front) tells the SDK to skip balance overrides entirely. `primeSlotHintsFor(tokens)` fires `fetchErc20SlotHints` once per relevant token; subsequent simulate/estimate/prepare calls skip `eth_createAccessList` discovery.
- `prefetchPluginData(plan, …)` on `useEulerTx` — resolves the plugin pipeline's prefetch payload (Pyth Hermes pull, Keyring credential check) for one representative plan. Pass it into every `prepareTransactionPlan` / simulate / estimate in the sweep so plugins do zero per-quote network I/O.

Wired into:

- `useSwapQuotesParallel` consumers — every quote in the sweep reuses one prefetch + one slot-hint set + the wallet snapshot:
  - `composables/borrow/useMultiplyForm.ts`
  - `composables/borrow/useBorrowForm.ts`
  - `composables/position/useCollateralForm.ts`
  - `composables/useSwapPageLogic.ts`
  - `pages/lend/[vault]/index.vue` (deposit-with-swap)
- Page-load background priming (`primeSlotHintsFor(..., { background: true })`) on `pages/lend/[vault]/index.vue` and `pages/earn/[vault]/index.vue` — warms the form ref + batch registry without gating submit
- Heavy single-shot `runSimulation` / `runPreparedSimulation` call-sites pass `buildStateOverrideOptions({ noBalanceOverride })` directly:
  - `composables/repay/useWalletSwapRepay.ts`
  - `composables/repay/useCollateralSwapRepay.ts`
  - `pages/lend/[vault]/index.vue` (final pre-review simulation)
  - `composables/borrow/useMultiplyForm.ts` (Review-time prepared simulation)

`noBalanceOverride: true` is only safe when the operation either doesn't consume wallet ERC20 (collateral-swap repay, debt swap) or the form already gates submit on wallet balance (multiply, borrow, lend deposit, wallet-swap repay's EXACT_IN). Withdraw mode on `useCollateralForm` keeps the override but skips the balance branch by binding `noBalanceOverride` to `mode === 'supply'`.

`primeSlotHintsFor` is owner-/spender-agnostic. The SDK also memoises results in a module-scope `slotHintsCache` keyed on chain id + token. Lite additionally mirrors resolved hints into a chain-scoped registry (`composables/batchPrefetchState.ts`) so form pages and the batch cart share probes even when they do not share one SDK module cache across separately bundled call paths.

Pass `background: true` for speculative page-load priming (lend/earn vault forms). Background primes still warm the local ref + registry, but they do **not** increment `useStateOverrideResolution().isResolvingStateOverrideHints`, so submit / add-to-batch stay usable while a cold probe runs. A miss only means the simulator falls back to `eth_createAccessList` discovery.

Chain switches clear the local `slotHints` ref synchronously. Late probes for an old chain must not restore into the new chain’s local ref (they may still update that chain’s registry bucket). Concurrent primes re-merge after each await so an in-flight probe cannot clobber hints that landed meanwhile.

See the SDK side: `packages/euler-v2-sdk/docs/simulations-and-state-overrides.md` (performance tuning section) and `packages/euler-v2-sdk/docs/execution-service.md` (prefetching plugin data).

## Batch cart prefetch

The multi-tx batch cart (`composables/useTxBatch.ts`) reuses form-load accounts and slot hints so the first `addEntry` does not pay a full account refetch + access-list discovery tax.

### Shared registry

`composables/batchPrefetchState.ts` is a composable-free module registry (avoids import cycles between account / wallet / batch overlays):

| Entry | Writer | Consumer |
| ----- | ------ | -------- |
| Planning account | `useFreshAccount` | First batch add that needs a planning account |
| Base / portfolio account | `useEulerAccount` | Layer-0 snapshot seed when the cart is empty |
| Slot hints by chain | `primeSlotHintsFor` / `primeBatchSlotHintsFor` | Every `addEntry` + `resimulate` |

Both accounts are stored **pre-overlay**. Never read them back from layer-aware `usePlanAccount` / portfolio computeds — those return the active batch layer’s simulated account once a layer is active, which must never become the cart’s own layer 0. `useTxBatch` still validates chain + owner via `isAccountForContext` before reuse, because a wallet or chain switch can land before the matching loader replaces the registry.

### Form → batch slot-hint handoff

1. On form load, lend/earn pages call `primeSlotHintsFor(tokens, { background: true })` for the vault asset (and lend pay-with assets). That writes the form’s local ref **and** `mergeBatchPrefetchedSlotHints(chainId, …)`.
2. Pages do **not** pass per-entry hint props into `addBatchEntry`. The registry is the handoff.
3. Each `addEntry` merges `getBatchPrefetchedSlotHints(cid)` into module-scope `batchSlotHints` (existing cart hints win on key conflict).
4. Only plan `requiredApproval` tokens still missing a hint are probed via `primeBatchSlotHintsFor`, which writes back into `batchSlotHints` and the registry.
5. `resimulate` always sends `stateOverrideOptions: { slotHints: batchSlotHints }`.
6. `batchSlotHints` lives for the cart lifetime and clears when the batch empties.

### Simulation context freshness

`resimulate` calls `simulateTransactionPlan(cid, ownerAddr, merged, …)` with the **current owner Address**, not a pinned `Account` object, so plugins resolve against the live owner. Layer 0 still comes from the pinned `baseAccountSnapshot` after the SDK stitch — entry plans are immutable add-time payloads, and later real-state drift must not rebuild the whole cart around a different base.

## Swap Quotes

`useSwapApi()` fetches swap quotes and normalizes the backend token shape into the SDK `SwapQuote` shape at the API boundary. Downstream planners pass `SwapApiQuote` directly into SDK planner methods.

Quote orchestration and UI selection remain in Lite:

- `useSwapQuotesParallel()` fans out provider requests and ranks quotes.
- `useSwapPageLogic()` coordinates generic swap pages.
- Repay, borrow, collateral, multiply, supply, and withdraw composables provide workflow-specific request parameters and review text.

## Pyth Prices

SDK simulation and execution run through the SDK plugin pipeline. Pyth update batch items are added by SDK-side processing when a planned action needs fresh Pyth prices.

Lite still uses `utils/pyth.ts` for read-path lens simulations and visible vault/account data refreshes. See [Pyth Oracle Handling](./pyth-oracle-handling.md).

## Files

| File | Purpose |
|------|---------|
| `composables/useEulerTx.ts` | Page-facing SDK planning, simulation preparation, and execution wrapper |
| `composables/useTransactionPlanSimulation.ts` | Simulation state and error formatting for forms |
| `composables/useStateOverrideOptions.ts` | `SimulationStateOverrideOptions` builder + per-token slot-hint priming |
| `composables/batchPrefetchState.ts` | Form → batch handoff for pre-overlay accounts and chain-scoped slot hints |
| `composables/useTxBatch.ts` | Multi-tx cart: plan merge, resimulate, slot-hint reuse, execution |
| `components/entities/operation/OperationReviewModal.vue` | Prepared-plan review, calldata copy, and Tenderly simulation |
| `utils/stepDecoding.ts` | SDK plan item decoding for review display |
| `utils/operationGuardRegistry.ts` | Guard transformer and blocker registry |
| `utils/keyring-injection.ts` | Keyring credential batch-item injection |
| `utils/tos-injection.ts` | Terms-of-use batch-item injection |
| `composables/useSwapApi.ts` | Swap API request building and quote normalization |
