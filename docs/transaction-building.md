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

The wrapper supplies the current SDK `Account`, wallet/sub-account owner, chain id, Permit2 preference, and wallet callbacks. The quote and vault inputs stay explicit at the page/composable boundary.

## Execution Flow

1. A page or workflow composable builds a `TransactionPlan` with `useEulerTx()`.
2. `useTransactionPlanSimulation().runSimulation(plan)` applies operation guards and calls `sdk.executionService.simulateTransactionPlan(...)`.
3. The review modal prepares the plan with `preparePlanForReview(plan)`.
4. `preparePlanForReview` applies operation guards and calls `sdk.executionService.resolveRequiredApprovals(...)`.
5. The review modal renders the prepared plan via `utils/stepDecoding.ts`.
6. Confirming calls the workflow callback, which executes the plan through `executePlan(plan)`.
7. `executePlan` applies operation guards, calls `sdk.executionService.executeTransactionPlan(...)`, forwards wagmi `sendTransaction` / `signTypedData` callbacks, and refreshes portfolio state after receipts.

The review modal is fail-closed: if preparation does not produce a plan, it shows an error and disables confirmation.

## Approvals and Permit2

Plans may include `requiredApproval` items. During review and execution, `resolveRequiredApprovals` resolves each approval to either:

- an ERC-20 approval transaction, or
- a Permit2 signature request.

`executeTransactionPlan` sends approval transactions before the main EVC batch and inserts Permit2 signature data into the next batch where required. Incentra chooses whether message signatures are enabled through `useSignaturePreference()`; disabling them makes approval-capable flows use transactions instead.

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
- Heavy single-shot `runSimulation` / `runPreparedSimulation` call-sites pass `buildStateOverrideOptions({ noBalanceOverride })` directly:
  - `composables/repay/useWalletSwapRepay.ts`
  - `composables/repay/useCollateralSwapRepay.ts`
  - `pages/lend/[vault]/index.vue` (final pre-review simulation)
  - `composables/borrow/useMultiplyForm.ts` (Review-time prepared simulation)

`noBalanceOverride: true` is only safe when the operation either doesn't consume wallet ERC20 (collateral-swap repay, debt swap) or the form already gates submit on wallet balance (multiply, borrow, lend deposit, wallet-swap repay's EXACT_IN). Withdraw mode on `useCollateralForm` keeps the override but skips the balance branch by binding `noBalanceOverride` to `mode === 'supply'`.

`primeSlotHintsFor` is owner-/spender-agnostic; the SDK caches results in a module-scope `slotHintsCache` keyed on chain id + token, so a successful probe in one page warms the cache for every other page in the session.

See the SDK side: `packages/euler-v2-sdk/docs/simulations-and-state-overrides.md` (performance tuning section) and `packages/euler-v2-sdk/docs/execution-service.md` (prefetching plugin data).

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
| `components/entities/operation/OperationReviewModal.vue` | Prepared-plan review, calldata copy, and Tenderly simulation |
| `utils/stepDecoding.ts` | SDK plan item decoding for review display |
| `utils/operationGuardRegistry.ts` | Guard transformer and blocker registry |
| `utils/keyring-injection.ts` | Keyring credential batch-item injection |
| `utils/tos-injection.ts` | Terms-of-use batch-item injection |
| `composables/useSwapApi.ts` | Swap API request building and quote normalization |
