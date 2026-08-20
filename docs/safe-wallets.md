# Safe Wallet Compatibility

How Euler Lite detects Safe multisigs and binds them to the centralized reviewed execution so co-signers receive one reviewed atomic proposal.

## Why Safe is special

EOA flows can collect typed-data signatures and send prerequisite, main, and cleanup transactions sequentially. A Safe needs contract-signature handling and one coherent multisig proposal. The SDK's CoW executor accepts ECDSA signature encodings rather than Safe contract-signature payloads, so Lite also excludes CoW quotes while Safe detection is unresolved or positive.

Lite therefore:

1. Detects Safe connectors, including WalletConnect peer metadata.
2. Force-disables Permit2 and migration message-signature modes for a Safe.
3. Seals `walletKind: 'safe'`, the account, chain, connector identity/session, Safe address, and approval mode before review.
4. Materializes the complete reviewed request vector as one EIP-5792 `wallet_sendCalls` proposal with `forceAtomic: true`.
5. Persists the attempt before any wallet interaction and reconciles ambiguous proposal state from the durable journal.

## Detection

| Module | Role |
|--------|------|
| `utils/safeWalletTransactions.ts` | Connector identity, provider acquisition, and Safe status helpers |
| `composables/useSafeWallet.ts` | App-wide reactive `isSafeWallet` and `isSafeWalletResolved` |
| `composables/useReviewedExecution.ts` | Captures and twice verifies the connector session before sealing the wallet binding |

A wallet is Safe when any of these hold:

- wagmi connector `id === 'safe'` (iframe Safe App)
- connector name compact-equals `safe` or `safewallet`
- WalletConnect peer metadata name or URL matches Safe (`app.safe.global`)

`getSafeWalletProvider` only returns a provider for those cases. WalletConnect detection is asynchronous because it depends on peer metadata.

### Fail-closed resolution

`useSafeWallet` clears `isSafeWallet` and sets `isSafeWalletResolved = false` on every connector change until the probe finishes. Signature and CoW eligibility treat unresolved detection as forced off.

Executable reviewed execution preparation is stricter. It captures account, chain, connector UID, connector session digest, wallet kind, and approval mode, then reads them again after asynchronous Safe classification. An identifiable Safe without an available provider cannot produce a reviewed execution. Acceptance rechecks the same complete binding after policy validation, every signature, Pyth refresh, and immediately before dispatch.

## Signatures and Permit2

`composables/useSignaturePreference.ts` computes:

```ts
signaturesForcedOff = isSafeWallet || !isSafeWalletResolved
signaturesEnabled = userPreference && !signaturesForcedOff
```

- The stored preference (`signatures-enabled`, seeded once from `permit2-enabled`) is not overwritten.
- Settings disables the toggle while signatures are forced off.
- Execution preparation seals `approvalMode: 'permit2'` only for an eligible EOA; a Safe uses `approvalMode: 'approve'`.
- Approval strategy never changes after review. Any wallet-kind, session, account, chain, or approval-mode drift invalidates acceptance.
- CoW order and CoW EVC-permit signatures are outside this setting and are gated by `useCowSwapEligibility`.

## Atomic reviewed execution dispatch

The reviewed execution builds one exhaustive effect graph before review. Approvals, migration authorization grants, the main Euler action, and authorization restorations are explicit prerequisite, main, and cleanup effects. The same graph produces transport-specific requests:

- EOA: an ordered sequence of exact requests, each verified against its submitted transaction and receipt.
- Safe: one ordered `SafeCall[]` vector submitted with `wallet_sendCalls({ forceAtomic: true })`.

`SafeExecutionAdapter` records the returned calls ID, reads the proposed calls back, compares the semantic call-vector digest, waits for status, records the execution hash when available, and verifies the execution receipt. Off-chain cancellation and on-chain revert are terminal. Missing or ambiguous status becomes `recovery-required`; it never triggers a fallback EOA or sequential send.

The coordinator reserves a durable, wallet-scoped lane before signatures or dispatch. This prevents concurrent tabs from creating overlapping attempts for the same account and chain. The emergency switch can block new reviewed executions without disabling recovery of already reserved attempts.

### Batch and migration

Batch drafts contain only serializable intents and revisions. Review preparation recompiles or deeply validates the current generation and seals one request vector. The visible batch review and calldata/Tenderly actions project from that vector; `lastSimulatedPlan` is only an preview form-layer projection.

Migration authorization grants and restorations use the same reviewed execution. For a Safe they are calls inside the atomic proposal, so a reverted proposal reverts them together. Typed-data migration authorization is not used for a Safe. For an EOA, cleanup obligations are journaled before dispatch and remain recoverable if a prerequisite succeeds but a later request does not.

## CoW Swap gating

`composables/useCowSwapEligibility.ts` computes:

```ts
cowSwapForcedOff = isSafeWallet || !isSafeWalletResolved
```

Quote consumers AND this into `includeCowSwap`. `useSwapQuotesParallel` re-evaluates the gate per sweep: when it becomes forced off, CoW cards are evicted; when a regular-wallet classification resolves, the last quote request is replayed.

Defence in depth: `useCowSwapExecutionCore.assertTransactionsEnabled` throws before any CoW wallet write if Safe detection is positive or unresolved. CoW solver-order execution remains an explicitly excluded wallet-write boundary outside reviewed execution V2.

## Durable recovery

`IndexedDbSubmissionJournal` stores the sealed reviewed execution, attempt reservation, state transitions, external IDs, and cleanup obligations. `ReviewedExecutionRecovery` starts at the app root and reconciles non-terminal attempts.

Safe recovery uses the recorded calls ID and execution hash to distinguish:

- confirmed success,
- proven off-chain cancellation,
- proven on-chain revert,
- still-pending or unavailable status requiring continued reconciliation.

The presentation layer may detach while co-signers act, but durability does not depend on the modal or route remaining mounted. An account or connector change cannot attribute completion to another wallet because every continuation verifies the sealed binding and fenced reservation.

## Related UI

- `components/entities/safe/SafeAccountBadge.vue` — Safe badge on vault overview address rows
- `composables/useSafeAddressInfo.ts` and `utils/safe-account.ts` — Safe owner/threshold lookup
- `components/BatchReviewModal.vue` — unchanged handcrafted batch presentation
- `components/entities/operation/OperationReviewModal.vue` — presentation-only operation review
- `components/entities/reviewed-execution/ReviewedExecutionRecovery.vue` — root recovery surface
- Settings → signatures toggle — disabled while `signaturesForcedOff`

## Pitfalls

| Symptom | Likely cause |
|---------|--------------|
| Permit2 appears for a Safe | Detection/binding regression; Safe reviewed executions must seal `approvalMode: 'approve'` |
| More than one Safe proposal appears | A wallet-write path bypassed the reviewed execution or the request vector changed after sealing |
| Review succeeds but acceptance fails | Cart generation, connector session, account, chain, wallet kind, approval mode, policy, or reviewed execution freshness changed |
| Safe proposal remains pending after reload | Expected; recovery uses the journaled calls ID rather than resubmitting |
| Review said one proposal but execution attempted many | Transport was not derived from the sealed wallet binding |
| CoW quotes flash then vanish | Safe detection resolved after the first sweep; forced-off eviction is expected |

## Tests

- `tests/composables/useSafeWallet.test.ts`
- `tests/composables/useSafeAddressInfo.test.ts`
- `tests/utils/safeWalletTransactions.test.ts`
- `tests/utils/safe-account.test.ts`
- `tests/utils/batchReviewDisplay.test.ts`
- `tests/composables/useTxBatch.test.ts`
- `tests/composables/useSwapQuotesParallel.test.ts`
- `tests/reviewed-execution/coordinator.test.ts`
- `tests/reviewed-execution/journal.test.ts`
- `tests/reviewed-execution/recovery.test.ts`

## Files

| File | Purpose |
|------|---------|
| `composables/useSafeWallet.ts` | Reactive Safe detection |
| `composables/useSignaturePreference.ts` | Force-off signatures for Safe |
| `composables/useCowSwapEligibility.ts` | Force-off CoW for Safe |
| `composables/useReviewedExecution.ts` | Wallet binding, reviewed execution app clients, acceptance, and recovery integration |
| `features/reviewed-execution/adapters/safe.ts` | Exact Safe call-vector dispatch and verification |
| `features/reviewed-execution/coordinator/coordinator.ts` | Durable reservation, lifecycle, and transport selection |
| `features/reviewed-execution/persistence/journal.ts` | IndexedDB reviewed execution and attempt journal |
| `components/entities/reviewed-execution/ReviewedExecutionRecovery.vue` | Recovery UI |
| `utils/safeWalletTransactions.ts` | Provider identity and Safe status helpers |
