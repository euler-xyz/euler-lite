# Handoff Spec: Batch Review Modal (`BatchReviewModal.vue`)

> Target audience: Claude Code (or any dev) implementing the **Review batch** modal so it
> matches the approved design. The component already exists at
> `components/BatchReviewModal.vue`; this spec defines the intended end state and the gaps
> to close. Stack: Nuxt 3 + Vue 3 `<script setup>` + Tailwind with the project's custom
> token config (`tailwind.config.js` + `assets/styles/variables.scss`).

## Overview

The modal opens from the **Review batch** button in the floating batch drawer
(`BatchDrawer` → `BatchContents`) and the mobile batch page (`pages/batch.vue`). It is the
final review surface before executing a queued transaction batch as one atomic EVC
transaction. It must show, in order:

1. **Approvals needed** (only when the prepared plan requires any) — the token approvals /
   permit2 signatures the user will be asked to sign.
2. **Operations** — each queued op as a row that **rolls down** to reveal that op's details.
3. **Wallet changes** — the net effect of the whole batch on the wallet.
4. **Execute batch** — execute the reviewed ceremony, with a disabled reason when it can't run.

It is opened via `useModal().open(BatchReviewModal)` and dismisses by emitting `close`.

## ⚠️ Critical token gotcha (caused the "white borders" bug)

This codebase has **no `DEFAULT` key** for the `line` border color — `tailwind.config.js`
defines `line: { default, subtle, emphasis }`. Therefore:

- `border-line` / `bg-line` / `divide-line` **do not exist** → they fall back to
  `currentColor` (near-white text) and render as **white borders**.
- Always use the suffixed classes: **`border-line-default`**, `border-line-subtle`,
  `border-line-emphasis`, `divide-line-default`, `bg-line-default`.

Do not use opacity modifiers on the `line` colors either; use a real shade.

## Design tokens

All colors are CSS variables that flip with theme; reference them via the Tailwind classes
below (never hardcode hex). Values shown are the **dark theme** for reference only.

| Token (Tailwind class) | Dark value | Usage |
|---|---|---|
| `bg-card` | `#0c1d2f` | Modal body (provided by `BaseModalWrapper`) |
| `bg-surface-secondary` | `#0c1d2f` | Approvals container, wallet-changes block |
| `bg-surface-elevated` | `#10263e` | (optional) raised insets |
| `border-line-default` | `#14304e` | All dividers, collapsed row borders, section rules |
| `bg-accent-100` | `#0a3d30` | Subtle accent fills (secondary button bg) |
| `border-accent-600` / `text-accent-500` | `#23c09b` / `#2ae5b9` | Open-row border, accent text, number nodes |
| `text-content-primary` | `#f7f7f8` | Primary labels (op title, amounts) |
| `text-content-secondary` | `#ddfbf4` | Secondary text (asset symbol, position tag) |
| `text-content-tertiary` | `#a1acb8` | Section labels, muted meta, disabled reason |
| `text-error-500` / `bg-error-100` | `#c02723` / `rgba(192,39,35,.2)` | Revert chip text / fill |
| Radius `rounded-8` / `rounded-12` / `rounded-16` | 8 / 12 / 16px | Rows / cards / modal |
| Type `text-p2` / `text-p3` / `text-h6` | 16/400, 14/400, 14/600 | Body / meta / row title |

Numeric values use `tabular-nums`.

## Layout

`BaseModalWrapper` provides the modal chrome (centered title, close affordance, drag/scroll,
width). Pass `title="Review batch"`. Body content is a single vertical stack:

```
<BaseModalWrapper title="Review batch" @close="!isExecuting && emit('close')">
  <div class="flex flex-col gap-20">  <!-- section rhythm: 20px -->
    [Approvals needed]      v-if approvals.length
    [Operations]            always (≥1 entry)
    [Wallet changes]        v-if walletChanges.length
    [Top-level batch error] v-if simError || execError
    [Execute + reason]      always
  </div>
</BaseModalWrapper>
```

Section label pattern: `text-p3 text-content-tertiary mb-8` (e.g. "Approvals needed",
"Operations", "Wallet changes").

## Components & data sources

All data comes from `useTxBatch()`. The composable already exposes everything needed:

| Binding | Type | Use |
|---|---|---|
| `entries` | `BatchEntry[]` | The operation rows |
| `layers` | `BatchLayer[]` | `layers[i+1].failed` / `.error` → per-entry revert state |
| `walletChanges` | `{token,symbol,decimals,delta}[]` | Wallet changes block (already computed from the final layer, so it shows in both eye-toggle states) |
| `simError` / `execError` | `string?` | Top-level batch error row |
| `isExecuting` / `isSimulating` | `boolean` | Button loading / disabled |
| `canExecuteBatch` / `hasFailedOps` / `hasInsufficientBalance` | `boolean` | Execute gating + reason |
| `executeBatch()` | `() => Promise` | Atomic execute (clears batch on success) |
| `prepareBatchPlan()` | `() => Promise<TransactionPlanPrepared\|null>` | Resolve approvals for the approvals section |
| `getMergedPlan()` | `() => TransactionPlan\|null` | The exact plan that will execute |

`BatchEntry` (see `composables/useTxBatch.ts`) carries:
`label`, `review?` (`{ type, asset:{symbol}, amount, swapToAsset:{symbol} }`), and
`subAccount?: Address`.

Owner address for the position tag: `isSpyMode ? spyAddress : walletAddress`.

### Operation verb mapping (`review.type` → verb)
`supply→Deposit, withdraw→Withdraw, borrow→Borrow, repay→Repay,
swap|swap-supply|swap-withdraw|swap-borrow→Swap, transfer→Transfer,
reward|brevis-reward|fuul-reward→Claim, reul-unlock→Unlock,
disableCollateral→Disable collateral`. Fallback to `entry.label` when `review` is absent.

### Position tag
`getSubAccountId(getAddress(owner), getAddress(entry.subAccount))` → `Position {n}`. Render
the tag only when `entry.subAccount && owner` resolve; fresh-position deposits (lend/earn)
have no `subAccount` and **correctly show no tag**. Tag style (matches Portfolio):
`text-h6 text-content-secondary bg-card py-2 px-8 rounded-8 border border-line-default`.

### Approvals section
On mount call `prepareBatchPlan()`. Iterate `prepared.plan` where `item.type ===
'requiredApproval'`; for each `item.resolved[]`: `r.type === 'approve'` → "Approve {symbol}"
(label suffix "bundled in batch"), otherwise permit2 → "Sign permit2 — {symbol}" (suffix "1
signature"). Resolve `r.token` → symbol via `useTokenSymbolResolver().resolveSymbol(token,
buildKnownSymbols())`. Container: `bg-surface-secondary rounded-12 px-12 divide-y
divide-line-default`; rows `py-10`, icon + label `text-p3 text-content-secondary`, suffix
`text-p3 text-content-tertiary`.

## Operation row (the roll-down)

```
<div class="rounded-8 border bg-surface-secondary overflow-hidden transition-colors"
     :class="open ? 'border-accent-600' : 'border-line-default'">
  <button class="flex items-center justify-between gap-8 w-full px-12 py-11 text-left" @click="toggle">
    <span class="flex items-center gap-8 min-w-0">
      <span class="...20px number node...">  <!-- teal ring; red + warning icon if failed -->
      <span class="text-p2 text-content-primary truncate">Withdraw <span class="text-content-secondary">USDC</span></span>
      <span class="...Position tag...">       <!-- if subAccount -->
    </span>
    <SvgIcon name="arrow-down" :class="{ 'rotate-180': open }" />
  </button>

  <div v-if="open" class="px-12 pb-12 pt-2 border-t border-line-default">
    [detail key/value rows]
    [revert chip if layers[i+1].failed]
  </div>
</div>
```

- **First row expands on open** (`openId` set to `entries[0].id` in `onMounted`). One row
  open at a time (accordion).
- Number node: `w-20 h-20 rounded-full text-p3 border`, default
  `bg-card border-accent-600 text-accent-500`; **failed** → `bg-error-100 border-error-500
  text-error-500` with a `warning` icon instead of the index.
- Rows stack with `gap-8`.

### Detail rows (the gap to close vs the design)
The approved mockup shows a **richer** detail table than the current build. Each detail row:
`flex items-center justify-between py-4 text-p3`, label `text-content-tertiary`, value
`text-content-primary` (`tabular-nums` for numbers). Target fields per op, in this order:

| Field | Source | Notes |
|---|---|---|
| Amount | `review.amount` + `review.asset.symbol` | always when amount present |
| Receive | `review.swapToAsset.symbol` | swap ops only |
| Vault | vault display name | **MISSING today** — source from the vault registry by the op's vault; see `useVaultRegistry`/`VaultDisplayName` |
| Supply/Borrow APY | per-op APY | **MISSING today** — optional; show if cheaply available |
| Health after | `layers[i+1]` account health vs `layers[i]` | **MISSING today** — optional; nice-to-have |
| Position | the `Position {n}` tag value | when `subAccount` present |

Current implementation only renders Amount / Receive / Position. Closing the gap means
adding Vault (and optionally APY / Health after) sourced from the simulated `layers` and the
vault registry. If a field can't be resolved, omit the row (never render an empty value).

### Revert chip (failed op)
`mt-6 flex items-start gap-6 rounded-8 border border-error-500/35 bg-error-100 px-8 py-6
text-p3 text-error-500` with a `warning-circle` icon; text = `layers[i+1].error` fallback
"This operation would revert."

## Wallet changes
`bg-surface-secondary rounded-12 px-12 py-10`, label "Wallet changes" (`text-p3
text-content-tertiary mb-6`). One row per token: symbol left (`text-content-secondary`),
signed amount right (`tabular-nums`), positive `text-accent-500`, negative `text-error-500`.
Format `−`/`+` + `formatSmartAmount(formatUnits(abs, decimals))` + symbol.

## External simulation
Whole-batch Tenderly simulation is not exposed from this modal. The reviewed ceremony can
contain sequential authorization transactions, prepared plugin/approval/core calls, and
restorations. The single-transaction simulation endpoint cannot preserve that complete call
vector, so presenting its result as a whole-batch simulation would be misleading.

## States & interactions

| Element | State | Behavior |
|---|---|---|
| Operation row | default | collapsed, `border-line-default`, chevron down |
| Operation row | open | `border-accent-600`, chevron rotated 180°, detail visible; `transition-colors` |
| Operation row | failed | number node red + warning icon; persistent revert chip in detail |
| Modal | preparing (`prepareBatchPlan` in flight) | Execute button `:loading`; approvals fill in when resolved |
| Execute | enabled | `canExecuteBatch && !isSpyMode && !isExecuting && !isPreparing && !isSimulating` |
| Execute | disabled | show reason line below (see below) |
| Execute | executing | label "Executing…", `:loading`, modal not closeable (`@close` guarded by `isExecuting`) |
| Execute | success | `executeBatch` clears the cart → `emit('close')` when `entries.length === 0 && !execError` |
| Close (X) | click | `emit('close')` unless `isExecuting` |

Execute is `UiButton variant="primary" size="xlarge" rounded` full-width.

**Disabled reason** (`text-p3 text-content-tertiary text-center` under the button):
- spy mode → "Connect a wallet to execute — disabled in spy mode"
- `hasFailedOps` → "Resolve the reverting operation to execute"
- `hasInsufficientBalance` → "Not enough balance to execute this batch"
- `simError` → "This batch would revert — resolve the flagged error"

## Edge cases
- **No approvals** → hide the entire "Approvals needed" section (common for plain
  withdraws in spy mode).
- **No wallet changes** → hide the block.
- **Long asset symbol / op label** → row title `truncate`; never let it push the chevron.
- **Fresh-position deposit** → no `subAccount` → no Position tag (by design).
- **Many operations** → `BaseModalWrapper` handles scroll; do not add a nested scroll.
- **Spy mode** → everything renders; only Execute is disabled.
- **Cart edited during broadcast** → a same-wallet add while the execution is in flight
  makes the ceremony stale; on success only the executed entries are removed from the
  cart (the mid-flight addition survives and resimulates), instead of clearing everything.
- **Prerequisite drift** → non-signature migration entries re-derive their authorization
  requirement immediately before anything irreversible is sent; if the grant/revoke set no
  longer matches what was reviewed (an allowance granted or revoked elsewhere), execution
  aborts, the review is invalidated, and the error asks the user to reopen review.
- **Submitted but unconfirmed** → every wallet interaction during execution is classified
  by the plan step that produced it (prerequisite approval/plugin call vs. the value-moving
  batch transaction or Safe proposal). Replay protection *arms* before the value-moving
  step crosses the wallet boundary: an `armed` record is reserved atomically (check +
  reserve serialized per wallet/chain under a Web Lock, stamped with the attempt's id)
  and persisted durably before the wallet is invoked, upgraded to `submitted` when a
  transaction hash or Safe proposal id comes back, and released only when the wallet
  provably rejected the request (user rejection / connector error). Reservation writes
  are durable-or-abort: if the `localStorage` write fails or does not read back, the
  attempt aborts *before* the wallet is invoked (an in-realm memory copy still blocks
  same-session retries while storage stays broken), and an unreadable record fails
  closed rather than reading as empty. All upgrades and releases are ownership-checked
  against the reserving attempt's id, so a stale attempt can never release or overwrite
  a reservation a newer attempt holds. A wallet failure that returns no id — or a
  malformed transaction/bundle id — leaves the armed record standing, because acceptance
  cannot be disproved. A failure after an accepted *prerequisite* retries plainly —
  those steps are idempotent. Records live in `localStorage` keyed per flow, wallet, and
  chain (`utils/pendingSubmissions.ts`), so one wallet's quarantine never blocks or
  overwrites another's. Clearing the cart, switching wallets, or reloading does not drop
  a record. Before every Execute press the durable record is re-read (so a quarantine
  placed by another tab is enforced, and a `storage` event listener syncs already-open
  tabs), then verified on-chain — a landed submission retires its entries (or resets the
  cart when it landed mid-plan or the ceremony did not survive a reload), a
  reverted/cancelled one releases the retry, an unverifiable or still-armed one keeps
  the quarantine and explains why. An `armed` record orphaned by a reload has no id and
  can never verify on its own: the cart offers a risk-labelled manual release
  (`BatchContents.vue` → `releaseArmedQuarantineAfterManualCheck`) that only applies
  after the user confirms the wallet itself shows nothing pending, and refuses
  `submitted` records (those are verified on-chain instead). Once the core submission's
  receipt confirmed, a later failure (for example a revoke) retires the covered entries
  instead of quarantining. The direct migration pages (`migrate.vue`, `borrow/swap.vue`)
  apply the same arming and quarantine per flow via `utils/directSubmissionQuarantine.ts`,
  and the ordinary executors (`executePlan`, callback-less `executePreparedPlan`)
  quarantine value-moving submissions themselves under a shared `direct` flow — replay
  protection never depends on optional caller wiring. The quarantine is also enforced
  *across surfaces*: every wallet/signature boundary in `useEulerTx.ts` — the plan
  executors, standalone plain sends, and migration authorization grants — plus the CoW
  executor (`useCowSwapExecutionCore.ts`) runs `utils/pendingSubmissionGate.ts` before
  anything reaches a wallet, so an unresolved batch submission blocks an equivalent
  direct operation for that wallet/chain (and vice versa); a landed batch record
  discovered from another surface is retired through a handler the cart registers. Two
  deliberate, strictly risk-reducing bypasses: migration authorization *revokes* (they
  run during abort cleanup — blocking them would leave live grants behind) and CoW order
  *cancellation* (it only invalidates a standing order).

## Accessibility
- Row header is a real `<button>`; expose `aria-expanded` bound to the open state and
  `aria-controls` pointing at the detail region id.
- Focus order: close → (approvals are static text) → operation row buttons in order → Execute.
- Revert chips are persistent text (not hover-only) so they're announced.
- Icon-only controls (close, chevrons) need `aria-label` / `title`.

## Files
- `components/BatchReviewModal.vue` — the modal (exists; extend detail fields per the gap).
- `composables/useTxBatch.ts` — ceremony preparation, review data, and execution.
- `components/BatchContents.vue` — opens the modal via the "Review batch" button.
- Reference for tokens/patterns: `components/entities/portfolio/PortfolioBorrowItem.vue`
  (position tag), `components/entities/operation/OperationReviewModal.vue` (approvals
  decode and `UiButton` usage), `assets/styles/variables.scss` (token values).

## Definition of done
- Borders/dividers use `*-line-default` (no white borders anywhere).
- Sections render in the specified order with the specified labels and spacing.
- Operation rows roll down; first row open by default; detail includes at least Amount +
  Vault (+ Receive for swaps, + Position when applicable).
- Approvals appear only when the prepared plan requires them, with resolved token symbols.
- Wallet changes and the gated Execute (with reason) behave per the tables.
- Spy-mode, revert, preparing, and success states all verified live in the running app.
