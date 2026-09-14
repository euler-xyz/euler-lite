# Reviewed Transaction Execution Inventory

This inventory records the centralized reviewed-execution boundary. The machine-readable registry is `features/reviewed-execution/inventory/registry.ts`; its test fails when a production planner, batch-form branch, review launcher, or wallet-write owner appears without an explicit disposition.

The inventory uses two consent-bearing lifecycle records: `OperationIntent` and `ReviewedExecution`. Submission produces a current-session `SubmissionResult`; request sets, effects, simulations, policies, bindings, snapshots, slots, finalized requests, and cache records are internal implementation details.

## Operation coverage

The in-scope operation families are supply, withdraw/redeem, borrow, repay, collateral and debt swaps, multiply, refinance, cross-protocol migration, transfer/cleanup, SDK reward claims, and rEUL unlocks. Direct and batch variants share one reviewed execution service and one submission coordinator.

CoW solver-order flows remain outside this reviewed execution. Their wallet-write owner is frozen as an excluded boundary so a new excluded caller cannot appear accidentally.

FeeFlow buy and liquidation execution have no production Lite caller on the inventory baseline. They remain explicit `absent` rows; Lite exposes neither an unused intent nor an execution route for them.

## Irreversible boundaries

The only in-scope wallet-write boundary is `composables/useReviewedExecution.ts`, which supplies app clients to the centralized coordinator. EOA sends and Safe `wallet_sendCalls` are dispatched only through `features/reviewed-execution/adapters/eoa.ts` and `features/reviewed-execution/adapters/safe.ts`. Signature collection, migration prerequisites and revocation, the synchronous duplicate-invocation guard, and request verification all remain inside that reviewed execution boundary. `composables/useEulerTx.ts` is planning and simulation only. After Safe handoff, the established `useSafeExecutionDetachment` flow owns current-session waiting, modal detachment, confirmation gating, and context-scoped completion toasts.

Spy-mode review preparation (`prepareReadOnly` / `createReadOnlyWalletBinding`) compiles the same intent set against a synthetic approval-only binding. It is not a wallet-write owner: `useExecutionReview` opens `OperationReviewModal` with `readOnly: true`, and `BatchReviewModal` refuses execute when the prepared execution is marked `readOnly`. Details: [Transaction Building](./transaction-building.md#spy-mode-review-preparation).

The excluded CoW boundary is `composables/cowswap/useCowSwapExecutionCore.ts`.

## Preview preparation and cache reuse

These producers warm context-complete preview-cache records:

- Fresh planning accounts from `useFreshAccount` and base accounts from `useEulerAccount`.
- Chain/token-scoped ERC-20 slot hints from `useStateOverrideOptions` and `batchPrefetchState`.
- Quote-sweep account snapshots, quotes, plugin prefetch, gas inputs, and prepared simulations.
- Whole-cart simulation layers and merged-plan results from `useTxBatch`.
- Migration target, authorization, calldata, and simulation previews.

Cache adoption requires complete owner, chain, account/subaccount, connector/session where material, generation, intent revision, data-source version, compiler/schema version, freshness, and request-digest identity. `lastSimulatedPlan` remains a non-authoritative layered projection. A cache hit avoids redundant I/O; it never makes a page-owned plan executable.

## Review compatibility baseline

`OperationReviewModal.vue`, `BatchReviewModal.vue`, `utils/stepDecoding.ts`, and `utils/batchReviewDisplay.ts` define the current handcrafted presentation. The Stage A compatibility fixture freezes both modal templates and both display mappers byte-for-byte and separately rejects visible Pyth terminology. The production-browser rendered-state matrix is a distinct code-freeze gate; the source fixture does not substitute for it.

The visible presentation intentionally does not enumerate internal effects. Pyth targets, feeds, fees, payloads, freshness, and refresh behavior are internal reviewed execution data and do not appear in review.

## Batch responsiveness registry

The registry contains 24 production Add-to-batch branches across 14 source owners. Each branch has a route/setup, the trusted action locator, and a stable row-identity contract. The static inventory test proves that every discovered branch owns one matrix case. Production-browser click-to-painted-row timings, including delayed-dependency runs, are separate Stage G artifacts and must be captured before code freeze; registry coverage alone is not timing evidence.
