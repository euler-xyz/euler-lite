# Euler Lite Centralized Reviewed Execution

## One-PR implementation plan

Status: revised proposal

Target repository: `/Users/dariusz/Euler/euler-lite`

Target base: `origin/development`

Verified baseline: `cc4fbd342240efc2622e6342e101e5c1951b4139`
Evidence refreshed: 2026-08-20

## 1. Objective

Reimplement the in-scope transaction lifecycle from scratch so that:

> The user accepts the digest of one immutable, wallet-bound reviewed request set, and execution submits exactly that request set.

Execution may fill only signature slots declared before review, the bounded Pyth refresh slots described in section 5.5, and wallet-owned transport fields such as gas and fee parameters. It may not rebuild an operation plan, adopt unrestricted output from a rerun plugin pipeline, change approval mode, reclassify the wallet, change any static calldata or value, or read reactive form state after acceptance.

Between review acceptance and the wallet request, Lite must preserve the meaning of the accepted operation. The active submission process synchronously blocks duplicate confirmation within that process. The user's wallet approval/signature is the canonical submission boundary: Lite never submits automatically or retries without another explicit wallet approval.

This refactor ends at that handoff boundary. After a reviewed request is handed to the wallet, preserve the established `development` behavior: SDK-owned EOA receipt sequencing and the current-session Safe detachment/status flow continue unchanged. In particular, a submitted Safe may remain tracked while awaiting co-signers, the review modal may detach from that work, and the existing tracked-execution UI gate and context-scoped completion toasts remain in force.

The preserved post-handoff behavior is the baseline behavior that predates this plan. It does not include the branch-added IndexedDB attempt journal, wallet lanes/fencing, cross-tab reservations, missing-transaction searches, cleanup obligations, recovery/reconciliation services, or reload resumption. A reload restores none of those reviewed-execution records and prepares any later operation from fresh state.

### 1.1 Domain vocabulary

The architecture has two consent-bearing lifecycle concepts:

- `OperationIntent`: the immutable user operation to compile and review.
- `ReviewedExecution`: the immutable, wallet-bound result accepted by the user. It owns the request set, policy result, simulation result, effect mapping, review binding, validity, and plugin snapshot.
- `SubmissionResult`: the non-persistent current-invocation outcome returned after the established EOA or Safe flow terminates.

Everything else is an internal field or mechanism, not a peer domain entity. Planning snapshots, request sets, effects, policies, simulations, bindings, signature and Pyth slots, plugin snapshots, finalized requests, and preview-cache records exist only to prepare, verify, or submit a `ReviewedExecution`. A preview plan is form-time work used to warm that cache; it is never execution authority.

## 2. Scope

Included:

- Direct EOA transaction-plan execution.
- Safe/EIP-5792 execution.
- Single operations and batches.
- Approvals and Permit2 signatures.
- Direct contract calls and EVC batches.
- Plugin-injected effects, including TOS, Keyring, and Pyth.
- Rewards, rEUL, swaps, and multiply/refinance flows.
- Inbound and outbound migrations, including authorization prerequisites and normal post-migration revocation/restoration steps.
- Policy checks, review rendering, simulation, submission, and current-session status reporting for those flows.

The starting `development` inventory has no production FeeFlow buy caller and no liquidation execution caller. Record both as explicit absent rows and do not create unused Lite intents or UI routes for them. If either surface appears on the rebased implementation baseline, it enters scope through the same inventory gate; until then, FeeFlow and liquidation behavior is an SDK release-contract concern only.

Excluded:

- Off-chain solver-order workflows. Their existing implementation remains unchanged and outside the guarantees in this document.

The completion claim is therefore:

> Every in-scope Euler transaction-plan operation uses the same reviewed execution and submission-coordinator boundary.

It is not an application-wide claim about excluded workflows.

## 3. Delivery model: one implementation PR

This work is delivered as one Euler Lite PR, not a chain of implementation PRs.

- Create one persistent clean worktree and branch from the verified `origin/development` lineage, for example `refactor/reviewed-execution-v2`.
- Open one draft PR against `development`.
- Use coherent, buildable commits for the internal stages below, but do not create a PR per stage.
- Keep the PR draft until the complete transaction inventory has migrated, legacy in-scope entry points have been removed, all tests pass, and the fresh-agent review gate is clean.
- Do not cherry-pick or merge PR #810 or PRs #781-#784. Extract their retained requirements, adversarial scenarios, and discriminating tests only, then implement them through the new intent/compiler boundary.
- Treat current `development` as the behavior and operation-surface baseline, not as the architecture template. Replace its in-scope transaction orchestration behind the new boundary instead of preserving it internally.
- At kickoff and again before code freeze, compare `master...development` and account for applicable production hotfixes. Keep unrelated branch synchronization out of this PR; rebase onto the maintainer-synchronized `development` head instead.
- Do not merge a partially safe implementation behind a public per-flow rollout. The PR is merged only when every in-scope production path is behind the coordinator.

### SDK release prerequisite

This plan depends on a published SDK release containing the capabilities covered by SDK PRs #89, #90, #91, and #96. The inspected source heads are `03b4af68d1b1e2bc3a2f1f65e2da4f259308b115`, `fc2a4fb319e661558fde1cb52a3a2a0e04999ab9`, `cc9f17ee37eb5c8d58264dbc084e655e2839ddf7`, and `98167211c6767eb07e9c1f77a474abe7a0b23c95`, respectively. The published release, rather than a local symlink or those branch SHAs, is the implementation dependency.

At kickoff, pin the published version and prove with targeted integration tests that it provides:

- Fail-closed required-plugin processing, complete liquidation Pyth feed discovery, selected-only Fuul claims, and chain-safe reward/plugin data.
- Stable reward/Pyth operation boundaries and the planner invariants for swap tokens, debt-swap accounts, migration sweeps, and liquidation approvals.
- Migration planning preserves normal authorization removal: signature-capable flows may use `removeAuthorizationAfterMigration`, and transaction-form requests retain their SDK-provided revocations. A fresh attempt treats an already sufficient live authorization as satisfied and never blocks on a revocation that failed or was not completed by an earlier attempt.
- FeeFlow buy execution disabled until an atomic minimum-payout contract exists.
- `ContractCall.simulationMode: 'independent'` with direct-call failure propagation and an empty Euler account/vault state projection for a successful direct-only call; Turtle claim plans opt into it.
- Deterministic `materializeExecution` with explicit EVC and Permit2 inputs, pure `finalizeMaterializedExecution` that returns a new immutable request vector, and `executeMaterialized` that dispatches an already-finalized EOA vector byte-for-byte through awaited boundary hooks without replanning or re-encoding.
- Public migration-authorization slot preparation and ABI-aware signature insertion, plus feed-aligned Pyth publish-time evidence needed to verify Lite's typed migration and Pyth slots.

The SDK documentation must state the simulation contract in section 5.7: approvals and migration authorization are modeled rather than executed, EVC effects are state-simulated, independent direct calls produce no Euler state projection, and Pyth data is normally refreshed at execution. Link that document from the public comments for `simulateTransactionPlan`, `simulatePreparedTransactionPlan`, the prepare/execute methods, `materializeExecution`, `finalizeMaterializedExecution`, `executeMaterialized`, and `ContractCall.simulationMode` so callers do not infer full sequential simulation or hidden request recomposition from the method names.

Use only that release's public planners, plugin processor, decoders, simulation APIs, typed-data builders, materialization/finalization APIs, and encoders. The SDK owns deterministic base transaction-plan materialization, Permit2 finalization, and EOA request dispatch. Lite supplies the explicit reviewed EVC and Permit2 inputs, invokes `materializeExecution`, seals its immutable output inside the reviewed request set, and rejects any request-byte, Safe-call, signature-slot, or insertion-coordinate disagreement with Lite's richer effect projection.

Lite may finalize only the declared typed differences: Permit2 through `finalizeMaterializedExecution`, migration signatures through the SDK's reviewed ABI-slot encoder, and Pyth through the bounded structural verifier in section 5.5. Each operation produces a new finalized vector; the SDK materialization accepted at review remains unchanged.

After acceptance, the generic `executeTransactionPlan` and `executePreparedTransactionPlan` paths are unreachable. The EOA adapter passes either the reviewed static pre-Pyth prefix or the already-finalized exact suffix/vector to `executeMaterialized`. Its awaited hooks reassert Lite's active invocation guard, wallet binding, and byte equality before every wallet prompt except the first JIT Pyth-bearing suffix request, whose wallet/policy checks deliberately run immediately before refresh so no awaited external check follows finalization. The SDK does not run planners, plugins, approval resolution, or calldata composition on this path. The Safe adapter submits the complete finalized envelope derived from the same SDK vector through one `wallet_sendCalls` request.

If the published release lacks any assumed behavior or a required operation cannot be materialized and dispatched using these public APIs, stop and surface that as a design blocker. Do not add a Lite reimplementation of SDK materialization or EOA execution, restore a raw-plan fallback, copy private SDK internals, or silently weaken the coverage or equality contracts.

### Why `development`, not `master`

At the evidence snapshot above, GitHub identifies `development` as the default branch. It is 149 commits ahead of and 15 commits behind `master`, and 23 of 24 open PRs target it. More importantly, it contains the current Safe, migration, batch, plugin, and transaction-finalization surfaces and their regression tests. Building from `master` would require rediscovering or later rebasing across those surfaces, recreating the cross-route omissions that prolonged the earlier reviews.

The meaningful `master`-only changes in this snapshot are production maintenance changes rather than an alternate transaction architecture. They must still be reconciled through the normal branch-sync process. Starting from `development` does not authorize copying PR #810 or PRs #781-#784; “from scratch” refers to the reviewed execution/coordinator architecture.

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
| [#782](https://github.com/euler-xyz/euler-lite/pull/782) | `4f395047f45bc9719da71e0a44d29480c2a08147` | Open; current head has no exact-head approval | Review/execution and signature-integrity tests |
| [#783](https://github.com/euler-xyz/euler-lite/pull/783) | `bf99e3c64ad981059453fd7b8380d7970fe4cace` | Exact-head approved | Policy freshness and lifecycle requirements |
| [#784](https://github.com/euler-xyz/euler-lite/pull/784) | `6d2f798a5059a8b3e3422e62bbfbc8a6a436661d` | Exact-head changes requested | Safe context and stale-publication tests |

### Apex requirement reconciliation under the assumed SDK release

The live Linear set contains 44 Apex tickets: 26 Backlog and 18 Canceled. Their status is evidence, not an instruction to reproduce stale remediation. Apply this disposition at implementation kickoff and recheck it against the pinned SDK release:

| Disposition | Linear tickets | Plan treatment |
| --- | --- | --- |
| Retained Lite requirements | LITE-278, LITE-282, LITE-284, LITE-285, LITE-287, LITE-288, LITE-293, LITE-294, LITE-295, LITE-298, LITE-299, LITE-300, LITE-308, LITE-310, LITE-319, LITE-321 | Still valid as Lite behavior and integration work. Preserve protections already present on `development` and implement the missing centralized guarantees. |
| Valid findings satisfied by the assumed SDK release | LITE-281, LITE-283, LITE-291, LITE-304, LITE-305, LITE-307, LITE-311, LITE-314, LITE-316, LITE-318 | Do not reimplement in Lite. Pin the release and retain focused integration/golden tests. LITE-281 uses the narrower section 5.7 contract; LITE-304 and LITE-318 have no current Lite caller. |
| Canceled tickets whose underlying concern is retained with revised semantics | LITE-280, LITE-289, LITE-292 | Static plugin effects remain internally verified; Pyth payload and exact fee are a bounded refresh slot, not immutable bytes. Fresh Pyth failure blocks dispatch. Pyth processing remains transparent to the user and adds no review fields, fee notice, freshness notice, or other visible output. |
| Canceled SDK safety item covered by the assumed release | LITE-290 | Keep a fail-closed Pyth integration test; no separate Lite implementation. |
| Remain canceled under these assumptions | LITE-279, LITE-286, LITE-296, LITE-297, LITE-301, LITE-302, LITE-303, LITE-306, LITE-309, LITE-312, LITE-313, LITE-315, LITE-317, LITE-320 | Do not revive their original remediation. Cover any independently retained lifecycle or policy invariant through the centralized architecture and current tests. |

This means the Apex findings are not all still active Lite tickets. Sixteen remain direct Lite requirements (including protections already present on `development`); ten become SDK-version gates; three supply revised plugin/Pyth requirements; one is an SDK fail-closed regression; and fourteen remain canceled.

Durability-only remediation from those tickets and historical PRs is explicitly out of scope. Retain their artifact-integrity and stale-context tests, but do not reproduce wallet lanes, persistent attempt journals, recovery services, cross-tab reservations, or ambiguous-submission quarantine.

## 5. Non-negotiable invariants

### 5.1 One consent-bearing artifact

For a reviewed execution `C`, canonical comparison normalizes only fields represented by a typed slot in the accepted request set:

```text
digest(accepted reviewed request set C)
  = digest(simulated request set C)
  = digest(calldata export C)
  = digest(Tenderly projection C)
  = digest(normalized finalized request passed to the wallet C,
           normalizing declared signature, Pyth-refresh,
           and wallet transport slots)
```

The digest commits to slot kind, position, target, selector, feed set, freshness rule, and value bound. It does not pretend that a fresh Pyth payload or its exact fee bytes were known at review time. Internal projection metadata records the preview payload hash for literal calldata and Tenderly output; this adds no user-facing review label or notice.

Only one execution plan exists. The existing handcrafted, operation-specific review models remain separate non-executable presentation models and are intentionally not required to map one-to-one onto transaction-plan or EVC-batch items. Each presentation is bound to the exact intent IDs/revisions and reviewed execution it confirms, but it does not become execution authority.

The visible review is not part of the byte-equality equation above. `ReviewBinding` proves which existing presentation inputs and intent revisions the user confirmed; it is not a generic decoder of the reviewed request set and must not reshape the visible review to mirror internal calls.

### 5.2 No work after acceptance that can change meaning

After `accept(reviewId, reviewDigest)`, these are unreachable:

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
- The complete Safe transport envelope and call vector, including version, sender, chain, atomic requirement/capability evidence, approvals, prerequisite grants, main calls, post-migration revocations/restorations, and wrappers.

Wallet kind, Safe classification, connector session, approval mode, and batching strategy must be resolved before sealing. A later change invalidates the reviewed execution. There is no execution-time repair or fallback.

`materializeExecution` is the canonical base-composition boundary. It receives the prepared plan and every live composition input explicitly and returns a deeply frozen `MaterializedExecution` containing the request vector, Permit2 signature slots, and matching Safe calls. `ReviewedRequestSet` seals that SDK value together with Lite's effect ownership, policy, migration-slot, and Pyth-slot metadata. Lite verifies and annotates the SDK output; it does not independently rebuild the base request vector.

`finalizeMaterializedExecution` inserts the exact Permit2 slot values into a new immutable vector and leaves the reviewed `MaterializedExecution` untouched. Lite's migration and Pyth extension finalizers follow the same copy-and-verify rule and normalize only their declared typed slots before the complete vector is compared with the accepted request digest.

### 5.4 Typed signature slots

Each signature slot commits to:

- Slot ID and purpose.
- Signer and chain.
- Complete typed data and typed-data digest.
- Target step, ABI argument, and exact insertion path.
- Expiration and nonce where applicable.

Finalization may change only those locations. Byte-pattern searches, all-zero wildcards, selector-only exceptions, and broad expected-difference rules are prohibited.

### 5.5 Typed Pyth refresh slots

Pyth is intentionally dynamic. The reviewed request set commits to a typed refresh slot containing:

- Chain, official Pyth target, `updatePriceFeeds` selector, insertion point, and affected `effectId`.
- The exact required feed-ID set derived from the final operation graph.
- The SDK freshness policy and the maximum native update fee accepted by the configured Pyth plugin.
- The preview payload hash, publish-time evidence, and fee used by review-time simulation.

At review, Lite seals both the raw pre-plugin plan and the fully processed preview plan. The Pyth plugin receives an explicit Lite-owned `maxUpdateFee`; the reviewed execution commits to that configured bound rather than relying on an implicit SDK default.

Pyth finalization is just in time for the request that contains the update, not merely for the beginning of a multi-request EOA sequence. In the initial schema every Pyth slot in one reviewed execution must belong to the same Pyth-bearing EVC request. If static approval or migration-grant requests precede it, Lite first hands only that static prefix to SDK `executeMaterialized`; after the SDK has obtained each required successful receipt, Lite reruns the public SDK plugin prefetch and complete plugin pipeline and finalizes the Pyth-bearing suffix immediately before its next wallet request. The suffix is then handed back to `executeMaterialized`, which continues the reviewed core and normal revocation sequence. A signature slot may not occur in the pre-Pyth prefix. Supporting multiple independently timed Pyth-bearing requests requires an SDK just-in-time request-finalization hook or a new reviewed schema; the initial implementation fails closed before the first wallet request.

Lite does not adopt the refreshed plugin result directly. A structural verifier compares it with the sealed preview and accepts only changes represented by the declared Pyth slot: a fresh `updatePriceFeeds` payload and its native fee at or below the sealed maximum. Pyth target, selector, feed set, insertion point, effect ordering, chain, and account remain immutable. TOS, Keyring, and every other plugin output must be byte-for-byte and structurally unchanged; any added, removed, reordered, retargeted, or modified static effect fails before the Pyth-bearing wallet request. Wallet and policy revalidation for the first Pyth-bearing suffix request runs immediately before refresh; after the verifier timestamps the fresh evidence, only synchronous finalization, exact byte checks, and SDK handoff may occur before that wallet request. Later non-Pyth suffix requests retain their normal per-request checks. Once a static EOA prerequisite has a successful receipt, expiry of the short-lived review/cache TTL during wallet-controlled receipt waiting does not abort that already-started accepted sequence; wallet, policy, slot, operation-deadline, and byte-equality checks remain in force.

Pyth is the only dynamic plugin kind in the initial schema, for example `pyth-update-v1`. Supporting another dynamic plugin requires a new versioned slot type, structural validator, internal policy treatment, and regression suite. This restriction is Lite-owned and does not require an SDK API that filters execution to Pyth alone.

### 5.6 Complete effects and bounded outcomes

Every approval, native-value transfer, direct call, EVC call, prerequisite, post-migration revocation/restoration, and plugin effect is a typed effect with provenance and a stable ID.

Variable operations must encode enforceable limits such as exact/max input, minimum output, bounded share movement, deadline/epoch, selected reward set, or explicit remainder-loss policy. An unbounded effect is rejected or isolated into a new reviewed execution.

### 5.7 Honest, classified simulation coverage

Simulation is independent from review, calldata export, and Tenderly construction. Those projections are always derived from the reviewed request set even when a simulation class produces no Euler state data.

Every effect receives one explicit coverage class:

- `evc-state`: the complete ordered EVC batch, including plugin calls present in the preview plan, is state-simulated. Approval needs are satisfied with documented state overrides; no approval transaction or permit is claimed to have executed.
- `modeled-authorization`: Permit2 and migration signatures/authorizations use typed metadata, deterministic stubs, or state overrides as documented by the SDK. The reviewed simulation records the assumption and does not invent a receipt or state transition.
- `independent-call`: a direct call explicitly marked by the SDK as safe against pre-plan state is simulated independently. Lite permits this only for a direct-only plan with no EVC batch and no dependency on another plan item. The current production case is Turtle rewards. Success returns `canExecute: true` with empty `simulatedAccounts` and `simulatedVaults`; calldata and Tenderly still use the exact call.
- `not-state-simulated`: an allowlisted existing reward-only direct call may be reviewed and exported without an Euler state projection. The internal reviewed simulation records that coverage. It does not add a visible review warning or field. New direct-call categories are rejected unless this architecture is deliberately updated; future transaction planners should use EVC batching where possible.

Do not perform a costly sequential backend simulation of approvals, permits, plugin prerequisites, or reward side effects. Do not combine an unsimulated direct call with an EVC batch and then present the EVC result as full-plan simulation. Results and assumptions map by `effectId`, never by array position.

### 5.8 Policy from the final graph

Policy subjects are derived exclusively from the final typed effect graph. They include all source, destination, acquired, input, underlying, prerequisite, post-migration revocation/restoration, wrapper, direct-call, and plugin-injected subjects.

Pending country detection, failed screening, missing metadata, unresolved vault type, missing underlying asset, unknown authority, or unavailable required policy result all fail closed.

### 5.9 Submission boundary and unknown status

The coordinator owns one active in-memory invocation of an accepted reviewed execution. It acquires a synchronous local guard before any signature or wallet request and disables repeat confirmation for that reviewed execution until the established adapter lifecycle returns or terminates. Acquiring this guard is a pre-handoff responsibility; retaining it does not replace or otherwise change SDK-owned EOA receipt sequencing or current-session Safe detachment/status handling after handoff.

The user approving/signing the transport request in the wallet is the canonical point of submission. Lite does not automatically retry a request or infer that an unknown request failed. Once handoff occurs, the existing EOA receipt sequencing and Safe tracked-execution behavior own confirmation progress and UI gating exactly as they do on the `development` baseline.

There is no persistent reviewed execution, attempt journal, durable wallet lane, cross-tab reservation, recovery service, or reload resumption. If the preserved current-session flow cannot determine status, the UI reports **status unknown** and advises the user to check the wallet or explorer. Refresh discards the reviewed execution and starts from newly fetched state.

Migration revocation remains part of normal execution, but it is not a durable safety gate. If the migration batch or its revocation fails, is rejected, or has unknown status, Lite reports exactly which phase is affected and that the authorization may remain. It releases local submission state and never blocks a fresh migration on completing an old revocation.

### 5.10 Context-scoped UI effects

Submission outcome belongs to the immutable reviewed execution invocation. Cart clearing, modal closing, and redirects belong to the currently active UI context.

A completion from context A must never clear or redirect context B. Successful submission updates only the exact stable intent IDs and revisions captured by the reviewed execution; newer cart edits survive. Later confirmation/revert updates are informational and context-scoped. Unknown status does not claim success and does not clear a newer context.

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
        +--- Policy engine ---> versioned ReviewedPolicy
        +--- SDK materializer -> immutable MaterializedExecution
        |                               |
        +--- Lite verifier/slot model --+--> ReviewedRequestSet
        +--- Simulator -------> ReviewedSimulation
                                  |
                                  v
                           immutable ReviewedExecution
                         /                           \
                        v                             v
          opaque operation review binding     ReviewedExecutionCoordinator
                        |                             |
                        v                     EOA / Safe adapters
        existing handcrafted Review UI               |
                                                   Wallet
```

Centralized means one authority for reviewed execution creation and one authority for every signature/send. It does not mean another giant composable. Operation compilers remain small and pure.

Suggested structure:

```text
features/reviewed-execution/
  domain/
    intents.ts
    effects.ts
    reviewed-execution.ts
  planning/
    requirements.ts
    snapshot-loader.ts
    compiler.ts
    preview-cache.ts
    plugin-data.ts
  materialization/
    prepared-plan.ts
    signature-slots.ts
    finalize.ts
  policy/
    engine.ts
    app-policy.ts
    validators/
  simulation/
    simulator.ts
    coverage.ts
  review/
    effect-map.ts
    binding.ts
    operation-adapters/
  coordinator/
    coordinator.ts
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
  phase: 'prerequisite' | 'core' | 'post-execution'
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

interface SafeTransportEnvelope {
  schemaVersion: 1
  version: '2.0.0'
  from: Address
  chainId: number
  atomicRequired: true
  calls: readonly { to: Address; data: Hex; value: bigint }[]
  capabilities: Readonly<Record<string, never>>
  atomicCapability: { status: 'supported' | 'ready' }
}

interface ReviewedRequestSet {
  schemaVersion: number
  wallet: WalletBinding
  sdkMaterialization: DeepReadonly<MaterializedExecution>
  effects: readonly EffectNode[]
  requests: readonly EoaRequest[] | readonly SafeCall[]
  safeTransport?: DeepReadonly<SafeTransportEnvelope>
  signatureSlots: readonly SignatureSlot[]
  pythRefreshSlots: readonly PythRefreshSlot[]
  constraints: readonly ExecutionConstraint[]
  policyDigest: Hash
}

interface ReviewedExecution {
  reviewId: Hash
  requestDigest: Hash
  reviewDigest: Hash
  intents: readonly OperationIntent[]
  requestSet: DeepReadonly<ReviewedRequestSet>
  policy: DeepReadonly<ReviewedPolicy>
  simulation: DeepReadonly<ReviewedSimulation>
  effectMap: DeepReadonly<EffectMap>
  binding: DeepReadonly<ReviewBinding>
  validity: DeepReadonly<ReviewValidity>
  pluginSnapshot: DeepReadonly<PluginSnapshot>
}

interface SubmissionResult {
  status: 'submitted' | 'rejected' | 'failed' | 'unknown'
  transport: 'eoa' | 'safe'
  migration?: {
    submission: SubmissionPhaseResult
    revocation?: SubmissionPhaseResult
    authorizationMayRemain: boolean
  }
}
```

Rules:

- DTOs contain no callbacks, refs, providers, SDK account objects, mutable class instances, or functions.
- Runtime schema validation rejects unknown fields and unsupported effects.
- Canonical hashing uses a schema-versioned encoder, normalized addresses, explicit integer encodings, and ordered arrays. Do not use `JSON.stringify`, FNV hashes, `WeakMap`, or object identity.
- The coordinator accepts only a `ReviewedExecution` containing the frozen SDK materialization, and adapters accept only a branded `FinalizedRequestSet` derived from it. Raw SDK plans and the generic SDK execution methods are not executable through the V2 boundary.
- TOS and Keyring are typed on-chain effects, not wallet signature slots. Pyth is a typed dynamic call slot. Only Permit2 and migration authorizations use `SignatureSlot`.
- Do not add `FeeFlowIntent` or `LiquidationIntent` while those production Lite surfaces are absent. A later baseline that contains either must add it through the exhaustive inventory and all applicable gates.

Public API:

```ts
prepare(intents: readonly OperationIntent[]): Promise<ReviewedExecution>
execute(execution: ReviewedExecution, acceptance: ReviewAcceptance): Promise<SubmissionResult>
```

`SubmissionResult` is the transport outcome produced by the established post-handoff flow: a completed EOA `executeMaterialized` sequence with its hashes and receipts, a conclusive current-session Safe result, a known failure/rejection, or unknown status. It is never persisted or used to authorize a later automatic retry. EOA receipt sequencing remains inside `executeMaterialized`; Safe status watching and detachment retain their existing current-session UI ownership and gating behavior without becoming durable reviewed-execution authority.

Review components continue to receive the operation-specific display props required by their current handcrafted presentation. A thin adapter also binds that presentation to an opaque reviewed execution ID and emits acceptance. Review components never receive an execution closure and cannot sign or submit.

## 8. Preparation pipeline

### 8.1 Preview preparation and cache adoption

The reviewed execution boundary centralizes authority, not latency. Lite continues to prepare eagerly while the user loads and edits a form:

- Form and account loaders warm vault/account snapshots, balances, allowances, policy inputs, and other operation dependencies.
- Quote flows fetch candidates, share one plugin prefetch across a quote sweep, prepare candidate plans, and estimate or simulate them in the background.
- ERC-20 storage-slot hints remain chain-scoped and reusable across form and batch paths. Form-load priming remains non-blocking.
- Pyth/Keyring plugin data, TOS inputs, and other expensive remote inputs may be prefetched before Add to batch or Review.
- The current whole-cart generation is compiled and simulated in the background after add, remove, reorder, or intent revision; preparation is not limited to isolated entry previews.

These results live in a preparation cache outside `BatchDraftEntry` and `ReviewedExecution`. They are accelerators, not execution authority. Every cached record carries the applicable identity needed to prove reuse is safe: intent or intent-set hash, cart generation, owner, chain, relevant account/subaccount, connector/session where material, observed block and data-source versions, freshness/expiry metadata, and the digest of any compiled request set.

`prepare()` is cache-first. It adopts matching prefetched inputs and an exact whole-cart background result before issuing new I/O, fetches only missing or stale dependencies, and reruns only invalidated stages. An unchanged cart may reuse its complete background reviewed simulation when the cart generation, intent-set hash, normalized request digest, planning snapshot, policy versions, and freshness rules all match. Per-entry simulations are not composed into a full-batch claim.

Authoritative sealing still invokes or deep-validates the SDK materialization and validates the final effect graph, simulation mapping, effect map, review binding, and canonical digest. Raw page-owned plans, mutable SDK instances, and results without complete cache identity are never adopted. Cheap pure compilation and validation may run again; expensive account/RPC reads, slot discovery, quotes, plugin prefetch, gas work, and exact full-cart simulation should normally come from valid warmed caches.

Cache misses affect preparation latency, not correctness. Any late result for a superseded generation is discarded. Review remains unavailable until one current authoritative reviewed execution is sealed. Review-time Pyth data may come from the matching cache, but the bounded execution-time Pyth refresh remains mandatory.

### 8.2 Authoritative sealing pipeline

1. Snapshot every relevant form value into immutable intent DTOs.
2. Capture owner, chain, subaccounts, connector/session, wallet kind, Safe classification, approval preference, and draft generation before asynchronous work.
3. Have each intent declare required accounts, vaults, assets, balances, allowances, feeds, quotes, policy subjects, and bounded postconditions.
4. Assemble one generation-bound planning snapshot by adopting compatible prefetched data first and fetching only gaps or stale entries. Use a common block where possible. Cache keys include owner, chain, block, connector/session where relevant, and data-source version.
5. Reject every stale async completion before every publication, not merely at the final return.
6. Compile the entire intent set into one effect graph with stable intent/effect IDs.
7. Run semantic validators: no orphan approvals or revocations, no mixed accounts/chains, no expanded reward set, and no undisclosed native value.
8. Resolve policy result from the final graph.
9. Seal the raw pre-plugin plan, process plugins for the review snapshot, and seal the processed preview. Seal TOS and Keyring as static effects. Convert each Pyth update into a typed refresh slot whose target, selector, feed set, ordering, freshness rule, and maximum value are immutable while payload and exact fee may refresh.
10. Resolve approvals and every signature request, including Permit2 nonce and typed data, before review.
11. Call SDK `materializeExecution` with the prepared preview plan, reviewed EVC address, and pinned Permit2 nonce/deadline/expiration inputs. Seal the returned immutable requests, signature slots, and Safe calls; fail if they disagree with the typed effect graph or Lite extension slots.
12. Produce the classified reviewed simulation from section 5.7. EVC state simulation, modeled authorizations, independent direct calls, and intentionally absent state projections remain distinct and map by `effectId`.
13. Generate an exhaustive effect map from the typed effects/request set, and bind the current operation-specific presentation inputs to the reviewed execution without changing their visible projection or requiring a one-to-one effect mapping.
14. Generate calldata and Tenderly projections solely from that request set.
15. Deep-validate, seal, and hash the reviewed execution.

No prerequisite or post-execution revocation call may be added, removed, or changed after review because live state changed. A freshly prepared reviewed execution may omit a migration authorization that fresh state shows is already standing; an incomplete revocation from an older attempt is not a blocker. If the new SDK result supplies a revocation/restoration for this reviewed execution, it is sealed and shown as part of this reviewed execution only.

## 9. User-facing review compatibility contract

The reviewed execution is an execution-authority refactor, not a review redesign. Preserve the current rendered review for every operation and batch variant exactly: fields, labels, values, grouping, ordering, abstractions, warnings, tooltips, explanatory copy, buttons, and operation-specific conditional behavior.

The current review is intentionally handcrafted for the operation. It may summarize, combine, omit, or present information differently from the underlying transaction plan or EVC batch. There is no requirement that visible rows correspond one-to-one with effects, calls, approvals, plugin items, or simulation coverage. The exhaustive effect graph, effect map, policy result, and reviewed simulation remain internal safety artifacts.

Do not add generic effect rows or expose internal targets, selectors, plugin calls, coverage classes, request digests, or authorization machinery unless the current operation-specific review already shows that information in that form. Existing displayed approval/signature information remains exactly as it is; the centralized internal representation does not expand it.

Migration authorization is intentionally transparent. Preserve the existing review steps for each required grant and revocation/restoration, including whether each is a separate EOA transaction or part of the Safe bundle. Execution status must distinguish the migration batch from the revocation step. If revocation fails, is rejected, or is unknown, tell the user that the migration result is separate and the approval may remain active; do not convert that warning into a retry gate.

Pyth is completely invisible to the user. Do not display its preview fee, maximum fee, payload hash, feed IDs, freshness policy, execution-time refresh, or failure mechanics in the review. Pyth bounds and refresh validation remain internal. A Pyth validation failure uses the existing transaction-preparation/error behavior rather than adding a Pyth-specific review surface.

Unknown or undecodable production effects still fail internal sealing. They do not cause the UI to synthesize a generic review row. Acceptance binds the existing presentation inputs, stable intent IDs/revisions, and reviewed execution ID to the sealed reviewed request set; the presentation itself remains non-executable.

Before implementation changes, capture the rendered output and interactive states of every current operation-specific and batch review variant. Use those fixtures as a strict compatibility suite throughout migration. The only approved product-output change in this PR is the migration execution-status treatment required above: core submission and revocation status are separate, and incomplete revocation visibly warns that authorization may remain. Any other deliberate review-product change is separate work requiring explicit product approval and is outside this PR.

Document this invariant in Lite as part of the implementation:

- Add a **User-facing review compatibility** section to `docs/transaction-building.md` explaining the separation between the exhaustive internal reviewed execution and the intentionally non-one-to-one handcrafted review.
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
- Add/remove/reorder changes the generation and invalidates any open reviewed execution.
- Background preparation continuously targets the complete current cart. Review adopts its exact matching inputs/results where valid, then recompiles or deep-validates the complete ordered cart against one base snapshot. This is not a cold-start requirement.
- Add-to-batch may display an optimistic draft row immediately, but Review stays disabled until the final reviewed execution is compiled and simulated.
- Simulation layers use stable `intentId`/`effectId` keys.
- Required migration authorization grants, the main migration, and normal revocations/restorations are explicit reviewed execution phases.
- Normal execution removes temporary migration authorization when the SDK supplies the corresponding revocation. For an EOA, submit the reviewed grant, core migration, and revocation sequence; for a Safe, include all three in the complete reviewed atomic call vector.
- Authorization resolution is idempotent. Fresh preparation treats an already sufficient standing approval as satisfied and must not run an old pending revoke or prevent a second migration attempt. If approval is absent, the new reviewed execution includes its grant.
- Preserve the existing `removeAuthorizationAfterMigration` choice for signature-capable flows and materialize transaction-form SDK `revocation` calls. Every grant/revocation pair is bound to the same reviewed wallet context and authorization payload.
- If the core request receives a successful receipt, continue with its reviewed revocation where applicable. If the core request is rejected, reverts, or has unknown receipt/submission status, stop the sequence; do not create a special cleanup transaction, and report that the authorization may remain.
- A failed, rejected, reverted, or unknown revocation is an incomplete normal post-execution step for this invocation only. Report it transparently, do not retry automatically, do not persist it as an obligation, and do not block fresh preparation or execution.
- Protocol operations inside the accepted core migration plan—such as repaying debt, moving or sweeping assets, and closing the source Euler position—remain part of the migration and are distinct from authorization revocation.
- Cross-intent effects that cannot be bounded are rejected or split into new reviewed executions.
- Successful submission removes only the intent IDs and revisions captured by that reviewed execution invocation.

There is one reviewed execution service for direct and batch execution, not a batch-specific executor.

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

## 11. Policy result

Use discriminated evidence, never permissive booleans:

```ts
type PolicyState =
  | { state: 'allowed'; version: string; observedAt: number; expiresAt?: number }
  | { state: 'blocked'; version: string; reason: string; observedAt: number }
  | { state: 'pending'; version: string }
  | { state: 'unavailable'; reason: string }
```

Evidence covers:

- Country/geo and VPN screening.
- Wallet/account screening.
- Vault chain, type, underlying, labels version, and canonical live authority.
- Unverified-vault acknowledgement scoped to the exact reviewed execution subject set.
- TOS document/message digest and `(chainId, account)` acceptance.
- Quote identity, provider, calldata digest, assets, amounts, spender, limits, and expiry.
- Pyth target, required feed set, preview payload digest/publish-time evidence, native-fee estimate and maximum, and freshness policy.
- Approval owner, token, spender, and amount.
- rEUL lock identity, amount bound, and remainder-loss policy.
- Deployment and policy-source versions that can change the operation at runtime.

Policy result is internal. It does not add visible review fields or acknowledgements beyond those already present in each operation-specific review.

The policy engine lives at application scope. It does not retain component callbacks whose state can freeze after unmount.

Reviewed execution validity, policy result, wallet connector/session, classification, and draft revision are checked after every relevant await and immediately before every signature or send. For the first EOA Pyth-bearing suffix request, these checks occur immediately before its Pyth refresh; the structural verifier, synchronous finalizer, exact-byte hook, and SDK handoff are the only subsequent work before send. A failure before the wallet request is reported without submission. If the wallet interaction may have been accepted but the provider cannot report a result, Lite reports status unknown and stops.

No post-acceptance check may rebuild or mutate the accepted artifact. A failed check invalidates that reviewed execution and requires fresh preparation and review.

## 12. Submission coordinator

The coordinator is an in-memory execution boundary, not a durable lifecycle engine:

```text
idle
  -> revalidating accepted reviewed execution
  -> signing declared slots
  -> finalizing bounded dynamic slots
  -> dispatching exact finalized transport
     -> EOA static prefix -> required receipt(s) -> JIT Pyth refresh/finalization -> finalized suffix
     -> Safe handed off(callsId) -> established current-session status flow
  -> confirmed | submitted(identifier) | failed/rejected | status-unknown
  -> idle

Safe handed off(callsId)
  -> existing detachable current-session watcher and UI gate
```

Rules:

- Acquire an in-memory guard synchronously at coordinator entry, before awaiting any signature or wallet method. Re-entry for that active reviewed execution/process is rejected and the confirm action remains disabled.
- The coordinator guard prevents duplicate callbacks for the active reviewed execution before handoff. It is not shared across tabs or reloads. After handoff, the pre-existing Safe tracked-execution slot may continue gating confirmations while the Safe proposal awaits its established current-session outcome.
- Revalidate the opaque acceptance binding, reviewed execution integrity, current account, chain, connector session, wallet kind, policy, expiry, and cart generation before collecting signatures and again immediately before the transport request.
- Finalization may fill only declared signature slots, bounded Pyth refresh slots, and wallet-owned transport fields. Compare the finalized normalized artifact with the accepted request set immediately before calling the adapter. For an EOA sequence with static prerequisites before its single Pyth-bearing request, dispatch only that reviewed static prefix first; refresh and finalize Pyth only after its SDK-owned receipts and immediately before dispatching the finalized suffix.
- Call each wallet method at most once from that invocation. Do not automatically retry after any error or unknown response.
- A recognized wallet rejection or known failure is reported as such. A timeout, disconnect, malformed response, missing identifier, or otherwise inconclusive result after wallet interaction is reported as **status unknown**.
- For EOA, record each returned hash and keep the guard while `executeMaterialized` waits for the receipt required before the next reviewed request. The blocking EOA path completes when the SDK sequence returns or terminates. For Safe, hand the returned calls ID to the existing detachable current-session status flow; preserve its modal-close, tracked-execution gate, context-abandonment, and completion-toast behavior.
- For a reviewed EOA migration sequence, keep the same in-memory coordinator guard across its grant, core, normal revocation wallet requests, and the SDK's required receipt sequencing. Release it in `finally` when `executeMaterialized` returns or terminates. Safe handoff then follows the pre-existing tracked-execution lifecycle rather than a new coordinator-owned durable lifecycle.
- Report migration core execution and authorization-revocation execution separately. The SDK advances to the reviewed revocation only after a successful core receipt; a reverted or inconclusive core receipt stops the sequence. Revocation rejection, failure, revert, or unknown status does not rewrite a confirmed core result.
- Invalidate the reviewed execution after any submission outcome. A deliberate retry or subsequent operation requires fresh preparation, review acceptance, and wallet approval.
- Reload discards all coordinator state and fetches current protocol, allowance, migration-authorization, wallet, and Safe state through the normal application loaders.
- Do not add IndexedDB, a persistent/local-storage lock, a durable wallet lane, compare-and-swap fencing, `BroadcastChannel`, a recovery service, a resumable durable attempt handle, or a root recovery UI. Preserve `useSafeExecutionDetachment` as the baseline in-memory post-handoff UI mechanism.

## 13. Transport adapters

### EOA

- Accept only an already-finalized SDK vector whose requests have the exact reviewed `from`, `chain`, `to`, `data`, and `value`. The only exception is the already reviewed, byte-static prefix split required to reach a later Pyth-bearing request; it contains no unfilled dynamic slots.
- Pass each authorized vector segment to SDK `executeMaterialized`; do not expose a general Lite request-composition or sequential-execution implementation. SDK owns receipt sequencing inside the static prefix and finalized suffix, and Lite never submits the suffix until the prefix has returned successful receipts.
- Use awaited SDK hooks to reassert the complete wallet binding, active invocation, and request-byte equality before every signature and send.
- Invoke each sealed `eth_sendTransaction` request once, record its hash, and require its successful receipt before the SDK advances to the next reviewed request. The SDK dispatches the finalized bytes without re-encoding them.
- Stop the sequence on rejection, known failure, or unknown status. Never submit a later step automatically after an inconclusive earlier result.
- Do not search by nonce, scan blocks, recover a missing hash, persist transaction evidence, or quarantine later operations. Report unknown status and require a fresh reviewed execution for any later submission.
- Execute the reviewed migration-authorization revocation on the normal path after the core request has a successful receipt. If the core request is rejected, reverts, or has unknown status, stop without synthesizing a cleanup request. If revocation is rejected, reverts, fails, or is unknown, preserve the confirmed core result, warn that the authorization may remain active, release the guard, and allow fresh planning to recognize that live authorization on the next attempt.
- Cart clearing and migration-submitted UI depend on the core submission result, not on successful revocation submission. A revocation problem is a separate visible warning and must not turn a submitted migration into a failed one.

### Safe/EIP-5792

- Classification must be resolved before sealing. Unresolved classification blocks review.
- Query `wallet_getCapabilities` for the reviewed account and chain before review. The per-chain `atomic.status` must be `supported` or `ready`; missing or `unsupported` capability blocks review. Revalidate that requirement immediately before handoff.
- Seal and digest the complete semantic `wallet_sendCalls` envelope: EIP-5792 version, `from`, chain, `atomicRequired: true`, exact ordered calls, and every request capability, together with the admitted per-chain atomic-capability snapshot. The built-in atomic discovery result is evidence for `atomicRequired`; it is not copied into the request's extensible `capabilities` member.
- Verify the complete finalized envelope, including prerequisite wrappers, against the accepted request set immediately before one `wallet_sendCalls` invocation. Serialize that envelope directly to the reviewed provider so a client cannot inject an unsealed capability. Pass `atomicRequired: true`; a one-invocation call batch without that field is not considered atomic.
- Treat the user's Safe approval/signature as the reviewed-execution handoff boundary. A returned calls ID enters the existing current-session Safe status/detachment flow, which continues to gate confirmations and report execution hashes, receipts, or errors as it does on the `development` baseline.
- Report a confirmed successful Safe result only when `wallet_getCallsStatus` explicitly returns `atomic: true`. `atomic: false` is a conclusive failure of the reviewed transport guarantee; missing atomic status is inconclusive and cannot be promoted to success.
- Preserve the established current-session Safe status classification after handoff: `400` is cancelled, `500/600` is failed, and a mined revert is reverted. A missing calls ID, unavailable status, provider loss, or malformed/inconclusive response is reported as status unknown; there is no persistent reconciliation.
- Provider loss cannot fall back to EOA or sequential execution.
- Safe migration call vectors include the SDK-provided authorization revocation/restoration when configured, so the normal grant/core/revoke path remains atomic. If the Safe call is rejected, fails, or has unknown status, report that result and that a pre-existing authorization may remain; never persist a cleanup obligation or block a fresh attempt.
- Cart clearing and redirect occur only for the established successful Safe outcome and only if the captured UI context is still active. Detached Safe confirmation or failure keeps the existing context-scoped toast and suppression behavior.

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

### Stage B - Domain kernel, SDK materialization, and Lite verification

- Implement intents, effect graph, stable IDs, canonical encoding/digests, runtime schemas, typed signature slots, bounded Pyth refresh slots, the plugin structural verifier, and semantic validators around SDK `materializeExecution`.
- Seal the immutable SDK materialization inside `ReviewedRequestSet`, prove Lite's richer effect projection agrees with every SDK request/slot/Safe call, and use `finalizeMaterializedExecution` plus the public migration encoder for declared signature changes.
- Prove every finalizer returns a new vector, leaves the reviewed SDK materialization unchanged, and changes only declared signature, Pyth-refresh, and transport slots.

Exit: every supported operation can produce a deterministic reviewed request set without wallet interaction.

### Stage C - Snapshot, policy, simulation, and review binding

- Implement eager, generation-bound preparation; context-complete cache identities; cache-first snapshot loading; exact whole-cart result adoption; app-scoped policy result; classified simulation coverage; effect map generation; calldata/Tenderly projection; and opaque adapters that bind the unchanged operation-specific review components to reviewed executions.
- Add the direct-only simulation adapter: accept SDK-declared `independent` only when there is no EVC batch or earlier-effect dependency, beginning with Turtle; preserve empty account/vault projections; keep calldata and Tenderly available independently of state simulation.
- Add the implementation documentation and links required by section 9, including the root `AGENTS.md` invariant.
- Run V2 in test/dev shadow comparison against current `development` flows while the PR remains draft.

Exit: the internal reviewed simulation, effect map, export, and materialized request set share one normalized request digest; every coverage class is recorded internally; and the complete rendered review compatibility suite is unchanged.

### Stage D - Submission coordinator and adapters

- Implement the in-memory pre-handoff re-entry guard, acceptance/context revalidation, bounded execution-time Pyth plugin rerun/finalization, exact pre-wallet artifact comparison, SDK `executeMaterialized` EOA integration, one-shot Safe wallet handoff, and current-session result classification. Preserve the existing Safe detachment/status lifecycle after handoff.
- Pass only the reviewed static pre-Pyth prefix or an already-finalized EOA suffix/vector to `executeMaterialized`; bind every awaited SDK hook to the active invocation, request equality, hash recording, and phase-result checks, with the documented JIT-first-request revalidation ordering. Safe continues through the dedicated calls-ID adapter using the finalized sealed envelope.
- Implement the standard unknown-status outcome for inconclusive provider responses. It must release the local guard, preserve no execution authority across reload, and never trigger an automatic retry.
- Preserve and centralize normal migration revocation generation while removing durable cleanup obligations, pending-revoke queues, `restorePendingBeforeRetry`, and every retry gate based on an older revocation. Make an already sufficient live migration authorization a valid, idempotent prerequisite during fresh planning and execution.
- Preserve each flow's existing `removeAuthorizationAfterMigration` decision for signature-capable authorization and materialize SDK-provided transaction-form revocations/restorations. Verify that a normal reviewed execution attempts the revoke, while a later fresh SDK authorization lookup can proceed with an authorization left standing by an interrupted or failed earlier sequence.
- Return and render structured migration-phase results: core submission is distinct from revocation submission, and any residual-authorization warning names the failed/rejected/unknown phase without scheduling work for a future attempt.

Exit: no wallet interaction is reachable without an accepted reviewed execution, an acquired local guard, current binding/policy checks, and exact finalized-artifact verification.

### Stage E - Migrate all in-scope operations

- Migrate simple direct operations first inside the branch, followed by swaps, rewards/rEUL, multiply/refinance, batch, and migrations. Do not invent FeeFlow or liquidation Lite callers for absent inventory rows.
- Each page becomes an intent factory and reviewed execution launcher only.
- Port every inventoried `development` operation through the same API.
- Keep Add-to-batch synchronous: append the serializable intent immediately and run planning/simulation as generation-bound background work. A form is not migration-complete until its own click-to-visible gate passes.
- Preserve form-load and form-edit warming for accounts, quotes, plugin data, slot hints, gas, and simulations. Route those results into the centralized preparation cache rather than page-owned execution state.
- Preserve each page's existing operation-specific review inputs and visible output through the review-binding adapter. Migration is incomplete if any rendered review fixture changes.

Exit: the inventory reports no in-scope legacy caller.

### Stage F - Delete the legacy lifecycle

Remove or make unreachable for in-scope flows:

- Lite-facing raw-plan execution entry points (`executePlan`, `executePreparedPlan`, and any generic `executeTransactionPlan`/`executePreparedTransactionPlan` wrapper). Keep only the coordinator's private `executeMaterialized` adapter.
- Plain transaction helpers callable from pages.
- Modal preparation and `onConfirm` execution callbacks.
- Batch executable closures and `lastMerged` authority.
- Page-owned migration execution reviewed executions.
- IndexedDB reviewed execution journals, durable wallet lanes, recovery services/UI, persistent attempt state, cross-tab coordination, and durable resumable attempt handles. Keep the pre-existing in-memory Safe detachment handle and its post-handoff tests.
- Pending-revoke shared state, `restorePendingBeforeRetry`, persisted/session cleanup obligations, and all cleanup-based retry blocking. Retain deterministic revocation builders used by the current reviewed execution.
- Per-page retry/recovery state and ambiguous-submission quarantine.
- Heuristic reviewed-plan comparators and signature-byte scanners.

Exit: only the coordinator/adapters can sign or send.

### Stage G - Full validation and code freeze

- Run build, lint, typecheck, full Vitest, golden fixtures, parity tests, fork execution tests, model tests, and focused browser submission-interaction tests.
- Run the exhaustive production-build batch-form performance matrix and archive per-form raw, maximum, and p95 click-to-visible timings.
- Run `git diff --check`, conflict-marker scan, dependency/supply-chain review, and the send/sign inventory.
- Verify the installed SDK resolves to the pinned published version and that its simulation/plugin docs still describe the behavior this plan relies on.
- Freeze an exact candidate SHA.

Exit: all automated gates pass on one clean exact head.

### Stage H - Fresh-agent review gate

Do not mark the PR ready for human review until this gate completes.

1. Freeze the candidate SHA and give every reviewer the exact SHA and `development` base.
2. Spawn fresh read-only agents with no implementation conversation history:
   - one using `review-stack` for Vue/Nuxt/TypeScript architecture and lifecycle correctness;
   - one using `review-business` for Euler operation semantics, bounded effects, policy subjects, and user-visible accuracy;
   - one using `review-security` for signing, wallet binding, re-entry, unknown-status handling, and transaction integrity;
   - after those reviews finish, one using `review-pr` for a full surface pass and deep caller/callee trace of every modified symbol.
3. Require findings to name exact files/lines, reachable call chains, severity, and a discriminating reproduction/test. Agents remain read-only and do not post to GitHub.
4. Independently validate every finding against the exact head. Fix confirmed issues as a cohesive batch; reject invalid findings with evidence.
5. Run the complete automated suite again.
6. Because fixes create a new SHA, discard prior sign-off and repeat with new fresh agents.
7. After the independent reviews are clean, run a separate explicit challenge pass against the trap matrix in section 16.
8. Mark the PR ready only when all reviews and the challenge pass are clean on the same exact head.

Historical approvals, aggregate PR badges, and a queued/incomplete agent run do not count as exact-head sign-off.

## 15. Test program

### Structural/property tests

- Canonical digest is deterministic and schema-versioned.
- SDK materialization is deterministic and deeply frozen; repeated calls with the same prepared plan and explicit inputs produce identical requests, Permit2 slots, and Safe calls.
- SDK Permit2 finalization and Lite's typed migration/Pyth extension finalizers return new immutable vectors, leave the reviewed SDK materialization unchanged, and change only declared signature, Pyth-refresh, and wallet transport slots.
- Every executable effect is represented in the effect map or rejected. Visible review output is intentionally not required to map one-to-one to effects.
- Every executable effect has an explicit simulation coverage class; no partial result is represented as full-plan state simulation.
- EVC simulation includes the preview plugin calls and maps operation layers by stable `effectId`/operation ID.
- Approvals and Permit2/migration authorizations are recorded as modeled assumptions, not fabricated simulated transactions.
- A direct-only Turtle plan uses `simulationMode: 'independent'`, propagates call failure, and returns no simulated account/vault state on success.
- Direct-call calldata and Tenderly projection remain available when Euler state arrays are empty or the allowlisted reward call is intentionally not state-simulated.
- Mixed unsimulated direct-call/EVC plans fail closed.
- Finalized normalized EOA/Safe requests passed to the wallet equal the accepted request set after only declared slot normalization.
- EOA `executeMaterialized` receives only the reviewed static prefix or already-finalized suffix, exposes the same request bytes to every hook and wallet call, performs no planner/plugin/approval/composition work, and waits for each successful receipt before the next reviewed request.
- No functions, refs, unknown fields, or mutable SDK objects enter a reviewed execution.
- Policy subject extraction includes direct calls, approvals, wrappers, prerequisites, post-execution revocations/restorations, and plugin effects.
- Matching prefetched inputs and an exact whole-cart background result can be adopted only when every cache identity and freshness field matches; any owner, chain, account, session, generation, intent, block/data version, policy version, or digest mismatch rejects reuse.
- Individual entry simulations cannot be composed into a full-cart reviewed simulation. Only an exact whole-cart simulation keyed to the reviewed request set may be reused.
- Execution-time plugin processing receives only the sealed raw pre-plugin plan and configuration. Structural comparison rejects every difference except a declared Pyth payload and bounded fee change.
- Added, removed, reordered, retargeted, or modified TOS, Keyring, or other static plugin effects invalidate the reviewed execution before a wallet request.

### User-facing review compatibility tests

- Exercise every current operation-specific review and batch-review variant against the pre-refactor fixtures, including conditional fields, expanded/collapsed states, warnings, tooltips, action labels, and display-only/read-only modes.
- Require identical rendered labels, values, grouping, ordering, visibility, and interaction states after migration. Do not regenerate fixtures merely because the reviewed execution internals changed.
- Prove the internal effect graph may contain more or differently grouped effects than the visible review without leaking generic rows or internal metadata into the UI.
- Prove Pyth fee, maximum, feed IDs, payload/freshness data, and refresh behavior never appear in the review UI.
- Prove each unchanged operation-specific presentation is bound to the exact intent IDs/revisions and reviewed execution accepted by the user, while remaining unable to sign or submit directly.

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
- Prove cached prepared SDK objects, page-owned plan objects, and per-entry simulation results are rejected as reviewed execution authority.

### Async and model-based tests

Inject failure or context change before and after every await in preparation, finalization, signing, and submission:

- Account, chain, connector/session, Safe classification, approval preference, and batch revision changes.
- Overlapping review A/review B completion ordering.
- Async batch add and resimulation completing after clear/context reset.
- Policy and evidence version changes.
- Pyth refresh success/failure, expiry, target change, payload refresh, feed-set change, fee change within the bound, and fee above the bound. Only a fresh payload and bounded fee may finalize without a new review. A delayed prerequisite receipt that exceeds the Pyth freshness window proves refresh occurs afterward and immediately before the Pyth-bearing suffix, rather than before the prefix.
- Permit2 nonce change.
- Repeated confirm calls before and during wallet interaction produce only one wallet call from that reviewed execution process; the existing Safe tracked-execution gate remains active after handoff while status is pending.
- Wallet acceptance followed by timeout, provider disconnect, malformed response, or missing identifier reports status unknown and performs no automatic retry. Coordinator-owned pre-handoff state is released; established Safe detachment cleanup remains authoritative for its in-memory UI slot.
- A fresh reviewed execution can be prepared after unknown status; it performs fresh state reads and requires another wallet approval.
- A successful EOA migration core receipt advances to the already reviewed revocation request; a returned hash alone does not. The guard covers the SDK sequence and is released when `executeMaterialized` returns or terminates.
- Core rejection, revert, pre-hash failure, or unknown receipt/submission status stops the EOA sequence without synthesizing a cleanup request and visibly warns that authorization may remain.
- Revocation success, rejection, failure, and unknown status are reported separately from the core submission result. Every revocation outcome releases the guard; no outcome creates a pending obligation or retry gate.
- A fresh migration proceeds from live authorization state after an earlier interrupted or failed revocation, omitting a redundant grant when appropriate while still including its own normal revocation where the SDK supplies one.
- Success after the user navigates or edits a new cart.

### Submission-interaction browser tests

- Double-click and overlapping confirm callbacks in one active UI context open only one wallet request.
- Navigating or editing a new cart while the old wallet request is pending cannot let the old completion clear or redirect the new context.
- Closing during a Safe request preserves the existing detached current-session tracking and completion toast. Reload does not resume it, restore a reviewed execution, or leave execution blocked after reload.
- Reload fetches fresh account, allowance, migration-authorization, and protocol state before enabling a new review.
- Separate tabs have no shared application lock. Each transaction still requires its own explicit wallet approval.
- Migration review and result UI show authorization grant/revocation steps and distinguish a submitted core transaction from a failed, rejected, or unknown revocation; the warning states that authorization may remain active.

### Safe tests

- Classification unresolved, EOA, and Safe transitions before review and at every await.
- Per-chain atomic capability `supported` and `ready` admit review; missing and `unsupported` block review and revalidation blocks handoff.
- Late classification cannot replace Permit2 with approval calls.
- Single-call and bundled paths share the same accepted-artifact and one-shot submission boundary.
- Provider loss cannot fall back.
- Lost/malformed calls IDs and unavailable or malformed status responses report status unknown and do not retry; the established `400` cancellation and `500/600` failure classifications remain unchanged.
- Returned calls ID, execution hash, successful receipt, mined revert, rejection, and timeout are classified only for the current session.
- The finalized envelope passed to `wallet_sendCalls` matches the accepted reviewed execution digest, including version, from, chain, `atomicRequired: true`, calls, and request capabilities.
- A successful receipt is reported as confirmed only with `wallet_getCallsStatus.atomic === true`; false or missing atomic evidence never produces Safe success.
- Completion from context A does not clear context B.

### Domain regressions

- rEUL claim/unlock amount and remainder-loss policy.
- Selected-only reward claims and exact Fuul fees.
- Turtle direct-only independent simulation with empty Euler state projection, exact calldata, and a Tenderly link.
- Approval token/spender/amount and unlimited sentinel.
- Migration share bounds, canonical account, and authorization prerequisites.
- A normal EOA migration with a successful core receipt advances to its reviewed authorization revocation, and a normal Safe migration includes the SDK-provided revocation/restoration in its atomic call vector.
- A successful migration authorization followed by core rejection, pre-hash failure, or unknown submission status leaves the approval standing, schedules no cleanup, and displays that possibility.
- A failed, rejected, or unknown revocation preserves the separately reported core submission result, displays that the approval may remain, and creates no retry gate.
- A second freshly prepared migration recognizes any standing approval, omits a redundant prerequisite where appropriate, includes its own normal revocation where applicable, and reaches review/submission normally.
- SDK integration coverage for the full violator feed set, absent liquidation approval, and disabled unsafe FeeFlow buy planning; no absent Lite execution route is created.
- All hard-blocked inputs/touched vaults and soft-restricted acquired exposure.
- Changed final vault set requires a fresh acknowledgement.

## 16. Trap audit: proof that the new design avoids prior failures

| Historical trap | Source | Structural prevention | Required proof |
| --- | --- | --- | --- |
| Display, simulation, calldata, and execution use different plans | #810, #782 | One reviewed request set and one normalized digest; review takes only reviewed execution data | Digest equality tests across every projection and the finalized request passed to the wallet after declared slot normalization |
| Confirm callback rebuilds from reactive form state | #810, #782 | Pages create intents only; planner imports forbidden after seal | Overlapping reviews where A confirms after B prepares still execute A |
| Batch simulation uses add-time plans while execution authority rebuilds | #810 | Whole cart compiled and simulated as one authoritative reviewed execution | Add-time preview differs from final graph; only the final graph is executable, while the unchanged handcrafted review remains bound to the final intent set |
| `Object.freeze` wraps closures and mutable objects | #810 | Serializable runtime schema and deep validation reject functions/refs/classes | Construction fails for closures, Vue refs, SDK accounts, and unknown fields |
| Signature parity scans placeholder bytes | #810, #782, #784 | ABI-aware typed slots with signer/hash/path | Repeated placeholders, transposition, selector collision, and unrelated 65-byte data all fail |
| Pyth refresh becomes an unrestricted post-review replan or expires behind EOA prerequisite receipts | #782, #784, LITE-280, LITE-289, LITE-292 | Typed slot seals official target, selector, feed set, ordering, freshness, and max value; only payload and bounded fee refresh; static prerequisite prefix is receipted before JIT suffix finalization | Fresh payload succeeds; delayed prerequisite beyond freshness still refreshes afterward; unknown target, selector/order/feed change, stale data, plugin failure, or excess fee blocks the Pyth-bearing wallet request |
| Direct-call-only simulation returns no Euler state and is mistaken for failure or full state coverage | LITE-281 | Coverage is independent from export; SDK-declared independent mode is limited to direct-only pre-state-safe calls, beginning with Turtle | Turtle success has `canExecute: true`, empty account/vault arrays, exact calldata, and Tenderly; revert propagates; mixed unsimulated plan is rejected |
| Wallet/account/chain binding is optional | #810, #782 | Binding required by schema and reasserted before every signature/send | Change each binding field at every await; no wallet call occurs |
| Safe classification resolves late and rewrites approval mode | #782, #784 | Classification/approval mode resolved before seal; drift invalidates | Unresolved-to-Safe and Permit2-to-approval transitions require new review |
| Reviewed Safe silently falls back to EOA/sequential execution | #782, #784 | Transport-specific reviewed request set and adapter; no fallback return type | Provider loss fails closed with no alternate wallet write |
| Safe call batch is assumed atomic from one RPC invocation | Plan review | Seal version/from/chain/atomic requirement/calls/capabilities, require per-chain atomic capability, and verify confirmed atomic status | Missing/unsupported capability blocks review; envelope drift blocks handoff; `atomic: false` or missing evidence never reports success |
| Policy covers only page-primary vaults | #781 | Subjects derived from complete effect graph | Blocked destination/input/underlying/prerequisite/plugin subject prevents review |
| Policy callback outlives component but its state freezes | #783 | App-scoped evidence with direct expiry/version evaluation | Unmount, advance time/switch wallet, then sign/send remains blocked |
| Policy asserted only before the terminal batch, not prerequisites | #783 | Coordinator validates before every irreversible step | Flip policy during prerequisite build; no grant is sent |
| Module-global latch from reviewed execution A overwrites B | #810, #784 | Reviewed execution is instance-owned by ID; no module-global execution authority | A prepares, cart clears/B prepares, A finishes last; B remains authoritative |
| Shared modal refs let review A execute plan B | #782, #784 | Modal captures immutable reviewed execution ID/digest | Two overlapping direct-operation reviews execute their own exact artifacts |
| Stale async batch add/resimulation republishes old owner state | #810, #784 | Context-keyed caches and generation checks before every publication | Deferred A result after reset cannot enter B snapshot/cart |
| Repeated confirm callbacks open duplicate wallet requests in one process | #810, #782 | Coordinator acquires a synchronous in-memory guard before its first await; after Safe handoff the existing tracked-execution slot continues its baseline UI gate | Double-click and overlapping callbacks produce one wallet call; pre-handoff termination releases coordinator state while detached Safe tracking remains unchanged |
| Browser persistence becomes a prerequisite for transacting | Revised design | Reviewed executions and submission state are memory-only; no IndexedDB, persistent lock, or recovery service | Transactions remain available when persistent browser storage is unavailable; forbidden-import scan finds no reviewed execution persistence path |
| Lost wallet response is treated as success or automatically retried | #810, #782, #784 | Report status unknown, stop the sequence, invalidate the reviewed execution, and make no second wallet call | Timeout, disconnect, malformed response, and missing ID show unknown status and release the local guard |
| Reload resumes or blocks on stale execution state | #782, #784 | Reload restores no reviewed execution or attempt and runs the normal fresh-state loaders | Reload during each submission phase yields a fresh form/review with no recovery prompt or disabled wallet-wide state |
| Safe success/failure is overclaimed from an inconclusive response | #784, #810 | Classify only conclusive current-session evidence; otherwise report status unknown | Missing calls ID/status/receipt and inconclusive `400/500/600` responses remain unknown without persistence or retry |
| Migration cleanup or revocation blocks a second attempt | Migration flows | Normal reviewed revocation remains, but no pending-revoke state, cleanup obligation, or retry gate survives the invocation; fresh live authorization state is authoritative | Core or revocation fails/returns unknown; UI shows that authorization may remain, and a fresh attempt reaches review/submission without old cleanup blocking it |
| Completion from old context clears new cart or misreports success | #782, #784 | Reviewed execution invocation is separated from active UI effects; stable revisions | A completes after B starts: B is preserved, with no stale redirect or false success |
| Fix applied to one route/sibling but another bypasses it | #810, #784 | Exhaustive intent union, central coordinator, forbidden-import inventory | CI fails for any new or remaining in-scope direct send/sign caller |

## 17. Relevant lessons from PRs #781-#784

### PR #781 - policy scope

Preserve:

- Unknown country and missing metadata fail closed.
- Policy includes source, destination, acquired, input, underlying, and distinct multiply/refinance/migration subjects.
- Hard blocks and acquired-exposure restrictions are modeled explicitly.
- Unverified acknowledgement binds to account, chain, final subject set, and reviewed execution digest.

Do not port page-by-page guards or copied policy metadata. The final effect graph is the only policy-subject source.

### PR #782 - exact artifact and submission integrity

Preserve:

- Exact approval token/spender/amount, native value, rEUL bounds, wallet binding, typed signature tests, prerequisite coverage, Safe unknown-status tests, local duplicate-confirm protection, and preservation of later cart edits.

Do not port modal callbacks, object-identity authorization, heuristic equality, Pyth wildcarding, optional lifecycle callbacks, persistent attempts, cross-tab reservations, or Safe-only persistence.

### PR #783 - policy freshness

Preserve:

- TOS/account/chain versioning, positive VPN result preservation, canonical authority verification, pending geo blocking, stale async rejection, direct expiry evaluation, and policy assertions at every irreversible boundary.

Improve on it by owning evidence at application scope instead of retaining callbacks whose component-scoped state can stop updating.

### PR #784 - execution context and Safe status

Preserve:

- Chain-aware registries, prepared-context invalidation, explicit unknown Safe status, conclusive current-session receipt handling, context-safe UI cleanup, and TOS/plugin fingerprints.

The current exact head still demonstrates why the clean boundary is required: reviewers found stale global latch publication, incomplete Pyth trust handling, a missed sibling route, unresolved-to-Safe reviewed execution drift, and stale resimulation publication. Each retained concern maps to a structural rule and test in section 16; durable-write and recovery requirements are intentionally not carried forward.

## 18. Definition of done

- One PR contains the complete in-scope implementation and legacy deletion.
- Every in-scope form/page creates intents only.
- Every in-scope direct and batch operation uses the same reviewed execution service.
- Only the coordinator/adapters can sign or submit; CI enforces the boundary with a narrow frozen allowlist for excluded legacy workflow files.
- No review modal receives an execution callback or any authority to sign or submit. It may continue to receive frozen operation-specific display inputs needed to reproduce the current handcrafted output.
- No batch entry or reviewed execution contains executable functions or mutable reactive state.
- Every reviewed request set seals the immutable SDK materialization used to derive its EOA requests and Safe calls; no Lite-owned base materializer or generic executor remains.
- Wallet kind, Safe classification, connector/session, approval mode, policy result, static transport fields, signature slots, and bounded Pyth-refresh slots are sealed before review.
- Execution-time plugin processing receives only the sealed raw plan/configuration, and Lite accepts only the declared fresh Pyth payload and bounded fee difference.
- Reviewed simulations, the effect map, export, Tenderly, and normalized submission share one request digest. Internal metadata identifies each literal Pyth preview payload; the user-facing review remains unchanged and intentionally need not map one-to-one to that request set.
- The coordinator acquires one synchronous in-memory guard before any signature or wallet request, makes each adapter call once, and keeps the guard through SDK EOA receipt sequencing. Safe handoff preserves the pre-existing `useSafeExecutionDetachment` status watcher and confirmation gate until its current-session lifecycle terminates.
- The exact finalized EOA request or complete Safe transport envelope is compared with the accepted request set immediately before the wallet call.
- The EOA adapter dispatches only through SDK `executeMaterialized` and proves that every SDK hook and wallet call receives either the byte-static reviewed pre-Pyth prefix or already-finalized reviewed bytes without recomposition.
- Inconclusive wallet/provider results are reported as status unknown, never as success, and never trigger an automatic retry.
- IndexedDB, persistent reviewed execution/attempt state, durable wallet lanes, cross-tab reservations, recovery/reconciliation services, durable resumable attempts, and root recovery UI are absent. The pre-existing in-memory Safe detachment mechanism remains present and unchanged after handoff.
- Reload starts from fresh protocol, allowance, migration-authorization, wallet, and Safe state and requires a newly prepared and accepted reviewed execution.
- Normal migration execution includes and displays the SDK-provided authorization revocation/restoration. If core or revocation submission is interrupted, rejected, failed, or unknown, no cleanup obligation is persisted, the UI warns when authorization may remain, and the existing authorization cannot block a fresh migration attempt.
- Every applicable Apex item in the section 4 reconciliation has a direct Lite test, an SDK integration test, a revised requirement test, or an explicit canceled/absent disposition.
- All relevant #810 and #781-#784 traps have discriminating regressions.
- Every operation-specific and batch review passes the strict pre-refactor rendered-output compatibility suite, with no new generic reviewed execution fields and no visible Pyth data or refresh notice.
- `docs/transaction-building.md`, `docs/README.md`, root `AGENTS.md`, and the central review-binding comment document and link the user-facing review compatibility contract.
- Every production form with Add to batch is present in the performance registry and passes the exhaustive less-than-100-ms click-to-visible gate; no representative sampling or missing-form waiver is permitted.
- Eager form preparation and exact whole-cart background preparation remain active, use context-complete cache identities, and are adopted by Review without redundant expensive work when unchanged and fresh.
- Full build, lint, typecheck, Vitest, golden, parity, fork execution, model, failure-injection, and focused browser submission-interaction tests pass.
- Fresh stack, business, security, and deep call-stack review agents report no blocking findings on the same exact head.
- Any review-driven fix is followed by a full rerun with new fresh agents.
- Only then is the single PR marked ready for human review and merge.
