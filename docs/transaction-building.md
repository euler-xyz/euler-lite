# Transaction Building & Composite Operations

This document describes how euler-lite constructs, simulates, reviews, and executes Euler protocol transactions.

## Overview

Protocol actions start as serializable operation intents. Lite compiles those intents with the SDK into one reviewed execution, binds the existing handcrafted review to it, and submits only its finalized request vector. The SDK owns protocol call planning, approval resolution, deterministic request composition, Permit2 encoding, simulation, plugin processing, and EOA request sequencing. Lite independently verifies every decoded call and applies the current policy checks; its reviewed-execution coordinator owns review acceptance, a synchronous pre-handoff duplicate guard, bounded Pyth and migration-slot finalization, and exact request verification. Safe calls use the dedicated calls-ID adapter and current-session detachment/status flow.

`composables/useEulerTx.ts` is planning-only. Executable flows enter through `composables/useReviewedExecution.ts`; wallet writes are confined to that boundary and the EOA/Safe adapters under `features/reviewed-execution/adapters/`.

## Domain Vocabulary

The transaction lifecycle has two consent-bearing records:

- `OperationIntent` describes the immutable operation to compile and review.
- `ReviewedExecution` is the immutable, wallet-bound result accepted by the user.
- `SubmissionResult` reports the current invocation's submitted, rejected, failed, or unknown outcome. It is not persisted or resumable.

The reviewed request set, the record of which intent owns each call, policy and simulation results, review binding, planning snapshots and plugin plan commitments, signature/Pyth slots, finalized requests, and preview-cache records are internal details. A preview plan is form-time work that may warm the cache; it never authorizes a wallet write.

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

The wrapper supplies the current SDK `Account`, wallet/sub-account owner, and chain id. The quote and vault inputs stay explicit at the page/composable boundary. Forms capture an immutable `OperationIntent` from the same input snapshot used to build each preview; selected quote cards carry that intent alongside their optional plan and prepared result. These helpers may eagerly build and simulate previews, but their results are not wallet-executable authority. The reviewed execution captures the connected wallet/session and seals the effective approval mode before review.

## Execution Flow

1. Forms eagerly preprocess accounts, quotes, slot hints, plugin data, and simulation results. Preview data is cached only as canonical serializable values keyed by the full intent/content identity; it never recovers authority from an SDK plan object or Vue reference. Add-to-batch stores only `{ intentId, revision, intent }`; plans and builders stay outside the draft DTO.
2. `useReviewedExecution.prepare()` captures the exact account, chain, connector session, wallet kind, approval mode, and required sub-accounts, then compiles the current intent revisions against a generation-bound planning snapshot.
3. The service processes plugins, resolves approvals, pins Permit2 nonce/deadline/expiration inputs, and asks the SDK to deterministically materialize the plan. Lite records every prerequisite, main, and cleanup call, and rejects any SDK request-byte or insertion-coordinate disagreement before evaluating policy, simulating, and sealing one immutable reviewed execution. The reviewed execution commits to the raw and processed plugin plans by digest; their full values stay in a runtime preparation sidecar and are re-hashed before preview or Pyth-refresh use. Context-complete preview cache is reused only when the intent set, raw and prepared plan digests, wallet binding, approval mode, account set, and freshness all match.
4. The existing review modal renders the prepared preview and receives only an opaque `{ reviewId, reviewDigest }` binding. It cannot prepare, replan, sign, or submit.
5. Acceptance checks the binding and current cart generation. Before any wallet interaction, the coordinator synchronously guards that reviewed execution against duplicate confirmation in the current process.
6. The coordinator revalidates the exact wallet/session and policy, collects declared signatures, and verifies the finalized artifact against the reviewed request set. If static EOA prerequisites precede the single Pyth-bearing request, SDK `executeMaterialized` receipts that static prefix before Lite refreshes Pyth and hands the finalized suffix back to the SDK. Otherwise bounded Pyth refresh occurs immediately before the one transport handoff. Wallet and policy are checked again after refresh, and the refreshed publish times are synchronously checked after the final awaited pre-dispatch guard.
7. EOA receipt sequencing remains SDK-owned. The Safe adapter hands the reviewed atomic envelope to `wallet_sendCalls`, keeps the returned calls ID as an opaque string of at most 4096 bytes in the active invocation, and polls calls status to resolve the execution hash and receipt. It uses the ID as a transaction hash for receipt fallback only when the value has transaction-hash shape. Confirmed completion applies captured state effects even when modal/navigation effects are suppressed: exact submitted revisions are removed, newer revisions survive, and tagged external migrations schedule their refreshes. Conclusive revert, failure, or cancellation is reported as terminal. Unknown status remains unknown for the current invocation and never triggers fallback execution or automatic retry; it is not persisted for later reconciliation.

Every await across preparation and pre-handoff execution is guarded by generation or wallet-binding checks. A stale form, edited cart, changed connector session, expired operation-specific deadline, policy failure, or undeclared effect fails closed. An accepted in-memory review has no separate blanket timeout.

## Approvals and Gasless Signatures

Plans may include `requiredApproval` items. During review and execution, `resolveRequiredApprovals` resolves each approval to either:

- an ERC-20 approval transaction, or
- a Permit2 signature request.

Execution preparation resolves each approval according to the sealed wallet binding. On-chain approvals become explicit prerequisite effects and requests. Permit2 becomes a typed signature slot with exact insertion coordinates; only the resulting signature bytes may change after review.

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
| Execution wallet binding | Captures `approvalMode: 'permit2'` only for a resolved EOA with the effective preference enabled; Safe and unresolved/unsupported states fail closed to on-chain approval or abort preparation |
| Post-review behavior | Revalidates the exact account, chain, connector identity/session, wallet kind, and approval mode; it never changes approval strategy after consent |

When the **effective** flag is **off**, approval-capable flows fall back to on-chain approval transactions instead of Permit2 (and other) message signatures. Users can still turn the setting off on regular wallets that cannot sign typed data reliably. Safe wallets do not use that toggle: they are forced onto the approval / batched-transaction path.

Do not treat this as an Incentra- or rewards-specific switch — it covers every message signature on Lite's approval and migration-authorization paths (Permit2 approvals and migration typed-data grants), then narrows by the Safe override above. It is not a kill switch for all signing: CoW order and CoW EVC-permit signatures ignore it and are gated separately by `cowSwapForcedOff` (`composables/useCowSwapEligibility.ts`), so a user with the toggle off still signs those.

### Cross-protocol migrations

Outgoing migrate (`pages/position/[number]/migrate.vue`) and inbound external migrate (`pages/position/[number]/borrow/swap.vue`) thread the same **effective** flag as `useSignatures`:

- **On** → `authorizationKind: 'typedData'`; Morpho can append a signed post-migration disable (`removeAuthorizationAfterMigration`) inside the batch.
- **Off** → `authorizationKind: 'transaction'`; connector grants and restorations become explicit prerequisite and cleanup calls in the reviewed request set.

For an EOA, the coordinator dispatches the exact prerequisite, migration, and revocation requests through SDK-owned receipt sequencing. Every transaction-form grant and its reviewed revocation share one sealed authorization identity. After a confirmed temporary grant, a conclusive core rejection, revert, or pre-core failure dispatches only that paired reviewed revocation; it never synthesizes calldata. Unknown core status stops without cleanup because the core may still execute. A failed or unknown revocation preserves the migration result and reports that authorization may remain active. For a Safe, those same reviewed calls are normalized into one sealed EIP-5792 envelope. Review requires per-chain atomic capability `supported` or `ready`; handoff sets `atomicRequired: true`, never falls back, reports success only when calls status confirms `atomic: true`, and retains an unresolved retry gate for ambiguous submissions.

Typed-data migration authorization is also a declared signature slot. Its digest, signer, typed-data schema, reviewed EVC item, and ABI argument path are sealed. Finalization delegates the ABI-aware insertion to the documented SDK public encoder and rejects missing, ambiguous, or drifting coordinates.

## Operation Guards

`utils/operationGuardRegistry.ts` stores reactive submit blockers and per-concern metadata. Blockers gate the submit button (pending Keyring verification, unverified-vault acknowledgement); metadata annotates failures (e.g. keyring credential cost in `tx-errors`).

Plan transformation runs as SDK `EulerPlugin`s registered in `composables/useEulerSdk.ts`. Execution preparation processes the plugin pipeline once into the sealed preview:

- Terms-of-use signing — `createLiteTosPlugin()` (`utils/sdk-tos.ts`) prepends a signed terms-of-use `EVCBatchItem` to every `evcBatch` item. Injection only happens when `useTosGuard` has published a signed message for the owner and the chain's deployment has a `termsOfUseSigner` address.
- Keyring credential injection for private vaults — the SDK's [`createKeyringPlugin`](https://github.com/euler-xyz/euler-sdks/blob/main/packages/euler-v2-sdk/src/plugins/keyring/keyringPlugin.ts), configured with hook targets and a credential store from `utils/sdk-keyring.ts`. `composables/useOperationGuard.ts` publishes verified credentials into that store; the plugin prepends a Keyring `createCredential` `EVCBatchItem` when a plan touches a keyring hook target, the sender has no valid on-chain credential, and the store returns a current credential.

Submit blockers remain the operation-eligibility gate. Reviewed execution rechecks the connected wallet with the current VPN verdict and requires the TOS, Keyring, labels, chain-scoped vault metadata, canonical governor/owner verification, and authority bindings needed by the exact reviewed calls. Each intent retains the route operation that captured unverified-vault consent. Final policy groups retained intents by that operation and requires an acknowledgement for the exact unverified-vault set in each group, bound to the reviewed account and chain. Derived EVC accounts are bound into the reviewed request but are not screened as separate wallets. Country and labels versions are part of the accepted policy identity, and acquisition/swap intent sets re-evaluate vault and asset restrictions from their exact planner requirements before handoff. Plugin-prefetch reuse is context-bound and does not weaken those checks.

See the SDK side: [plugins.md](https://github.com/euler-xyz/euler-sdks/blob/main/packages/euler-v2-sdk/docs/plugins.md).

## Review Display

`components/entities/operation/OperationReviewModal.vue` is presentation-only. Its reviewed execution wrapper supplies the already prepared preview and opaque binding. The modal uses:

- `buildTransactionPlanDisplaySteps` for human-readable step labels and asset amounts
- `flattenBatchEntries` and `encodeBatch` for calldata copy and Tenderly simulation
- `deriveStateOverrides` for Tenderly state overrides

Copy calldata includes approval transactions, encoded EVC batches, and direct contract calls. Permit2 signatures are shown in the review steps but are not copyable calldata until the wallet signs them.

### User-facing review compatibility

The complete reviewed execution and the visible operation review serve different purposes. The reviewed execution is the internal execution authority: it records every call, request, authorization, policy result, simulation result, revocation step, and bounded value that may be refreshed. The review is an intentionally handcrafted product presentation for the operation. It can combine, summarize, reorder, or omit internal calls and is not expected to list them one-to-one.

Operation review components receive only their existing display inputs plus an opaque reviewed execution binding. They do not receive an execution closure and cannot sign or submit. Acceptance binds the current presentation digest and intent revisions to the sealed reviewed execution; submission uses the reviewed execution's materialized request vector through the coordinator.

Do not synthesize generic rows or expose internal targets, selectors, plugin calls, request digests, simulation classifications, cleanup metadata, or authorization machinery. Existing approval and signature presentation remains operation-specific. Unknown or undecodable production calls fail internal sealing instead of creating a fallback review row.

Pyth updates are completely invisible in review. Preview fees, maximum fees, feed IDs, payload hashes, publish times, freshness rules, execution-time refresh behavior, and refresh failures are internal reviewed execution data. A failed refresh follows the existing transaction-preparation error behavior and does not add a Pyth-specific review field or notice.

The rendered-output fixtures in `tests/reviewed-execution/inventory.test.ts` protect this contract. Changes to the visible review are separate product work and require explicit approval.

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

See the SDK side: [simulations-and-state-overrides.md](https://github.com/euler-xyz/euler-sdks/blob/main/packages/euler-v2-sdk/docs/simulations-and-state-overrides.md) (performance tuning section) and [execution-service.md](https://github.com/euler-xyz/euler-sdks/blob/main/packages/euler-v2-sdk/docs/execution-service.md) (prefetching plugin data).

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

### Batch simulation plugin layers

The SDK emits one simulated account layer per top-level batch **operation**. Plan plugins (ToS `signTermsOfUse`, Pyth price updates, Keyring credential injection) prepend loose operations ahead of cart entries, so a one-entry cart can return `[base, plugin…, afterOp]` instead of `[base, afterOp]`.

`buildOperationEntryMap(entryPlans, simulatedOperationCount)` in `useTxBatch` maps those operations back to cart rows:

- Prefix plugin operations fold into the base (layer 0 stays the pre-batch snapshot).
- Each entry's display layer is the state after its **last** operation.
- `failedBatchItems.operationIndex` resolves through the same map so failures mark the correct row.

After selection, a healthy sim must yield exactly `entries + 1` layers (`getCurrentFinalLayer`'s contract). Fresh Safes hit the ToS plugin path often because every Safe address is a new on-chain account — without the map, `awaitFinalPlanningLayer` exhausts retries into the generic "Batch simulation not loaded" error.

### Reviewed batch execution

Every cart entry stores a serializable intent and revision. `lastSimulatedPlan` and the layered simulated accounts remain non-authoritative projections for responsive forms. Review preparation recompiles or deeply validates the current generation, seals one complete request vector, and binds the existing batch display to it. Tenderly and calldata-copy actions derive from that sealed vector. Submission captures exact revisions and external-migration refresh requirements before wallet handoff. Confirmed completion applies those captured effects regardless of Safe detachment; modal closing, navigation, and visible success toasts remain context-scoped. A Safe submits the vector atomically; an EOA follows its explicit request phases. Details and CoW/signature gates: [Safe Wallet Compatibility](./safe-wallets.md).

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
| `composables/useEulerTx.ts` | Page-facing SDK planning, preview preparation, and simulation helpers; no wallet execution |
| `composables/useReviewedExecution.ts` | App integration for in-memory prepare/accept, policy revalidation, submission outcomes, and query invalidation |
| `features/reviewed-execution/` | Intents, compiler, immutable reviewed execution, policy, simulation, coordinator, finalization, and transport adapters |
| `composables/useTransactionPlanSimulation.ts` | Simulation state and error formatting for forms |
| `composables/useStateOverrideOptions.ts` | `SimulationStateOverrideOptions` builder + per-token slot-hint priming |
| `composables/batchPrefetchState.ts` | Form → batch handoff for pre-overlay accounts and chain-scoped slot hints |
| `composables/useTxBatch.ts` | Intent draft cart, non-authoritative merged preview, resimulation, plugin-layer map, and slot-hint reuse |
| `composables/useSafeWallet.ts` | Reactive Safe detection (`isSafeWallet` / `isSafeWalletResolved`) |
| `composables/useSafeExecutionDetachment.ts` | Close-review-while-cosigning; toasts until confirm or 5-min poll timeout |
| `components/entities/operation/OperationReviewModal.vue` | Presentation-only prepared-plan review, calldata copy, and Tenderly simulation |
| `utils/stepDecoding.ts` | SDK plan item decoding for review display |
| `utils/operationGuardRegistry.ts` | Submit blocker and operation metadata registry |
| `utils/sdk-keyring.ts` | Credential store and hook-target config for the SDK keyring plugin |
| `utils/sdk-tos.ts` | Terms-of-use SDK plugin (batch-item injection) |
| `composables/useSwapApi.ts` | Swap API request building and quote normalization |
