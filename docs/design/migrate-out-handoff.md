# Handoff spec: Migrate position out

Companion mockup: `migrate-out-mockup.html`
Target route: `pages/position/[number]/migrate.vue` (direction `euler-to-external`)

## Overview

A full page, reached from a Portfolio position (the position card links here), for moving a single Euler borrow position — its collateral **and** debt together — to a compatible external market (Aave v3, Morpho) in one transaction.

The page has two parts stacked vertically:

1. **The position being migrated** — rendered with the existing Positions-list card so the user confirms exactly what they're moving.
2. **A list of target markets** — a filterable table (Lend-page pattern) of compatible external markets, each row showing the asset pair, protocol + market, total liquidity, and per-row **Migrate** / **Add to batch** actions.

This replaces the previous single-select target list + summary-grid layout in `migrate.vue` with a per-row action table, so there is no global "Review migration" footer — the action lives on each target row.

User context: a borrower with an open Euler position who wants to exit to another protocol. Targets are discovered per chain via the SDK (`listMigrationTargets`, `direction: 'euler-to-external'`) and filtered to markets that match the source collateral + debt assets.

---

## Layout

Reuses the standard page section container from `migrate.vue` (`BackButton` + `h1`). Content is a single column, max width ~`1080px`, horizontal padding `24px`.

- **Page header**: back button (returns to `/position/{n}`) + title "Migrate position" (`text-p1`).
- **Position card**: the full-width `PortfolioBorrowItem` card for the source position.
- **"Migrate to" divider**: centered chip on a hairline rule, with a downward arrow icon.
- **Section header**: "Choose a target market" (`text-h4`) + one-line description (`text-p3`, `content-tertiary`).
- **Filter bar**: a single `Target protocol` multi-select (`UiSelect`), left-aligned.
- **Targets table**: vertical stack of target rows, `10px` gap. No column-header row.

Target row grid (desktop): three columns — `pair+protocol | total liquidity | actions` at `1.6fr 1fr 232px`, `gap: spacing-16`, vertically centered.

---

## Design tokens used

All values are the dark-theme tokens from `assets/styles/variables.scss` (`[data-theme="dark"]`) and `components/ui/styles/main.scss`. **Use tokens / Tailwind classes, not raw hex.**

| Token (CSS var / Tailwind) | Value (dark) | Usage |
|----------------------------|--------------|-------|
| `--bg-body` / `bg-body` | `#08131f` | Page background |
| `--bg-card` / `bg-card` | `#0c1d2f` | Position card, target rows |
| `--bg-surface-secondary` | `#0c1d2f` | Position index chip, market pill |
| `--bg-surface-elevated` | `#10263e` | Secondary button fill, LTV bar track |
| `--border-subtle` | `rgba(255,255,255,0.06)` | Card / row border |
| `--border-default` / `border-line-default` | `#14304e` | Chip / pill / divider borders, secondary button border |
| `--border-emphasis` / `border-line-emphasis` | `#435971` | Row hover border, secondary button hover border |
| `--text-primary` / `text-content-primary` | `#f7f7f8` | Amounts, pair symbols, title |
| `--text-secondary` | `#ddfbf4` | Secondary button label, market pill text |
| `--text-tertiary` / `text-content-tertiary` | `#a1acb8` | Labels, protocol name, descriptions |
| `--text-muted` / `text-content-muted` | `#728395` | "—" placeholders, footnote |
| `--accent-600` | `#23c09b` | Primary button fill, positive Net APY |
| `--accent-700` | `#2ae5b9` | Primary button hover fill |
| `#020508` | `#020508` | Primary button label (`--ui-button-primary-color`, dark) |
| `--shadow-card` / `shadow-card` | `--shadow-sm` | Card / row resting shadow |
| `--shadow-card-hover` | `--shadow-md` | Row hover shadow |
| radius `12` / `rounded-12` | `12px` | Cards and rows |
| button radius | `10px` | `UiButton` corner radius |
| radius `8` / `rounded-8` | `8px` | Position index chip, market pill |
| radius full | `9999px` | Back button, filter pill |
| `text-p1` | `24/32, 400` | Page title |
| `text-h4` | `18/24, 600` | Section header |
| `text-h5` | `16/20, 600` | Pair symbols, position symbols |
| `text-p2` | `16/20, 400` | Stat values, liquidity value |
| `text-p3` | `14/20, 400` | Labels, protocol name |

---

## Components

| Component | Variant | Props / notes |
|-----------|---------|---------------|
| `BackButton` | — | `fallback="/position/{n}"`, `always-fallback`. Existing component. |
| `PortfolioBorrowItem` | — | Renders the source position card. Pass the `PortfolioBorrowPosition`. **Disable the `NuxtLink` wrapper** here (it normally links to the position) — on this page the card is informational, not clickable. |
| `AssetAvatar` | pair | `:asset="[collateral.asset, debt.asset]"`, `size="40"` on the position card, `size="28"` on target rows. Existing component — use real asset icons, not letter circles (those are mockup placeholders). |
| `UiSelect` | multi | The `Target protocol` filter. `placeholder="Target protocol"`, `icon="..."`, options built from the protocols present in the discovered targets (e.g. Aave v3, Morpho). Same component the Lend page uses for Market/Asset. |
| Market pill | — | Inline tag next to the protocol name (Aave `Core` / `Prime`). Reuse the existing tag style: `bg-surface-secondary`, `border-line-default`, `rounded-8`, `text-p3`. Omit entirely for protocols without a market concept (Morpho). |
| `UiButton` | `primary` | "Migrate" — opens the review modal (`OperationReviewModal`) for this target. `size="medium"`. |
| `UiButton` | `secondary` | "Add to batch" — adds the migration to the tx batch. `size="medium"`. |

Note: do **not** apply the `rounded` prop to the row buttons — in `UiButton`, `rounded` means `width: 100%` (used for the full-width stacked CTAs elsewhere), not round corners. Row buttons are auto-width.

---

## States and interactions

| Element | State | Behavior |
|---------|-------|----------|
| Target row | default | `bg-card`, `border-subtle`, `shadow-card`. |
| Target row | hover | Border → `border-emphasis`, shadow → `shadow-card-hover`. Row itself is not clickable. |
| Migrate button | default | `accent-600` fill, `#020508` label. |
| Migrate button | hover | Fill → `accent-700`. |
| Migrate button | active | `scale(0.98)`. |
| Migrate button | loading | Inline spinner, label hidden, disabled while the plan/simulation is prepared (`isPreparing`/`isSubmitting`). |
| Migrate button | disabled | `opacity: 0.6`, pointer-events none. Disable per the existing `disabledReason` logic (advanced mode off, wallet not connected, spy mode, geo-blocked, target unhealthy, simulation error). Surface the reason via `title`/tooltip. |
| Add to batch button | loading | Inline spinner while preparing the batch entry. |
| Target protocol filter | default | `UiSelect` pill; shows selected count badge when active (accent badge). |
| Target protocol filter | empty selection | Shows all discovered protocols. |

The per-row Migrate flow mirrors `reviewMigration()` (opens `OperationReviewModal` with `type: 'migration'`, signature + display steps); Add to batch mirrors `addMigrationToBatch()`. Both build `buildMigrationInput()` scoped to that target.

---

## Responsive behavior

| Breakpoint | Changes |
|------------|---------|
| Desktop (`laptop`, ≥901px) | Three-column target rows `1.6fr 1fr 232px`. Position card metrics inline. |
| Tablet (≥1300px) | Same as desktop; back button floats to the left of the section per `migrate.vue`. |
| Mobile (`mobile`, ≤900px) | Target row collapses to a stacked card: pair + protocol on the top row (full width), liquidity as a labeled row, buttons full-width side-by-side at the bottom (`flex: 1` each). Position card uses its existing mobile stack. |

---

## Edge cases

- **No targets found**: show the existing warning alert — "No supported Aave v3 or Morpho market matches this collateral and debt asset pair." (`UiAlert variant="warning"`). Do not render an empty table.
- **Targets still loading**: show `BaseLoadableContent` / 2–3 skeleton rows at row height.
- **Discovery error**: inline `UiAlert variant="warning"` with the error message (`targetsError`); keep any already-loaded rows.
- **Supply-only position (no debt)**: page is intended for borrow positions; if `currentDebt <= 0` show the existing disabled reason "This position has no debt to migrate out."
- **Unhealthy target** (resulting health ≤ 1): disable that row's Migrate with reason "`{protocol}` target would be unhealthy"; render the reason as an error-tone tooltip.
- **Long pair symbols**: pair symbol truncates with ellipsis; never wrap the action buttons.
- **Dust / sub-cent value**: liquidity shows `<$0.01` rather than `$0.00`, matching the Positions card convention.
- **Wrong network**: targets are per-chain; re-query on `chainId` change (existing `loadTargets` watch).

---

## Loading states

- **Position card**: full-section `UiLoader` while `isPositionsLoading` (existing).
- **Targets list**: skeleton rows while `isTargetsLoading`.
- **Per-row action**: button-level spinner; row stays in place.

---

## Animation / motion

| Element | Trigger | Animation | Duration | Easing |
|---------|---------|-----------|----------|--------|
| Target row | hover | Border + shadow step up | 200ms | `cubic-bezier(0.4,0,0.2,1)` |
| Migrate button | press | Scale to 0.98 | ~100ms | ease-out |
| Migrate button | hover | Fill `accent-600` → `accent-700` | 200ms | `cubic-bezier(0.4,0,0.2,1)` |
| Row removal | successful migrate | Redirect to `/portfolio` after ~400ms (existing post-migrate behavior) | — | — |

---

## Accessibility

- Page title `Migrate position` is the `h1`; section header is an `h2`.
- The source position card is informational here — expose it as a labeled group summarizing pair, collateral value, debt, health, and LTV; remove the link role since it no longer navigates.
- Each target row is a labeled group announcing protocol + market, asset pair, and total liquidity before its actions.
- Migrate button needs a descriptive label, e.g. `aria-label="Migrate wstETH/USDC position to Aave v3 Core"`; same pattern for Add to batch.
- `Target protocol` filter keeps `UiSelect`'s existing combobox semantics and keyboard support.
- Focus order: back button → Target protocol filter → each row (Migrate, then Add to batch), top to bottom.
- Decorative icons (divider arrow, info icon) are `aria-hidden`. Protocol/asset logos need `alt`/`aria-label` with the name.
- Disabled Migrate buttons keep their tooltip reason available to assistive tech (don't rely on color alone).

---

## Implementation notes

- Build on the existing `migrate.vue` data layer: `listMigrationTargets`, `buildMigrationInput`, `reviewMigration`, `addMigrationToBatch`, `disabledReason`, `canReview`/`canAddToBatch`. The change is presentational — move the action from a single footer pair to per-row buttons, scoping each to its target.
- Reuse `PortfolioBorrowItem`, `AssetAvatar`, `UiSelect`, `UiButton`, and the tag/pill styles rather than building new components; the only new piece is the target-row layout.
- Keep raw on-chain amounts separate from display formatting; reuse `formatCompactUsdValue`, `formatVaultAmount`, and the `<$0.01` rule.
- Markets/protocols for the filter are derived from the discovered targets, not a hardcoded list.

## Out of scope (spec separately)

- The migration review/confirm modal (`OperationReviewModal`): target market detail, resulting LTV/health, signature + approval steps, gas, success/failure handling.
- Multi-collateral positions: collateral selection UI (the source card may show "& others").
