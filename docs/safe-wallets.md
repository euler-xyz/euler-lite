# Safe Wallet Compatibility

How Euler Lite detects Safe multisigs and binds them to the centralized reviewed execution so co-signers receive one reviewed atomic proposal.

## Why Safe is special

EOA flows can collect typed-data signatures and send prerequisite, main, and cleanup transactions sequentially. A Safe needs contract-signature handling and one coherent multisig proposal. The SDK's CoW executor accepts ECDSA signature encodings rather than Safe contract-signature payloads, so Lite also excludes CoW quotes while Safe detection is unresolved or positive.

Lite therefore:

1. Detects Safe connectors, including WalletConnect peer metadata.
2. Force-disables Permit2 and migration message-signature modes for a Safe.
3. Seals `walletKind: 'safe'`, the account, chain, connector identity/session, Safe address, and approval mode before review.
4. Requires per-chain EIP-5792 atomic capability to be `supported` or `ready`, then seals the complete `wallet_sendCalls` envelope with `atomicRequired: true`.
5. Guards duplicate confirmation before wallet handoff, then uses the established in-memory Safe detachment/status flow while co-signers act.

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

Executable reviewed execution preparation is stricter. It captures account, chain, connector UID, connector session digest, wallet kind, and approval mode, then reads them again after asynchronous Safe classification. An identifiable Safe without an available provider cannot produce a reviewed execution. Preparation also calls `wallet_getCapabilities` for that account and chain; missing or `unsupported` atomic capability blocks review, while `supported` and `ready` are admitted and sealed. Acceptance rechecks the wallet binding after policy validation, every signature, Pyth refresh, and immediately before dispatch, and revalidates atomic capability before handoff.

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

- EOA: an ordered sequence of exact requests, each checked before the wallet prompt and advanced by the SDK only after a successful receipt.
- Safe: one ordered envelope containing version, from, chain, `atomicRequired: true`, exact calls, request capabilities, and the admitted atomic-capability snapshot. The reviewed Safe provider receives those exact serialized `wallet_sendCalls` fields directly, without a client layer injecting unreviewed capabilities.

`SafeExecutionAdapter` verifies and hands the exact finalized envelope to `wallet_sendCalls`, keeps the returned calls ID in the active invocation, and uses the established current-session status poller to resolve the execution hash and receipt. A successful result additionally requires `wallet_getCallsStatus.atomic === true`; explicit non-atomic execution fails the reviewed guarantee, while missing atomic evidence cannot become success. Off-chain cancellation and on-chain revert are terminal. Missing or ambiguous status is reported as unknown; it never triggers a fallback EOA, sequential send, automatic retry, or durable reconciliation.

The coordinator synchronously guards the accepted review ID before signatures or dispatch so overlapping callbacks for that reviewed execution cannot open duplicate wallet requests. The guard is process-local and is not restored after reload. Once the Safe request is handed off, `useSafeExecutionDetachment` retains the existing single tracked-execution UI slot: the modal may close while co-signers act, confirmations remain gated in that session, and completion is attributed to the captured context.

### Batch and migration

Batch drafts contain only serializable intents and revisions. Review preparation recompiles or deeply validates the current generation and seals one request vector. The visible batch review and calldata/Tenderly actions project from that vector; `lastSimulatedPlan` is only a preview form-layer projection.

Migration authorization grants and revocations/restorations use the same reviewed execution. For a Safe they are calls inside the atomic proposal, so a reverted proposal reverts them together. Typed-data migration authorization is not used for a Safe. For an EOA, the SDK advances from a successful migration receipt to the reviewed revocation request. A revocation problem is reported separately and does not turn the migration into a failure or block a fresh operation.

## CoW Swap gating

`composables/useCowSwapEligibility.ts` computes:

```ts
cowSwapForcedOff = isSafeWallet || !isSafeWalletResolved
```

Quote consumers AND this into `includeCowSwap`. `useSwapQuotesParallel` re-evaluates the gate per sweep: when it becomes forced off, CoW cards are evicted; when a regular-wallet classification resolves, the last quote request is replayed.

Defence in depth: `useCowSwapExecutionCore.assertTransactionsEnabled` throws before any CoW wallet write if Safe detection is positive or unresolved. CoW solver-order execution remains an explicitly excluded wallet-write boundary outside reviewed execution V2.

## Current-session detachment

`useSafeExecutionDetachment` lets the review modal close while the Safe request waits for co-signers. Its module-scoped tracked execution records whether the flow reached its success point and whether the original wallet context was abandoned.

The active Safe flow distinguishes:

- confirmed success,
- proven off-chain cancellation,
- proven on-chain revert,
- pending or unavailable status in the current session.

Detachment suppresses stale modal closure and navigation while still allowing a context-scoped completion toast. An account or connector change abandons the tracked UI record so a late completion cannot affect the newly connected context. This state is intentionally in-memory: reload restores no reviewed execution, submission record, or application lock.

## Related UI

- `components/entities/safe/SafeAccountBadge.vue` — Safe badge on vault overview address rows
- `composables/useSafeAddressInfo.ts` and `utils/safe-account.ts` — Safe owner/threshold lookup
- `components/BatchReviewModal.vue` — unchanged handcrafted batch presentation
- `components/entities/operation/OperationReviewModal.vue` — presentation-only operation review
- `composables/useSafeExecutionDetachment.ts` — current-session modal detachment, confirmation gate, and completion toasts
- Settings → signatures toggle — disabled while `signaturesForcedOff`

## Pitfalls

| Symptom | Likely cause |
|---------|--------------|
| Permit2 appears for a Safe | Detection/binding regression; Safe reviewed executions must seal `approvalMode: 'approve'` |
| More than one Safe proposal appears | A wallet-write path bypassed the reviewed execution or the request vector changed after sealing |
| Review succeeds but acceptance fails | Cart generation, connector session, account, chain, wallet kind, approval mode, policy, or reviewed execution freshness changed |
| Safe review is unavailable | The wallet did not advertise per-chain atomic capability as `supported` or `ready` |
| Safe proposal remains pending after reload | Check the Safe UI; Lite does not restore the old reviewed execution or tracked status after reload |
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
- `tests/composables/useSafeExecutionDetachment.test.ts`

## Files

| File | Purpose |
|------|---------|
| `composables/useSafeWallet.ts` | Reactive Safe detection |
| `composables/useSignaturePreference.ts` | Force-off signatures for Safe |
| `composables/useCowSwapEligibility.ts` | Force-off CoW for Safe |
| `composables/useReviewedExecution.ts` | Wallet binding, reviewed execution preparation, acceptance, and current-session outcome integration |
| `features/reviewed-execution/adapters/safe.ts` | Exact Safe call-vector dispatch and verification |
| `features/reviewed-execution/coordinator/coordinator.ts` | Synchronous duplicate guard, revalidation, bounded finalization, phase outcomes, and transport selection |
| `composables/useSafeExecutionDetachment.ts` | In-memory post-handoff Safe tracking and context-scoped UI effects |
| `utils/safeWalletTransactions.ts` | Provider identity and Safe status helpers |
