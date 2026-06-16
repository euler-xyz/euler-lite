# Handoff spec: Migrate tab (Portfolio)

## Overview

A new fourth tab — **Migrate** — added to the Portfolio view after `Positions`, `Deposits`, `Rewards`. It surfaces the connected wallet's open positions on **Aave v3** and **Morpho** that can be moved into Euler, and lets the user migrate each one (collateral + debt together) in a single transaction.

Scope of this spec: the tab trigger, the list view, and per-row states. The migration confirm/preview drawer is a separate flow (noted under Out of scope).

User context: a borrower or lender with existing positions elsewhere. The tab is an acquisition surface, so its presence is conditional — it should never show an empty shell to users who have nothing to migrate.

---

## Layout

Reuses the existing Portfolio container and tab bar. No new page chrome.

- Same max content width and horizontal padding as the other Portfolio tabs.
- Tab content: a section header + subhead, a column-header row, then a vertical stack of position rows.
- Row grid (desktop): four columns — `Source | Collateral | Debt | Action` at `140px 1fr 1fr 110px`, `column-gap: spacing-md`, vertically centered.
- Row vertical gap: `spacing-sm`.

---

## Design tokens used

Map these to the existing Euler token set; hex values are the observed app values for reference only — **use tokens, not raw hex**.

| Token | Value (ref) | Usage |
|-------|-------------|-------|
| `color-bg-page` | `#0A0E14` | Portfolio background |
| `color-bg-surface` | `#0F1620` | Position row background |
| `color-border-subtle` | `rgba(255,255,255,0.06)` | Row border |
| `color-border-divider` | `rgba(255,255,255,0.08)` | Tab bar underline |
| `color-text-primary` | `#E6EAF0` | Asset amounts, active tab |
| `color-text-secondary` | `#8A94A3` | Subhead, labels |
| `color-text-muted` | `#727C8A` | USD values, inactive tabs, "Rescan" |
| `color-text-disabled` | `#5A636F` | "Supply only" / no-debt placeholder |
| `color-accent` | `#5CCB9C` | Migrate button fill, active-tab icon |
| `color-accent-text` | `#08291C` | Text on Migrate button |
| `color-positive` | `#4ADE9E` | Active tab underline, accent badge text |
| `color-accent-badge-bg` | `rgba(94,203,156,0.15)` | Migrate tab count badge |
| `color-badge-bg` | `#1A2230` | Neutral count badges |
| `radius-row` | `11px` | Position rows |
| `radius-button` | `8px` | Migrate button |
| `radius-pill` | `20px` | Count badges |
| `font-section-title` | `16–17px / 500` | "Migrate to Euler" header |
| `font-body` | `13px / 400` | Row content |
| `font-label` | `11px / 400` | Column headers, USD values |

Source brand colors (logos preferred over solid dots in production): Aave `#B6509E`, Morpho `#2C5BE0`. Token marks should use real asset icons from the existing icon set, not letter circles (those are mockup placeholders).

---

## Components

| Component | Variant | Props | Notes |
|-----------|---------|-------|-------|
| `NavTab` | active / inactive | `label`, `count`, `icon?`, `accent?` | New instance: label "Migrate", leading `arrow-bar-to-down` icon, accent count badge. Reuse existing tab component. |
| `CountBadge` | neutral / accent | `count` | Accent variant for Migrate (mint bg, positive text); neutral elsewhere. |
| `MigrateRow` | borrow / supply-only | `source`, `collateral[]`, `debt[] \| null`, `onMigrate` | `supply-only` renders debt cell as disabled placeholder. |
| `AssetCell` | — | `icon`, `amount`, `symbol`, `usdValue` | Amount on top line, USD value muted below. |
| `SourceBadge` | aave / morpho | `protocol` | Logo + name. |
| `Button` | primary | `label`, `loading`, `disabled` | Migrate CTA, full row-column width. |

---

## States and interactions

| Element | State | Behavior |
|---------|-------|----------|
| Migrate tab | inactive | Muted label + count; standard tab hover (text → primary). |
| Migrate tab | active | Primary text, `color-positive` underline, accent icon. |
| Migrate tab | zero positions | **Hide the tab entirely** (do not render "0"). See edge cases. |
| Migrate tab | scanning (no cached result) | Show tab with a small spinner in place of the count until first scan resolves. |
| Position row | default | Surface bg, subtle border. |
| Position row | hover | Border steps up to `color-border-divider`; cursor default (row itself not clickable in v1). |
| Migrate button | default | `color-accent` fill, `color-accent-text` label. |
| Migrate button | hover | Darken fill ~8%. |
| Migrate button | active | `scale(0.98)`. |
| Migrate button | loading | Inline spinner, label hidden, button disabled while the migrate tx/preview is being prepared. |
| Migrate button | disabled | Reduced opacity; used when a position is temporarily not migratable (e.g. unsupported asset, see edge cases) with a tooltip explaining why. |
| Rescan | click | Re-query Aave/Morpho; icon spins; list re-renders. Debounce to avoid rapid re-scans. |

Out of scope here: clicking Migrate opens the confirm/preview drawer (target market, resulting health factor, approvals, gas). Spec that separately.

---

## Responsive behavior

| Breakpoint | Changes |
|------------|---------|
| Desktop (>1024px) | Four-column grid `140px 1fr 1fr 110px`. |
| Tablet (768–1024px) | Same grid; allow Source column to shrink (logo + truncated name). |
| Mobile (<768px) | Collapse to a stacked card per position: Source badge on top row; Collateral and Debt as labeled rows; Migrate button full-width at the bottom. Column-header row is hidden — each value gets an inline label. |

---

## Edge cases

- **Zero positions found**: hide the Migrate tab completely. If discovery hasn't run yet, keep it hidden until the first scan returns ≥1 result. Do not show an empty-state screen behind a visible tab.
- **Supply-only position** (no debt): Debt cell shows `— Supply only` in `color-text-disabled`. Migrate still enabled (supply migrates alone).
- **Multi-asset collateral or debt**: stack up to 2 asset rows in the cell; beyond that show the first asset + "+N more" with the full list in the confirm drawer.
- **Dust / sub-cent value**: show `<$0.01` rather than `$0.00`, matching the existing Positions card convention.
- **Unsupported asset on Euler** (no matching market): disable Migrate for that row with a tooltip — "No Euler market for this asset yet."
- **Long token symbols / large amounts**: amounts truncate with ellipsis before the USD value wraps; never wrap the Migrate button.
- **Discovery failure** (RPC/subgraph error): show a single inline error row with a Retry action; do not hide the tab if it was already shown.
- **Stale data**: timestamp or "Rescan" affordance; re-scan on tab focus.
- **Wrong/native network**: positions are per-chain; only show positions for the active network, consistent with the rest of Portfolio.

---

## Loading states

- **Tab badge**: spinner until first scan resolves.
- **List**: 2–3 skeleton rows (matching row height) while scanning.
- **Per-row migrate**: button-level spinner; row stays in place.

---

## Animation / motion

| Element | Trigger | Animation | Duration | Easing |
|---------|---------|-----------|----------|--------|
| Tab content | tab switch | Fade/slide in, matching existing Portfolio tab transition | ~150ms | ease-out |
| Rescan icon | click | Rotate 360° while fetching | ~600ms loop | linear |
| Migrate button | press | Scale to 0.98 | ~100ms | ease-out |
| Row removal | successful migrate | Row collapses/fades out; tab count decrements | ~200ms | ease-in-out |

---

## Accessibility

- Tab uses existing `role="tab"` / `aria-selected` semantics; the new tab joins the same `tablist`. Tab panel gets `role="tabpanel"` with `aria-labelledby` pointing at the tab.
- Count badge announced as part of the tab name, e.g. `aria-label="Migrate, 3 positions available"`.
- Decorative icons (`arrow-bar-to-down`, source dots in mockup) are `aria-hidden`; production source logos need `alt`/`aria-label` with the protocol name.
- Each row is a labeled group: announce source, collateral asset + amount, debt asset + amount (or "supply only"), so a screen-reader user gets the full row before reaching the button.
- Migrate button needs a descriptive label, not just "Migrate" — e.g. `aria-label="Migrate Aave v3 wstETH collateral and USDC debt to Euler"`.
- Focus order: tab → Rescan → each row's Migrate button, top to bottom.
- Keyboard: tab bar arrow-key navigation (existing pattern); Migrate button activates on Enter/Space.
- Loading: announce "Scanning Aave and Morpho" and result count via an `aria-live="polite"` region.
- Color is never the only signal — "Supply only" carries the meaning in text, not just the muted color.

---

## Implementation notes

- Reuse the existing tab, badge, asset-cell, and button components rather than building new ones; the only genuinely new piece is `MigrateRow` and the discovery/data layer.
- Discovery (which Aave/Morpho positions exist for the wallet, and whether a matching Euler market exists) should run once on Portfolio load and cache, so the tab's visibility and count are ready without a click.
- Keep raw on-chain amounts separate from display formatting; reuse the Portfolio number-formatting helpers for `$` values and the `<$0.01` rule.

## Out of scope (spec separately)

- Migrate confirm/preview drawer: target Euler market selection, resulting LTV/health factor, token approvals, gas estimate, success/failure handling.
- Bulk "Migrate all" action.
