# Euler Lite Centralized Reviewed Execution

## One-PR implementation plan

Status: proposed

Target repository: `/Users/dariusz/Euler/euler-lite`

Target base: `origin/development`

Verified baseline: `cc4fbd342240efc2622e6342e101e5c1951b4139`
Evidence refreshed: 2026-08-20

## 1. Objective

Reimplement the in-scope transaction lifecycle from scratch so that:

> The user accepts the digest of one immutable, wallet-bound execution template, and execution submits exactly that template.

Execution may fill only signature slots declared before review, the bounded Pyth refresh slots described in section 5.5, and wallet-owned transport fields such as gas and fee parameters. It may not rebuild an operation plan, adopt unrestricted output from a rerun plugin pipeline, change approval mode, reclassify the wallet, change any static calldata or value, or read reactive form state after acceptance.

The system must also preserve retry safety: once a wallet may have accepted a request, another attempt cannot be submitted until transport-specific evidence establishes the first attempt's outcome.

## 2. Scope

Included:

- Direct EOA transaction-plan execution.
- Safe/EIP-5792 execution.
- Single operations and batches.
- Approvals and Permit2 signatures.
- Direct contract calls and EVC batches.
- Plugin-injected effects, including TOS, Keyring, and Pyth.
- Rewards, rEUL, swaps, and multiply/refinance flows.
- Inbound and outbound migrations, including authorization prerequisites and cleanup.
- Policy checks, review rendering, simulation, persistence, reconciliation, and recovery for those flows.

The starting `development` inventory has no production FeeFlow buy caller and no liquidation execution caller. Record both as explicit absent rows and do not create unused Lite intents or UI routes for them. If either surface appears on the rebased implementation baseline, it enters scope through the same inventory gate; until then, FeeFlow and liquidation behavior is an SDK release-contract concern only.

Excluded:

- Off-chain solver-order workflows. Their existing implementation remains unchanged and outside the guarantees in this document.

The completion claim is therefore:

> Every in-scope Euler transaction-plan operation uses the same reviewed-ceremony and submission-coordinator boundary.

It is not an application-wide claim about excluded workflows.

## 3. Delivery model: one implementation PR

This work is delivered as one Euler Lite PR, not a chain of implementation PRs.

- Create one persistent clean worktree and branch from the verified `origin/development` lineage, for example `refactor/transaction-ceremony-v2`.
- Open one draft PR against `development`.
- Use coherent, buildable commits for the internal stages below, but do not create a PR per stage.
- Keep the PR draft until the complete transaction inventory has migrated, legacy in-scope entry points have been removed, all tests pass, and the fresh-agent review gate is clean.
- Do not cherry-pick or merge PR #810 or PRs #781-#784. Extract their retained requirements, adversarial scenarios, and discriminating tests only, then implement them through the new intent/compiler boundary.
- Treat current `development` as the behavior and operation-surface baseline, not as the architecture template. Replace its in-scope transaction orchestration behind the new boundary instead of preserving it internally.
- At kickoff and again before code freeze, compare `master...development` and account for applicable production hotfixes. Keep unrelated branch synchronization out of this PR; rebase onto the maintainer-synchronized `development` head instead.
- Do not merge a partially safe implementation behind a public per-flow rollout. The PR is merged only when every in-scope production path is behind the coordinator.
- Retain an emergency switch that prevents creation of new ceremonies. It must never disable recovery for attempts already started.

### SDK release prerequisite

This plan assumes a published SDK release containing the reviewed behavior from SDK PRs #89, #90, and #91. The inspected source heads are `03b4af68d1b1e2bc3a2f1f65e2da4f259308b115`, `fc2a4fb319e661558fde1cb52a3a2a0e04999ab9`, and `cc9f17ee37eb5c8d58264dbc084e655e2839ddf7`, respectively. The release, rather than a local symlink or those branch SHAs, is the implementation dependency.

At kickoff, pin the published version and prove with targeted integration tests that it provides:

- Fail-closed required-plugin processing, complete liquidation Pyth feed discovery, selected-only Fuul claims, and chain-safe reward/plugin data.
- Stable reward/Pyth operation boundaries and the planner invariants for swap tokens, debt-swap accounts, migration sweeps, and liquidation approvals.
- FeeFlow buy execution disabled until an atomic minimum-payout contract exists.
- `ContractCall.simulationMode: 'independent'` with direct-call failure propagation and an empty Euler account/vault state projection for a successful direct-only call; Turtle claim plans opt into it.

The SDK documentation must state the simulation contract in section 5.7: approvals and migration authorization are modeled rather than executed, EVC effects are state-simulated, independent direct calls produce no Euler state projection, and Pyth data is normally refreshed at execution. Link that document from the public comments for `simulateTransactionPlan`, `simulatePreparedTransactionPlan`, the prepare/execute methods, and `ContractCall.simulationMode` so callers do not infer full sequential simulation from the method names.

Use only that release's public planners, plugin processor, decoders, simulation APIs, typed-data builders, and encoders. In particular, Lite may use the public `prefetchPluginDataForPlan` and `processPlanPlugins` methods for the bounded refresh protocol in section 5.5. A dedicated Pyth-only SDK processor is optional and is not a release prerequisite. Lite owns the deterministic materialization and structural-verification layers that convert SDK output into the sealed transport template before review and accept only declared dynamic differences afterward.

The V2 execution path must not call the SDK's opaque execute method after acceptance. It walks the sealed template itself through the coordinator and adapters.

If the published release lacks any assumed behavior or a required operation cannot be materialized using its public APIs, stop and surface that as a design blocker. Do not restore a raw-plan fallback, copy private SDK internals, or silently weaken the coverage or equality contracts.

### Why `development`, not `master`

At the evidence snapshot above, GitHub identifies `development` as the default branch. It is 149 commits ahead of and 15 commits behind `master`, and 23 of 24 open PRs target it. More importantly, it contains the current Safe, migration, batch, plugin, and transaction-finalization surfaces and their regression tests. Building from `master` would require rediscovering or later rebasing across those surfaces, recreating the cross-route omissions that prolonged the earlier reviews.

The meaningful `master`-only changes in this snapshot are production maintenance changes rather than an alternate transaction architecture. They must still be reconciled through the normal branch-sync process. Starting from `development` does not authorize copying PR #810 or PRs #781-#784; “from scratch” refers to the ceremony/coordinator architecture.

## 4. Sources of truth

Use this priority order:

1. Current `development` behavior, operation inventory, and existing protections.
2. Applicable `master`-only production hotfixes identified by the branch-delta check.
3. The live-reconciled Apex requirements below, interpreted through the assumed SDK release contract.
4. Exact-head review findings and discriminating tests from PR #810 and PRs #781-#784.
5. Existing golden calldata and execution fixtures.
6. Historical branch implementations only as explanatory evidence, never as architecture authority.

Current evidence snapshot:

| PR | Exact inspected head | Relevant status | Use in this plan |
| --- | --- | --- | --- |
| [#810](https://github.com/euler-xyz/euler-lite/pull/810) | `079d05dd4b1241db71c09100080182af39697277` | Open, conflicting, current head has no independent exact-head approval | Regression and dead-end catalogue |
| [#781](https://github.com/euler-xyz/euler-lite/pull/781) | `e6a4ddf247cdbc605d9e34565c712d325071bf4b` | Open; current head supersedes its last approval | Policy-subject and fail-closed tests |
| [#782](https://github.com/euler-xyz/euler-lite/pull/782) | `4f395047f45bc9719da71e0a44d29480c2a08147` | Open; current head has no exact-head approval | Review/execution, signature, and retry tests |
| [#783](https://github.com/euler-xyz/euler-lite/pull/783) | `bf99e3c64ad981059453fd7b8380d7970fe4cace` | Exact-head approved | Policy freshness and lifecycle requirements |
| [#784](https://github.com/euler-xyz/euler-lite/pull/784) | `6d2f798a5059a8b3e3422e62bbfbc8a6a436661d` | Exact-head changes requested | Safe context, persistence, and stale-publication tests |

### Apex requirement reconciliation under the assumed SDK release

The live Linear set contains 44 Apex tickets: 26 Backlog and 18 Canceled. Their status is evidence, not an instruction to reproduce stale remediation. Apply this disposition at implementation kickoff and recheck it against the pinned SDK release:

| Disposition | Linear tickets | Plan treatment |
| --- | --- | --- |
| Retained Lite requirements | LITE-278, LITE-282, LITE-284, LITE-285, LITE-287, LITE-288, LITE-293, LITE-294, LITE-295, LITE-298, LITE-299, LITE-300, LITE-308, LITE-310, LITE-319, LITE-321 | Still valid as Lite behavior and conformance work. Preserve protections already present on `development` and implement the missing centralized guarantees. |
| Valid findings satisfied by the assumed SDK release | LITE-281, LITE-283, LITE-291, LITE-304, LITE-305, LITE-307, LITE-311, LITE-314, LITE-316, LITE-318 | Do not reimplement in Lite. Pin the release and retain focused integration/golden tests. LITE-281 uses the narrower section 5.7 contract; LITE-304 and LITE-318 have no current Lite caller. |
| Canceled tickets whose underlying concern is retained with revised semantics | LITE-280, LITE-289, LITE-292 | Static plugin effects remain internally verified; Pyth payload and exact fee are a bounded refresh slot, not immutable bytes. Fresh Pyth failure blocks dispatch. Pyth processing remains transparent to the user and adds no review fields, fee notice, freshness notice, or other visible output. |
| Canceled SDK safety item covered by the assumed release | LITE-290 | Keep a fail-closed Pyth integration test; no separate Lite implementation. |
| Remain canceled under these assumptions | LITE-279, LITE-286, LITE-296, LITE-297, LITE-301, LITE-302, LITE-303, LITE-306, LITE-309, LITE-312, LITE-313, LITE-315, LITE-317, LITE-320 | Do not revive their original remediation. Cover any independently retained lifecycle or policy invariant through the centralized architecture and current tests. |

This means the Apex findings are not all still active Lite tickets. Sixteen remain direct Lite requirements (including protections already present on `development`); ten become SDK-version gates; three supply revised plugin/Pyth requirements; one is an SDK fail-closed regression; and fourteen remain canceled.

## 5. Non-negotiable invariants

### 5.1 One consent-bearing artifact

For a ceremony `C`, canonical comparison normalizes only fields represented by a typed slot in the accepted template:

```text
digest(accepted execution template C)
  = digest(simulated template C)
  = digest(calldata export C)
  = digest(Tenderly projection C)
  = digest(normalized submitted artifact C,
           normalizing declared signature, Pyth-refresh,
           and wallet transport slots)
```

The digest commits to slot kind, position, target, selector, feed set, freshness rule, and value bound. It does not pretend that a fresh Pyth payload or its exact fee bytes were known at review time. Internal projection metadata records the preview payload hash for literal calldata and Tenderly output; this adds no user-facing review label or notice.

Only one execution plan exists. The existing handcrafted, operation-specific review models remain separate non-executable presentation models and are intentionally not required to map one-to-one onto transaction-plan or EVC-batch items. Each presentation is bound to the exact intent IDs/revisions and ceremony it confirms, but it does not become execution authority.

The visible review is not part of the byte-equality equation above. `OperationReviewBinding` proves which existing presentation inputs and intent revisions the user confirmed; it is not a generic decoder of the execution template and must not reshape the visible review to mirror internal calls.

### 5.2 No work after acceptance that can change meaning

After `accept(ceremonyId, consentDigest)`, these are unreachable:

- Operation planners.
- Page-owned or unverified plugin processing. The coordinator may call the public SDK plugin prefetch and processing methods only with the sealed raw pre-plugin plan and sealed plugin configuration, then pass the result through the structural verifier in section 5.5.
- Approval resolution.
- Quote refresh.
- Safe reclassification.
- Migration-plan construction.
- Reactive form, page, or batch builders.
- Alternate calldata or Tenderly preparation.

Validity and policy checks may return valid or invalid. They may not transform the artifact. Pyth refresh finalizes only its declared slots and cannot add, remove, reorder, or retarget effects.

### 5.3 Complete transport materialization

Before review, materialize and digest either:

- The exact ordered EOA requests; or
- The complete Safe call vector, including approvals, prerequisite grants, main calls, wrappers, and cleanup calls.

Wallet kind, Safe classification, connector session, approval mode, and batching strategy must be resolved before sealing. A later change invalidates the ceremony. There is no execution-time repair or fallback.

### 5.4 Typed signature slots

Each signature slot commits to:

- Slot ID and purpose.
- Signer and chain.
- Complete typed data and typed-data digest.
- Target step, ABI argument, and exact insertion path.
- Expiration and nonce where applicable.

Finalization may change only those locations. Byte-pattern searches, all-zero wildcards, selector-only exceptions, and broad expected-difference rules are prohibited.

### 5.5 Typed Pyth refresh slots

Pyth is intentionally dynamic. The reviewed template commits to a typed refresh slot containing:

- Chain, official Pyth target, `updatePriceFeeds` selector, insertion point, and affected `effectId`.
- The exact required feed-ID set derived from the final operation graph.
- The SDK freshness policy and the maximum native update fee accepted by the configured Pyth plugin.
- The preview payload hash, publish-time evidence, and fee used by review-time simulation.

At review, Lite seals both the raw pre-plugin plan and the fully processed preview plan. The Pyth plugin receives an explicit Lite-owned `maxUpdateFee`; the ceremony commits to that configured bound rather than relying on an implicit SDK default.

After durable reservation and immediately before dispatch, the coordinator reruns the public SDK plugin prefetch and complete plugin pipeline against that same sealed raw plan. Lite does not adopt the result directly. A structural verifier compares it with the sealed preview and accepts only changes represented by the declared Pyth slot: a fresh `updatePriceFeeds` payload and its native fee at or below the sealed maximum. Pyth target, selector, feed set, insertion point, effect ordering, chain, and account remain immutable. TOS, Keyring, and every other plugin output must be byte-for-byte and structurally unchanged; any added, removed, reordered, retargeted, or modified static effect fails before a wallet request.

Pyth is the only dynamic plugin kind in the initial schema, for example `pyth-update-v1`. Supporting another dynamic plugin requires a new versioned slot type, structural validator, internal policy treatment, and regression suite. This restriction is Lite-owned and does not require an SDK API that filters execution to Pyth alone.

### 5.6 Complete effects and bounded outcomes

Every approval, native-value transfer, direct call, EVC call, prerequisite, plugin effect, and cleanup obligation is a typed effect with provenance and a stable ID.

Variable operations must encode enforceable limits such as exact/max input, minimum output, bounded share movement, deadline/epoch, selected reward set, or explicit remainder-loss policy. An unbounded effect is rejected or isolated into a newly reviewed ceremony.

### 5.7 Honest, classified simulation coverage

Simulation is independent from review, calldata export, and Tenderly construction. Those projections are always derived from the sealed template even when a simulation class produces no Euler state data.

Every effect receives one explicit coverage class:

- `evc-state`: the complete ordered EVC batch, including plugin calls present in the preview plan, is state-simulated. Approval needs are satisfied with documented state overrides; no approval transaction or permit is claimed to have executed.
- `modeled-authorization`: Permit2 and migration signatures/authorizations use typed metadata, deterministic stubs, or state overrides as documented by the SDK. The certificate records the assumption and does not invent a receipt or state transition.
- `independent-call`: a direct call explicitly marked by the SDK as safe against pre-plan state is simulated independently. Lite permits this only for a direct-only plan with no EVC batch and no dependency on another plan item. The current production case is Turtle rewards. Success returns `canExecute: true` with empty `simulatedAccounts` and `simulatedVaults`; calldata and Tenderly still use the exact call.
- `not-state-simulated`: an allowlisted existing reward-only direct call may be reviewed and exported without an Euler state projection. The internal simulation certificate records that coverage. It does not add a visible review warning or field. New direct-call categories are rejected unless this architecture is deliberately updated; future transaction planners should use EVC batching where possible.

Do not perform a costly sequential backend simulation of approvals, permits, plugin prerequisites, or reward side effects. Do not combine an unsimulated direct call with an EVC batch and then present the EVC result as full-plan simulation. Results and assumptions map by `effectId`, never by array position.

### 5.8 Policy from the final graph

Policy subjects are derived exclusively from the final typed effect graph. They include all source, destination, acquired, input, underlying, prerequisite, cleanup, wrapper, direct-call, and plugin-injected subjects.

Pending country detection, failed screening, missing metadata, unresolved vault type, missing underlying asset, unknown authority, or unavailable policy storage all fail closed.

### 5.9 Durable at-most-once execution

A durable reservation exists before the first signature, approval, grant, proposal, or transaction prompt. Any failure after the external boundary becomes unresolved until reconciliation unless structured evidence proves non-acceptance.

Artifact authority never depends on JavaScript object identity, module memory, component lifetime, or a TTL.

### 5.10 Context-scoped UI effects

Attempt outcome belongs to the immutable attempt. Cart clearing, modal closing, and redirects belong to the currently active UI context.

A completion from context A must mark attempt A correctly but must never clear or redirect context B. Success updates only the exact stable intent IDs and revisions captured by the ceremony; newer cart edits survive.

## 6. Target architecture

```text
Forms / batch cart
        | immutable OperationIntent DTOs
        v
Requirement collector ---> pinned PlanningSnapshot
        |
        v
Pure intent compilers ---> typed EffectGraph with stable IDs
        |
        +--- Policy engine ---> versioned PolicyEvidence
        +--- Materializer ----> transport-specific ExecutionTemplate
        +--- Simulator -------> SimulationCertificate
                                  |
                                  v
                           immutable SealedCeremony
                         /                           \
                        v                             v
          opaque operation review binding     SubmissionCoordinator
                        |                             |
                        v                     EOA / Safe adapters
        existing handcrafted Review UI               |
                                          IndexedDB journal + recovery
```

Centralized means one authority for ceremony creation and one authority for every signature/send. It does not mean another giant composable. Operation compilers remain small and pure.

Suggested structure:

```text
features/transaction-ceremony/
  domain/
    intents.ts
    effects.ts
    policy.ts
    simulation.ts
    template.ts
    ceremony.ts
    attempt.ts
  planning/
    requirements.ts
    snapshot-loader.ts
    compiler.ts
    compilers/
  materialization/
    prepared-plan.ts
    signature-slots.ts
    eoa-template.ts
    safe-template.ts
  policy/
    engine.ts
    evidence.ts
    validators/
  simulation/
    simulator.ts
    coverage.ts
  review/
    internal-manifest.ts
    binding.ts
    operation-adapters/
  submission/
    coordinator.ts
    state-machine.ts
    journal.ts
    wallet-lane.ts
    recovery.ts
    adapters/
      eoa.ts
      safe.ts
  testing/
    fixtures.ts
    model.ts
```

## 7. Core domain model

```ts
type OperationIntent =
  | DepositIntent
  | WithdrawIntent
  | BorrowIntent
  | RepayIntent
  | CollateralIntent
  | SwapIntent
  | RefinanceIntent
  | MigrationIntent
  | RewardClaimIntent
  | REULUnlockIntent

interface WalletBinding {
  chainId: number
  account: Address
  subAccounts: readonly Address[]
  connectorId: string
  connectorSessionId: string
  walletKind: 'eoa' | 'safe'
  safeAddress?: Address
  classificationVersion: string
}

interface EffectNode {
  effectId: Hash
  intentId: string
  intentRevision: number
  dependsOn: readonly Hash[]
  phase: 'prerequisite' | 'core' | 'cleanup'
  effect: TypedEffect
  provenance: EffectProvenance
}

interface SignatureSlot {
  slotId: Hash
  kind: 'permit2' | 'migration'
  signer: Address
  chainId: number
  typedData: TypedDataDefinition
  typedDataHash: Hash
  validUntil?: number
  insertionPoints: readonly SignatureInsertion[]
}

interface PythRefreshSlot {
  slotId: Hash
  kind: 'pyth-update'
  chainId: number
  target: Address
  selector: Hex
  requiredFeedIds: readonly Hex[]
  maxValue: bigint
  freshnessPolicy: PythFreshnessPolicy
  previewPayloadHash: Hash
  insertionPoint: DynamicCallInsertion
}

interface ExecutionTemplate {
  schemaVersion: number
  wallet: WalletBinding
  effects: readonly EffectNode[]
  requests: readonly EoaRequest[] | readonly SafeCall[]
  signatureSlots: readonly SignatureSlot[]
  pythRefreshSlots: readonly PythRefreshSlot[]
  constraints: readonly ExecutionConstraint[]
  policyEvidenceDigest: Hash
}

interface SealedCeremony {
  ceremonyId: Hash
  templateDigest: Hash
  consentDigest: Hash
  intents: readonly OperationIntent[]
  template: DeepReadonly<ExecutionTemplate>
  policyEvidence: DeepReadonly<PolicyEvidenceBundle>
  simulation: DeepReadonly<SimulationCertificate>
  internalManifest: DeepReadonly<CeremonyManifest>
  reviewBinding: DeepReadonly<OperationReviewBinding>
  validity: DeepReadonly<CeremonyValidity>
}
```

Rules:

- DTOs contain no callbacks, refs, providers, SDK account objects, mutable class instances, or functions.
- Runtime schema validation rejects unknown fields and unsupported effects.
- Canonical hashing uses a schema-versioned encoder, normalized addresses, explicit integer encodings, and ordered arrays. Do not use `JSON.stringify`, FNV hashes, `WeakMap`, or object identity.
- The executor accepts only a branded `FinalizedArtifact`; raw SDK plans are not executable through the V2 boundary.
- TOS and Keyring are typed on-chain effects, not wallet signature slots. Pyth is a typed dynamic call slot. Only Permit2 and migration authorizations use `SignatureSlot`.
- Do not add `FeeFlowIntent` or `LiquidationIntent` while those production Lite surfaces are absent. A later baseline that contains either must add it through the exhaustive inventory and all applicable gates.

Public API:

```ts
prepare(intents: readonly OperationIntent[]): Promise<SealedCeremony>
accept(ceremonyId: Hash, consentDigest: Hash): Promise<AttemptHandle>
resume(attemptId: string): Promise<AttemptHandle>
reconcile(attemptId: string): Promise<ReconciliationResult>
```

Review components continue to receive the operation-specific display props required by their current handcrafted presentation. A thin adapter also binds that presentation to an opaque ceremony ID and emits acceptance. Review components never receive an execution closure and cannot sign or submit.

## 8. Preparation pipeline

### 8.1 Eager preparation and cache adoption

The ceremony boundary centralizes authority, not latency. Lite continues to prepare eagerly while the user loads and edits a form:

- Form and account loaders warm vault/account snapshots, balances, allowances, policy inputs, and other operation dependencies.
- Quote flows fetch candidates, share one plugin prefetch across a quote sweep, prepare candidate plans, and estimate or simulate them in the background.
- ERC-20 storage-slot hints remain chain-scoped and reusable across form and batch paths. Form-load priming remains non-blocking.
- Pyth/Keyring plugin data, TOS inputs, and other expensive remote inputs may be prefetched before Add to batch or Review.
- The current whole-cart generation is compiled and simulated in the background after add, remove, reorder, or intent revision; preparation is not limited to isolated entry previews.

These results live in a preparation cache outside `BatchDraftEntry` and `SealedCeremony`. They are accelerators, not execution authority. Every cached record carries the applicable identity needed to prove reuse is safe: intent or intent-set hash, cart generation, owner, chain, relevant account/subaccount, connector/session where material, observed block and data-source versions, compiler/schema version, freshness/expiry metadata, and the digest of any compiled template.

`prepare()` is cache-first. It adopts matching prefetched inputs and an exact whole-cart background result before issuing new I/O, fetches only missing or stale dependencies, and reruns only invalidated stages. An unchanged cart may reuse its complete background simulation certificate when the cart generation, intent-set hash, normalized template digest, planning snapshot, policy versions, and freshness rules all match. Per-entry simulations are not composed into a full-batch claim.

Authoritative sealing still reconstructs or deep-validates the final effect graph, materialized requests, simulation mapping, internal manifest, review binding, and canonical digest. Raw page-owned plans, mutable SDK instances, and results without complete cache identity are never adopted. Cheap pure compilation and validation may run again; expensive account/RPC reads, slot discovery, quotes, plugin prefetch, gas work, and exact full-cart simulation should normally come from valid warmed caches.

Cache misses affect preparation latency, not correctness. Any late result for a superseded generation is discarded. Review remains unavailable until one current authoritative ceremony is sealed. Review-time Pyth data may come from the matching cache, but the bounded execution-time Pyth refresh remains mandatory.

### 8.2 Authoritative sealing pipeline

1. Snapshot every relevant form value into immutable intent DTOs.
2. Capture owner, chain, subaccounts, connector/session, wallet kind, Safe classification, approval preference, and draft generation before asynchronous work.
3. Have each intent declare required accounts, vaults, assets, balances, allowances, feeds, quotes, policy subjects, and bounded postconditions.
4. Assemble one generation-bound planning snapshot by adopting compatible prefetched data first and fetching only gaps or stale entries. Use a common block where possible. Cache keys include owner, chain, block, connector/session where relevant, and data-source version.
5. Reject every stale async completion before every publication, not merely at the final return.
6. Compile the entire intent set into one effect graph with stable intent/effect IDs.
7. Run semantic validators: no orphan approvals, no mixed accounts/chains, no unbounded cleanup, no expanded reward set, and no undisclosed native value.
8. Resolve policy evidence from the final graph.
9. Seal the raw pre-plugin plan, process plugins for the review snapshot, and seal the processed preview. Seal TOS and Keyring as static effects. Convert each Pyth update into a typed refresh slot whose target, selector, feed set, ordering, freshness rule, and maximum value are immutable while payload and exact fee may refresh.
10. Resolve approvals and every signature request, including Permit2 nonce and typed data, before review.
11. Materialize the exact EOA requests or complete Safe call vector.
12. Produce the classified simulation certificate from section 5.7. EVC state simulation, modeled authorizations, independent direct calls, and intentionally absent state projections remain distinct and map by `effectId`.
13. Generate an exhaustive internal ceremony manifest from the typed effects/template, and bind the current operation-specific presentation inputs to the ceremony without changing their visible projection or requiring a one-to-one effect mapping.
14. Generate calldata and Tenderly projections solely from that template.
15. Deep-validate, seal, and hash the ceremony.

No reviewed prerequisite or cleanup call may be omitted because live state changed. Changed prerequisite state invalidates the ceremony.

## 9. User-facing review compatibility contract

The transaction ceremony is an execution-authority refactor, not a review redesign. Preserve the current rendered review for every operation and batch variant exactly: fields, labels, values, grouping, ordering, abstractions, warnings, tooltips, explanatory copy, buttons, and operation-specific conditional behavior.

The current review is intentionally handcrafted for the operation. It may summarize, combine, omit, or present information differently from the underlying transaction plan or EVC batch. There is no requirement that visible rows correspond one-to-one with effects, calls, approvals, plugin items, or simulation coverage. The exhaustive effect graph, internal ceremony manifest, policy evidence, and simulation certificate remain internal safety artifacts.

Do not add generic effect rows or expose internal targets, selectors, plugin calls, coverage classes, template digests, cleanup metadata, or authorization machinery unless the current operation-specific review already shows that information in that form. Existing displayed approval/signature information remains exactly as it is; the centralized internal representation does not expand it.

Pyth is completely transparent to the user. Do not display its preview fee, maximum fee, payload hash, feed IDs, freshness policy, execution-time refresh, or failure mechanics in the review. Pyth bounds and refresh validation remain internal. A Pyth validation failure uses the existing transaction-preparation/error behavior rather than adding a Pyth-specific review surface.

Unknown or undecodable production effects still fail internal sealing. They do not cause the UI to synthesize a generic review row. Acceptance binds the existing presentation inputs, stable intent IDs/revisions, and ceremony ID to the sealed execution template; the presentation itself remains non-executable.

Before implementation changes, capture the rendered output and interactive states of every current operation-specific and batch review variant. Use those fixtures as a strict compatibility suite throughout migration. Any deliberate review-product change is separate work requiring explicit product approval and is outside this PR.

Document this invariant in Lite as part of the implementation:

- Add a **User-facing review compatibility** section to `docs/transaction-building.md` explaining the separation between the exhaustive internal ceremony and the intentionally non-one-to-one handcrafted review.
- Link that section from `docs/README.md` and from the transaction-safety section of the root `AGENTS.md` so future agents encounter it before changing transaction review code.
- Add concise comments at the operation-review binding/adapter boundary pointing to the document; do not scatter duplicate explanations across components.
- Keep the rendered-output compatibility suite as the machine-enforced form of the contract.

## 10. Batch and migration model

Batch entries are drafts, not executable objects:

```ts
interface BatchDraftEntry {
  intentId: string
  revision: number
  intent: OperationIntent
}
```

- The cart stores no raw plan, prepared plan, builder, prerequisite callback, or review metadata assembled by pages.
- Preparation caches are external to the cart and keyed by complete context, revision, generation, and content identity. They cannot make a draft executable.
- Add/remove/reorder changes the generation and invalidates any open ceremony.
- Background preparation continuously targets the complete current cart. Review adopts its exact matching inputs/results where valid, then recompiles or deep-validates the complete ordered cart against one base snapshot. This is not a cold-start requirement.
- Add-to-batch may display an optimistic draft row immediately, but Review stays disabled until the final ceremony is compiled and simulated.
- Simulation layers use stable `intentId`/`effectId` keys.
- Grants, the main migration, revocations, and cleanup are explicit ceremony phases.
- Cross-intent effects that cannot be bounded are rejected or split into newly reviewed ceremonies.
- Completion removes only the intent IDs and revisions captured by that attempt.

There is one ceremony service for direct and batch execution, not a batch-specific executor.

### Batch responsiveness contract

Every production form that exposes an **Add to batch** action is a separate performance acceptance case. Representative sampling is not allowed.

- Maintain a machine-checkable registry of every batch-capable form, including its route/setup, action locator, and expected batch-row identity. CI fails when a batch-capable form is absent from the registry.
- For a valid, enabled form, measure from entry into the trusted click handler to the first browser paint in which that form's new row is visible in the batch builder.
- The measured click-to-visible time must be **less than 100 ms on every registered form**. In the pinned production-build browser profile, run at least 20 warmed iterations per form and require both the per-form maximum and p95 to remain below 100 ms; retain the raw timings as a CI artifact.
- The click path performs only synchronous validation, creates a serializable `OperationIntent`, and appends the draft row. It does not wait for SDK planning, simulation, RPC, policy refresh, or plugin work.
- Form-load and form-edit prefetch remains active before the click. Account snapshots, quote data, plugin prefetch, and chain-scoped slot hints flow into the generation-bound preparation cache without blocking form input or Add to batch.
- Force those asynchronous dependencies to take longer than 100 ms in the browser test and prove that the draft row still appears within the budget. The row may show a non-authoritative `preparing` state, and Review remains disabled until authoritative compilation and simulation finish.
- Background preview results are generation-bound and may update only the matching `intentId` and revision. They never become execution authority and cannot repopulate a cleared or replaced cart.
- For an unchanged warmed cart, assert that opening Review adopts the matching account/snapshot data, slot hints, quote/plugin prefetch, and exact whole-cart simulation instead of repeating those requests. A changed identity must force the corresponding targeted refresh.

This latency contract governs visible acknowledgement of the add action. Final Review must authoritatively assemble, deep-validate, and seal the complete cart; it may adopt an exact current whole-cart compilation and simulation under the cache rules in section 8.1.

## 11. Policy evidence

Use discriminated evidence, never permissive booleans:

```ts
type EvidenceState =
  | { state: 'allowed'; version: string; observedAt: number; expiresAt?: number }
  | { state: 'blocked'; version: string; reason: string; observedAt: number }
  | { state: 'pending'; version: string }
  | { state: 'unavailable'; reason: string }
```

Evidence covers:

- Country/geo and VPN screening.
- Wallet/account screening.
- Vault chain, type, underlying, labels version, and canonical live authority.
- Unverified-vault acknowledgement scoped to the exact ceremony subject set.
- TOS document/message digest and `(chainId, account)` acceptance.
- Quote identity, provider, calldata digest, assets, amounts, spender, limits, and expiry.
- Pyth target, required feed set, preview payload digest/publish-time evidence, native-fee estimate and maximum, and freshness policy.
- Approval owner, token, spender, and amount.
- rEUL lock identity, amount bound, and remainder-loss policy.
- Deployment, compiler, and policy-source versions.

Policy evidence is internal. It does not add visible review fields or acknowledgements beyond those already present in each operation-specific review.

The policy engine lives at application scope. It does not retain component callbacks whose state can freeze after unmount.

Ceremony validity, policy evidence, wallet connector/session, classification, and draft revision are checked after every relevant await and immediately before every signature or send. A failure before dispatch is recorded as safely not submitted; any failure after dispatch becomes unresolved until reconciliation.

After an irreversible boundary, later policy drift must not discard an observed external identifier or rewrite the attempt as not submitted.

## 12. Submission coordinator and journal

State machine:

```text
accepted
  -> reserved
  -> revalidating
  -> signing(slot N)
  -> finalized
  -> dispatching(step N)
  -> identified(external ID)
  -> confirming
  -> succeeded

Other states:
  safely-rejected-before-dispatch
  reverted
  cancelled-proven
  expired
  cleanup-required
  recovery-required
```

Rules:

- IndexedDB is authoritative. Store ceremonies, attempts, attempt events, wallet lanes, external artifacts, and cleanup obligations.
- Every transition uses a short read-write transaction with compare-and-swap on `{attemptId, version, fence}`.
- `navigator.locks` coordinates active work; durable lane state remains the safety boundary after tab death.
- `BroadcastChannel` is notification-only.
- Start with one live wallet lane per `{account, chain}` across all in-scope surfaces.
- Persist `reserved` before the first wallet interaction.
- Persist `dispatching` before opening each wallet prompt.
- Read the reservation back immediately and verify reservation ID, ceremony digest, owner, chain, lane, version, and complete request/call-vector digest. A missing, malformed, dropped, or unreadable write fails closed.
- External identifiers are monotonic facts: once observed, they are never removed by a failed later write or context change.
- A timeout, provider disconnect, malformed response, or absent hash after dispatch does not enable retry.
- Clear an attempt only after provable pre-dispatch rejection/cancellation or terminal reconciliation.
- Persist cleanup obligations before executing their corresponding grants.
- A new attempt after revert, cancellation, expiry, or partial execution requires a new ceremony.
- There is no `localStorage` lock, TTL lease, realm-local active set, memory fallback, or manually dismissible ambiguous record.

The recovery UI is mounted at application root and survives navigation. Disabling new execution never disables reconciliation.

## 13. Transport adapters

### EOA

- Accept only finalized requests with exact `from`, `chain`, `to`, `data`, and `value`.
- Reassert the complete wallet binding before every signature and send.
- Persist dispatching state before `eth_sendTransaction`.
- Store a returned hash immediately.
- Fetch the submitted transaction and compare its normalized semantic digest to the accepted request.
- For a lost response, use sender, expected nonce context, start block, and request digest; never retry while acceptance remains possible.

### Safe/EIP-5792

- Classification must be resolved before sealing. Unresolved classification blocks review.
- Persist the complete call-vector digest, including prerequisite and cleanup wrappers.
- Persist the reservation before `wallet_sendCalls` and verify it by reading it back.
- Store calls ID and execution hash monotonically.
- Fetch and compare the proposed/executed call vector with the accepted template.
- Status `400` may prove off-chain cancellation.
- For `500/600`, retain any execution hash and resolve its public receipt before classifying. A mined revert is an executed attempt; without a conclusive receipt, the state remains unknown.
- Provider loss cannot fall back to EOA or sequential execution.
- A Safe completion always updates its attempt, but cart cleanup and redirect occur only if the captured UI context is still active.

## 14. Internal implementation stages inside the single PR

These are commit/review checkpoints, not separate PRs.

### Stage A - Contract, inventory, and adversarial tests

- Add the architecture contract and schemas.
- Inventory every current planner, review entry point, signature call, transaction send, Safe call, batch builder, direct call, and migration prerequisite.
- Add CI rules forbidding new in-scope wallet writes outside adapters.
- Import/rewrite discriminating tests from the retained Apex findings and PR failure histories.
- Add a requirements ledger for every operation present on the starting `development` head.
- Inventory every current eager-preparation producer, cache key, invalidation rule, and form-to-batch consumer so the migration preserves account, quote, plugin, slot-hint, gas, and simulation reuse.
- Inventory every operation-specific and batch review variant, capture its rendered fields/values/grouping/conditional states, and establish the strict pre-refactor compatibility fixtures required by section 9.
- Pin and verify the published SDK release prerequisite, including its public simulation/plugin documentation and JSDoc links. Record FeeFlow buy and liquidation execution as absent Lite rows unless the rebased baseline proves otherwise.
- Build the exhaustive batch-form performance registry and capture a click-to-visible baseline for every registered form before migration.

Exit: every operation and irreversible boundary has an owner and migration row, and every batch-capable form has an owned performance case.

### Stage B - Domain kernel and deterministic materializer

- Implement intents, effect graph, stable IDs, canonical encoding/digests, runtime schemas, typed signature slots, bounded Pyth refresh slots, the plugin structural verifier, semantic validators, and the Lite materializer over public SDK APIs.
- Prove finalization changes only declared signature, Pyth-refresh, and transport slots.

Exit: every supported operation can produce a deterministic sealed template without wallet interaction.

### Stage C - Snapshot, policy, simulation, and review binding

- Implement eager, generation-bound preparation; context-complete cache identities; cache-first snapshot loading; exact whole-cart result adoption; app-scoped policy evidence; classified simulation coverage; internal manifest generation; calldata/Tenderly projection; and opaque adapters that bind the unchanged operation-specific review components to ceremonies.
- Add the direct-only simulation adapter: accept SDK-declared `independent` only when there is no EVC batch or earlier-effect dependency, beginning with Turtle; preserve empty account/vault projections; keep calldata and Tenderly available independently of state simulation.
- Add the durable documentation and links required by section 9, including the root `AGENTS.md` invariant.
- Run V2 in test/dev shadow comparison against current `development` flows while the PR remains draft.

Exit: the internal simulation certificate, manifest, export, and materialized template share one normalized template digest; every coverage class is recorded internally; and the complete rendered review compatibility suite is unchanged.

### Stage D - Journal, coordinator, and recovery

- Implement IndexedDB schema/migrations, fenced wallet lanes, state machine, bounded execution-time Pyth plugin rerun/finalization, failure injection, root recovery UI, and EOA/Safe reconciliation.

Exit: no wallet interaction is reachable before a verified durable reservation.

### Stage E - Migrate all in-scope operations

- Migrate simple direct operations first inside the branch, followed by swaps, rewards/rEUL, multiply/refinance, batch, and migrations. Do not invent FeeFlow or liquidation Lite callers for absent inventory rows.
- Each page becomes an intent factory and ceremony launcher only.
- Port every inventoried `development` operation through the same API.
- Keep Add-to-batch synchronous: append the serializable intent immediately and run planning/simulation as generation-bound background work. A form is not migration-complete until its own click-to-visible gate passes.
- Preserve form-load and form-edit warming for accounts, quotes, plugin data, slot hints, gas, and simulations. Route those results into the centralized preparation cache rather than page-owned execution state.
- Preserve each page's existing operation-specific review inputs and visible output through the review-binding adapter. Migration is incomplete if any rendered review fixture changes.

Exit: the inventory reports no in-scope legacy caller.

### Stage F - Delete the legacy lifecycle

Remove or make unreachable for in-scope flows:

- Public raw `executePlan` and `executePreparedPlan` entry points.
- Plain transaction helpers callable from pages.
- Modal preparation and `onConfirm` execution callbacks.
- Batch executable closures and `lastMerged` authority.
- Page-owned migration execution ceremonies.
- Per-page retry/recovery state.
- Heuristic reviewed-plan comparators and signature-byte scanners.

Exit: only the coordinator/adapters can sign or send.

### Stage G - Full validation and code freeze

- Run build, lint, typecheck, full Vitest, golden fixtures, parity tests, fork execution tests, model tests, and real browser multi-context tests.
- Run the exhaustive production-build batch-form performance matrix and archive per-form raw, maximum, and p95 click-to-visible timings.
- Run `git diff --check`, conflict-marker scan, dependency/supply-chain review, and the send/sign inventory.
- Verify the installed SDK is the pinned published package rather than a local symlink, rerun the SDK conformance tests, and verify its simulation/plugin docs still describe the behavior this plan relies on.
- Freeze an exact candidate SHA.

Exit: all automated gates pass on one clean exact head.

### Stage H - Fresh-agent review gate

Do not mark the PR ready for human review until this gate completes.

1. Freeze the candidate SHA and give every reviewer the exact SHA and `development` base.
2. Spawn fresh read-only agents with no implementation conversation history:
   - one using `review-stack` for Vue/Nuxt/TypeScript architecture and lifecycle correctness;
   - one using `review-business` for Euler operation semantics, bounded effects, policy subjects, and user-visible accuracy;
   - one using `review-security` for signing, wallet binding, replay, storage, cross-tab, and transaction integrity;
   - after those lanes finish, one using `review-pr` for a full surface pass and deep caller/callee trace of every modified symbol.
3. Require findings to name exact files/lines, reachable call chains, severity, and a discriminating reproduction/test. Agents remain read-only and do not post to GitHub.
4. Independently validate every finding against the exact head. Fix confirmed issues as a cohesive batch; reject invalid findings with evidence.
5. Run the complete automated suite again.
6. Because fixes create a new SHA, discard prior sign-off and repeat with new fresh agents.
7. After the independent review lanes are clean, run a separate explicit challenge pass against the trap matrix in section 16.
8. Mark the PR ready only when all lanes and the challenge pass are clean on the same exact head.

Historical approvals, aggregate PR badges, and a queued/incomplete agent run do not count as exact-head sign-off.

## 15. Test program

### Structural/property tests

- Canonical digest is deterministic and schema-versioned.
- Finalization changes only declared signature, Pyth-refresh, and wallet transport slots.
- Every executable effect is represented in the internal ceremony manifest or rejected. Visible review output is intentionally not required to map one-to-one to effects.
- Every executable effect has an explicit simulation coverage class; no partial result is represented as full-plan state simulation.
- EVC simulation includes the preview plugin calls and maps operation layers by stable `effectId`/operation ID.
- Approvals and Permit2/migration authorizations are recorded as modeled assumptions, not fabricated simulated transactions.
- A direct-only Turtle plan uses `simulationMode: 'independent'`, propagates call failure, and returns no simulated account/vault state on success.
- Direct-call calldata and Tenderly projection remain available when Euler state arrays are empty or the allowlisted reward call is intentionally not state-simulated.
- Mixed unsimulated direct-call/EVC plans fail closed.
- Submitted normalized EOA/Safe artifacts equal the accepted template after only declared slot normalization.
- No functions, refs, unknown fields, or mutable SDK objects enter a ceremony.
- Policy subject extraction includes direct calls, approvals, wrappers, prerequisites, cleanup, and plugin effects.
- Matching prefetched inputs and an exact whole-cart background result can be adopted only when every cache identity and freshness field matches; any owner, chain, account, session, generation, intent, block/data version, compiler version, policy version, or digest mismatch rejects reuse.
- Individual entry simulations cannot be composed into a full-cart certificate. Only an exact whole-cart simulation keyed to the sealed template may be reused.
- Execution-time plugin processing receives only the sealed raw pre-plugin plan and configuration. Structural comparison rejects every difference except a declared Pyth payload and bounded fee change.
- Added, removed, reordered, retargeted, or modified TOS, Keyring, or other static plugin effects invalidate the ceremony before a wallet request.

### User-facing review compatibility tests

- Exercise every current operation-specific review and batch-review variant against the pre-refactor fixtures, including conditional fields, expanded/collapsed states, warnings, tooltips, action labels, and display-only/read-only modes.
- Require identical rendered labels, values, grouping, ordering, visibility, and interaction states after migration. Do not regenerate fixtures merely because the ceremony internals changed.
- Prove the internal effect graph may contain more or differently grouped effects than the visible review without leaking generic rows or internal metadata into the UI.
- Prove Pyth fee, maximum, feed IDs, payload/freshness data, and refresh behavior never appear in the review UI.
- Prove each unchanged operation-specific presentation is bound to the exact intent IDs/revisions and ceremony accepted by the user, while remaining unable to sign or submit directly.

### Every-form batch responsiveness tests

- Discover the complete batch-capable form registry and fail if any production Add-to-batch form has no case; do not test only representative forms.
- Exercise every registered form in a production build with valid form state and the real batch-builder DOM.
- Mark the trusted click-handler entry, then observe the first painted frame containing the matching `intentId` row.
- Run at least 20 warmed clicks per form on the pinned browser/runner profile. Require every recorded click, each per-form maximum, and each per-form p95 to be below 100 ms.
- Repeat with planner, simulator, RPC, policy, and plugin dependencies delayed beyond 100 ms. Visible insertion must stay below 100 ms while Review remains unavailable until authoritative preparation completes.
- Verify clear, reorder, account/chain changes, and a second click during background preparation cannot publish a stale row or give the optimistic row execution authority.

### Eager-preparation and cache-adoption tests

- Prove form-load and form-edit warming remains non-blocking and populates the centralized cache for accounts, quotes, plugin data, slot hints, gas inputs, and simulation inputs.
- For every migrated form family, prove an unchanged warmed intent/cart avoids redundant account refetch, slot-hint discovery, quote/plugin prefetch, and exact whole-cart simulation when their recorded freshness contracts permit reuse.
- Prove a cache miss fetches only the missing dependency and a single stale identity dimension invalidates the affected stage without discarding unrelated valid data.
- Prove late results cannot populate the active generation after edit, remove, reorder, clear, account/chain switch, connector/session change, or compiler/schema change.
- Prove cached prepared SDK objects, page-owned plan objects, and per-entry simulation results are rejected as ceremony authority.

### Async and model-based tests

Inject failure or context change before and after every await and journal transition:

- Account, chain, connector/session, Safe classification, approval preference, and batch revision changes.
- Overlapping review A/review B completion ordering.
- Async batch add and resimulation completing after clear/context reset.
- Policy and evidence version changes.
- Pyth refresh success/failure, expiry, target change, payload refresh, feed-set change, fee change within the bound, and fee above the bound. Only a fresh payload and bounded fee may finalize without a new review.
- Permit2 nonce change.
- Storage unavailable, malformed, dropped write, failed read, and failed upgrade.
- Wallet acceptance followed by lost response.
- Success after the user navigates or edits a new cart.

### Real browser concurrency tests

Use separate Playwright browser contexts/tabs, not separate module graphs in one event loop:

- Two tabs contend for the same wallet lane.
- First tab is suspended during a wallet prompt.
- First tab closes before or after dispatch.
- Reload with reserved, dispatching, identified, and confirming attempts.
- A stale tab attempts to overwrite or clear another tab's reservation.
- Recovery ownership changes while the old tab resumes.

### Safe tests

- Classification unresolved, EOA, and Safe transitions before review and at every await.
- Late classification cannot replace Permit2 with approval calls.
- Single-call and bundled paths share the same durable lifecycle.
- Provider loss cannot fall back.
- Lost/malformed calls ID remains unresolved.
- `400`, `500`, `600`, execution hash present/absent, successful receipt, mined revert, and timeout.
- Complete proposed/executed call vector matches the ceremony digest.
- Completion from context A does not clear context B.

### Domain regressions

- rEUL claim/unlock amount and remainder-loss policy.
- Selected-only reward claims and exact Fuul fees.
- Turtle direct-only independent simulation with empty Euler state projection, exact calldata, and a Tenderly link.
- Approval token/spender/amount and unlimited sentinel.
- Migration share bounds, canonical account, prerequisites, and cleanup.
- SDK conformance for the full violator feed set, absent liquidation approval, and disabled unsafe FeeFlow buy planning; no absent Lite execution route is created.
- All hard-blocked inputs/touched vaults and soft-restricted acquired exposure.
- Changed final vault set requires a fresh acknowledgement.

## 16. Trap audit: proof that the new design avoids prior failures

| Historical trap | Source | Structural prevention | Required proof |
| --- | --- | --- | --- |
| Display, simulation, calldata, and execution use different plans | #810, #782 | One sealed template and one normalized digest; review takes only ceremony data | Digest equality tests across every projection and submitted artifact after declared slot normalization |
| Confirm callback rebuilds from reactive form state | #810, #782 | Pages create intents only; planner imports forbidden after seal | Overlapping reviews where A confirms after B prepares still execute A |
| Batch simulation uses add-time plans while execution authority rebuilds | #810 | Whole cart compiled and simulated as one authoritative ceremony | Add-time preview differs from final graph; only the final graph is executable, while the unchanged handcrafted review remains bound to the final intent set |
| `Object.freeze` wraps closures and mutable objects | #810 | Serializable runtime schema and deep validation reject functions/refs/classes | Construction fails for closures, Vue refs, SDK accounts, and unknown fields |
| Signature parity scans placeholder bytes | #810, #782, #784 | ABI-aware typed slots with signer/hash/path | Repeated placeholders, transposition, selector collision, and unrelated 65-byte data all fail |
| Pyth refresh becomes an unrestricted post-review replan | #782, #784, LITE-280, LITE-289, LITE-292 | Typed slot seals official target, selector, feed set, ordering, freshness, and max value; only payload and bounded fee refresh | Fresh payload succeeds; unknown target, selector/order/feed change, stale data, plugin failure, or excess fee blocks before wallet interaction |
| Direct-call-only simulation returns no Euler state and is mistaken for failure or full state coverage | LITE-281 | Coverage is independent from export; SDK-declared independent mode is limited to direct-only pre-state-safe calls, beginning with Turtle | Turtle success has `canExecute: true`, empty account/vault arrays, exact calldata, and Tenderly; revert propagates; mixed unsimulated plan is rejected |
| Wallet/account/chain binding is optional | #810, #782 | Binding required by schema and reasserted before every signature/send | Change each binding field at every await; no wallet call occurs |
| Safe classification resolves late and rewrites approval mode | #782, #784 | Classification/approval mode resolved before seal; drift invalidates | Unresolved-to-Safe and Permit2-to-approval transitions require new review |
| Reviewed Safe silently falls back to EOA/sequential execution | #782, #784 | Transport-specific branded template and adapter; no fallback return type | Provider loss fails closed with no alternate wallet write |
| Policy covers only page-primary vaults | #781 | Subjects derived from complete effect graph | Blocked destination/input/underlying/prerequisite/plugin subject prevents review |
| Policy callback outlives component but its state freezes | #783 | App-scoped evidence with direct expiry/version evaluation | Unmount, advance time/switch wallet, then sign/send remains blocked |
| Policy asserted only before the terminal batch, not prerequisites | #783 | Coordinator validates before every irreversible step | Flip policy during prerequisite build; no grant is sent |
| Module-global latch from ceremony A overwrites B | #810, #784 | Ceremony is instance-owned by ID; no module-global execution authority | A prepares, cart clears/B prepares, A finishes last; B remains authoritative |
| Shared modal refs let review A execute plan B | #782, #784 | Modal captures immutable ceremony ID/digest | Two overlapping direct-operation reviews execute their own exact artifacts |
| Stale async batch add/resimulation republishes old owner state | #810, #784 | Context-keyed caches and generation checks before every publication | Deferred A result after reset cannot enter B snapshot/cart |
| Reservation starts only before final value send | #810, #782 | Reserve before first signature, approval, grant, or proposal | Failure after each earlier boundary remains durably unresolved/cleanup-required |
| `localStorage` TTL mutex or realm-local active set | #810, #782 | IndexedDB CAS/fence plus Web Locks; no TTL/manual release | Real-tab contention, suspension, reload, and tab-death tests |
| Another tab overwrites an existing reservation | #782 | Atomic compare-and-claim lane ownership | Interleaving acquisition permits exactly one owner |
| Malformed/unreadable/dropped storage means no lock | #782, #784 | Fail closed and write-read identity verification | Malformed JSON, thrown reads, and silently dropped writes block wallet interaction |
| Lost wallet response clears reservation | #810, #782, #784 | Dispatching is persisted first; ambiguous state is monotonic | Provider disconnect/missing ID cannot enable retry |
| External ID is stored only after later work succeeds | #810, #784 | Persist every observed ID immediately and never erase it | Later storage/policy/UI failure preserves ID and recovery state |
| Safe success/failure is classified from status code before receipt | #784, #810 | Resolve execution hash and public receipt first | `500/600` with mined revert is executed/reverted; no hash remains unknown |
| Recovery proves something landed, not the reviewed request | #810 | Fetch EOA/Safe artifact and compare normalized digest | Mismatched target/data/value/call vector cannot be marked successful |
| Completion from old context clears new cart or misreports success | #782, #784 | Attempt attribution separated from active UI effects; stable revisions | A completes after B starts: A marked correctly, B preserved, no stale redirect |
| Fix applied to one route/sibling but another bypasses it | #810, #784 | Exhaustive intent union, central coordinator, forbidden-import inventory | CI fails for any new or remaining in-scope direct send/sign caller |

## 17. Relevant lessons from PRs #781-#784

### PR #781 - policy scope

Preserve:

- Unknown country and missing metadata fail closed.
- Policy includes source, destination, acquired, input, underlying, and distinct multiply/refinance/migration subjects.
- Hard blocks and acquired-exposure restrictions are modeled explicitly.
- Unverified acknowledgement binds to account, chain, final subject set, and ceremony digest.

Do not port page-by-page guards or copied policy metadata. The final effect graph is the only policy-subject source.

### PR #782 - exact artifact and retry safety

Preserve:

- Exact approval token/spender/amount, native value, rEUL bounds, wallet binding, typed signature tests, prerequisite/cleanup coverage, Safe ambiguous-response tests, atomic cross-tab reservation, and preservation of later cart edits.

Do not port modal callbacks, object-identity authorization, heuristic equality, Pyth wildcarding, optional lifecycle callbacks, or Safe-only persistence.

### PR #783 - policy freshness

Preserve:

- TOS/account/chain versioning, positive VPN result preservation, canonical authority verification, pending geo blocking, stale async rejection, direct expiry evaluation, and policy assertions at every irreversible boundary.

Improve on it by owning evidence at application scope instead of retaining callbacks whose component-scoped state can stop updating.

### PR #784 - execution context and Safe durability

Preserve:

- Chain-aware registries, prepared-context invalidation, durable Safe recovery, ambiguous submission retention, execution-hash receipt resolution, context-safe UI cleanup, and TOS/plugin fingerprints.

The current exact head still demonstrates why the clean boundary is required: reviewers found stale global latch publication, incomplete Pyth trust handling, a missed sibling route, unresolved-to-Safe ceremony drift, unverified durable writes, and stale resimulation publication. Each maps to a structural rule and test in section 16.

## 18. Definition of done

- One PR contains the complete in-scope implementation and legacy deletion.
- Every in-scope form/page creates intents only.
- Every in-scope direct and batch operation uses the same ceremony service.
- Only the coordinator/adapters can sign or submit; CI enforces the boundary with a narrow frozen allowlist for excluded legacy workflow files.
- No review modal receives an execution callback or any authority to sign or submit. It may continue to receive frozen operation-specific display inputs needed to reproduce the current handcrafted output.
- No batch entry or ceremony contains executable functions or mutable reactive state.
- Wallet kind, Safe classification, connector/session, approval mode, policy evidence, static transport fields, signature slots, and bounded Pyth-refresh slots are sealed before review.
- Execution-time plugin processing receives only the sealed raw plan/configuration, and Lite accepts only the declared fresh Pyth payload and bounded fee difference.
- Simulation certificates, the internal ceremony manifest, export, Tenderly, and normalized submission share one template digest. Internal metadata identifies each literal Pyth preview payload; the user-facing review remains unchanged and intentionally need not map one-to-one to that template.
- Every irreversible boundary has a verified durable reservation.
- Unknown acceptance cannot be dismissed or retried.
- EOA and Safe reconciliation verifies the actual submitted artifact.
- Every applicable Apex item in the section 4 reconciliation has a direct Lite test, an SDK release-conformance test, a revised requirement test, or an explicit canceled/absent disposition.
- All relevant #810 and #781-#784 traps have discriminating regressions.
- Every operation-specific and batch review passes the strict pre-refactor rendered-output compatibility suite, with no new generic ceremony fields and no visible Pyth data or refresh notice.
- `docs/transaction-building.md`, `docs/README.md`, root `AGENTS.md`, and the central review-binding comment document and link the user-facing review compatibility contract.
- Every production form with Add to batch is present in the performance registry and passes the exhaustive less-than-100-ms click-to-visible gate; no representative sampling or missing-form waiver is permitted.
- Eager form preparation and exact whole-cart background preparation remain active, use context-complete cache identities, and are adopted by Review without redundant expensive work when unchanged and fresh.
- Full build, lint, typecheck, Vitest, golden, parity, fork execution, model, failure-injection, and real multi-tab tests pass.
- Fresh stack, business, security, and deep call-stack review agents report no blocking findings on the same exact head.
- Any review-driven fix is followed by a full rerun with new fresh agents.
- Only then is the single PR marked ready for human review and merge.
