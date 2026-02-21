# UI Reskin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reskin the Euler Lite UI to feel sharper and more fintech-modern — cooler backgrounds, harder borders, richer gold, tighter radius (max 6px), tighter typography tracking — without touching any logic or component APIs.

**Architecture:** All token changes live in `assets/styles/variables.scss` and `components/ui/styles/main.scss`, which cascade throughout the app via CSS custom properties. A handful of component files need targeted class or hardcoded-value fixes where inline styles or class names override tokens. No JS/TS changes anywhere.

**Tech Stack:** Nuxt 3, Vue 3, Tailwind CSS (with CSS variable–based theme tokens), SCSS

---

## How to verify your changes

Run the dev server in a terminal and keep it open throughout:

```bash
npm run dev
```

Then open `http://localhost:3000` in a browser. After each task, visually verify the relevant page. There is no automated visual test suite — your eyes are the test.

Key pages to check:
- `/earn` — vault list (main card treatment)
- `/borrow` — borrow list
- `/portfolio` — stat cards and position rows
- Header nav — active item treatment
- Any form/input — focus ring and border

---

## Task 1: Update global color, border, shadow, and radius tokens

**Files:**
- Modify: `assets/styles/variables.scss`

The entire design cascades from here. Make all changes in one edit.

**Step 1: Update the token values**

In `assets/styles/variables.scss`, find and replace the following values. Changes are in the `:root` block and the `[data-theme="dark"]` block.

In **`:root`**:

```scss
// Accent - richer, more saturated amber-gold
--accent-300: #f5e09a;   // was #e8d5b7
--accent-400: #d4a820;   // was #d4a574
--accent-500: #c8960c;   // was #c49b64
--accent-600: #b07d0a;   // was #a88347
--accent-700: #8b6414;   // was #8b6914

// Border radius — 6px ceiling
--radius-sm: 4px;   // was 6px
--radius-md: 6px;   // was 8px
--radius-lg: 6px;   // was 10px
--radius-xl: 6px;   // was 12px
--radius-2xl: 6px;  // was 16px

// Shadow system — strip card shadows
--shadow-card: none;
--shadow-card-hover: 0 2px 8px rgba(0, 0, 0, 0.08);
```

In the second **`:root`** block (semantic theme variables):

```scss
// Backgrounds — cooler, crisper
--bg-body: #f3f3f3;                    // was var(--neutral-50) = #fafafa
--bg-surface-secondary: #efefef;       // was var(--neutral-50) = #fafafa
--bg-header: rgba(255, 255, 255, 0.90); // was rgba(255,255,255,0.85)

// Borders — harder edges
--border-default: #d4d4d4;             // was var(--neutral-200) = #e5e5e5
--border-subtle: rgba(0, 0, 0, 0.10); // was rgba(0, 0, 0, 0.06)
--border-emphasis: #b5b5b5;           // was var(--neutral-300) = #d4d4d4
```

In **`[data-theme="dark"]`**:

```scss
// Borders — sharpen dark mode borders
--border-default: #333333;            // was #262626
--border-subtle: rgba(255, 255, 255, 0.10); // was rgba(255,255,255,0.06)
--border-emphasis: #444444;           // was #404040
```

**Step 2: Verify in browser**

Check `/earn`. Cards should now have no box shadow — they float on the `#f3f3f3` body alone. Borders should be crisper/darker than before. The page should feel noticeably sharper.

**Step 3: Commit**

```bash
git add assets/styles/variables.scss
git commit -m "design: sharpen color, border, shadow, and radius tokens"
```

---

## Task 2: Update Tailwind border-radius config

**Files:**
- Modify: `tailwind.config.js`

Tailwind's `borderRadius` config uses hardcoded pixel values (e.g. `rounded-8`, `rounded-12`, `rounded-16`) that override the CSS variables. Bring them in line with the 6px ceiling.

**Step 1: Update borderRadius values**

In `tailwind.config.js`, find the `borderRadius` section inside `theme.extend`:

```js
// Before:
borderRadius: {
  8: '8px',
  12: '12px',
  16: '16px',
},

// After:
borderRadius: {
  8: '6px',
  12: '6px',
  16: '6px',
},
```

**Step 2: Verify in browser**

Any component using `rounded-8`, `rounded-12`, or `rounded-16` Tailwind classes will now render at 6px. Check the vault cards on `/earn` and the borrow list on `/borrow`.

**Step 3: Commit**

```bash
git add tailwind.config.js
git commit -m "design: cap Tailwind border-radius to 6px"
```

---

## Task 3: Update component-level CSS variables (buttons, inputs, gold references)

**Files:**
- Modify: `components/ui/styles/main.scss`

The component variables reference the old gold values by raw hex in several places. Update these to reference the new accent tokens or updated hex values.

**Step 1: Update input focus shadow and form field shadow**

Find these lines (around line 200–208):

```scss
// Before:
--ui-input-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), inset 0 1px 2px rgba(0, 0, 0, 0.02);
--ui-input-focus-shadow: 0 0 0 3px rgba(196, 155, 100, 0.15), 0 1px 2px rgba(0, 0, 0, 0.05);
--ui-input-error-shadow: 0 0 0 3px rgba(220, 38, 38, 0.1);
--ui-form-field-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), inset 0 1px 2px rgba(0, 0, 0, 0.02);
--ui-form-field-focus-shadow: 0 0 0 2px rgba(196, 155, 100, 0.2), 0 2px 4px rgba(0, 0, 0, 0.06);

// After:
--ui-input-shadow: none;
--ui-input-focus-shadow: 0 0 0 2px rgba(200, 150, 12, 0.25);
--ui-input-error-shadow: 0 0 0 2px rgba(220, 38, 38, 0.2);
--ui-form-field-shadow: none;
--ui-form-field-focus-shadow: 0 0 0 2px rgba(200, 150, 12, 0.2);
```

**Step 2: Update toast info colors for new gold**

Find the toast info variables (around line 152–156):

```scss
// Before:
--ui-toast-info-border-color: rgba(196, 155, 100, 0.3);
--ui-toast-info-background-color: rgba(196, 155, 100, 0.1);
--ui-toast-info-text-color: var(--accent-700);
--ui-toast-info-splitter-color: rgba(196, 155, 100, 0.3);
--ui-toast-info-action-background-color: rgba(196, 155, 100, 0.1);

// After:
--ui-toast-info-border-color: rgba(200, 150, 12, 0.3);
--ui-toast-info-background-color: rgba(200, 150, 12, 0.08);
--ui-toast-info-text-color: var(--accent-700);
--ui-toast-info-splitter-color: rgba(200, 150, 12, 0.3);
--ui-toast-info-action-background-color: rgba(200, 150, 12, 0.08);
```

**Step 3: Update secondary button to stroke-only on white**

Find the secondary button variables:

```scss
// Before:
--ui-button-secondary-background-color: var(--neutral-100);
--ui-button-secondary-border-color: var(--neutral-200);
--ui-button-secondary-hover-background-color: var(--neutral-200);
--ui-button-secondary-hover-border-color: var(--neutral-300);
--ui-button-secondary-active-background-color: var(--neutral-200);

// After:
--ui-button-secondary-background-color: #ffffff;
--ui-button-secondary-border-color: var(--border-default);
--ui-button-secondary-hover-background-color: var(--neutral-100);
--ui-button-secondary-hover-border-color: var(--border-emphasis);
--ui-button-secondary-active-background-color: var(--neutral-100);
```

**Step 4: Verify in browser**

- Check the wallet connect button (secondary variant) in the header — should be white with a harder border
- Check the search input on `/earn` — focus ring should be a crisp gold ring, no blur
- Trigger a toast if possible (or inspect via DevTools) to verify gold info toast uses new color

**Step 5: Commit**

```bash
git add components/ui/styles/main.scss
git commit -m "design: update component token values for sharper inputs, buttons, and gold"
```

---

## Task 4: Update typography — heading tracking and tabular numerals

**Files:**
- Modify: `assets/styles/main.scss`

**Step 1: Add heading letter-spacing and tabular-nums utility**

In `assets/styles/main.scss`, after the `body` block, add:

```scss
// Sharp typography
.text-h1, .text-h2, .text-h3, .text-h4 {
  letter-spacing: -0.02em;
}

.text-h5, .text-h6 {
  letter-spacing: -0.01em;
}

.text-p2, .text-p3 {
  letter-spacing: -0.01em;
}

// Tabular numerals for all financial data
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
```

Also add `letter-spacing: -0.01em` to the `body` rule:

```scss
body {
  // ... existing properties ...
  letter-spacing: -0.01em;  // add this line
}
```

**Step 2: Verify in browser**

Headings on any page should feel tighter and more editorial. Numbers in vault APY/supply columns should align in columns.

**Step 3: Commit**

```bash
git add assets/styles/main.scss
git commit -m "design: tighten heading tracking and add tabular-nums utility"
```

---

## Task 5: Fix hardcoded border-radius in UiInput

**Files:**
- Modify: `components/ui/UiInput.vue`

`UiInput` has a hardcoded `border-radius: 8px` in its `<style>` block that ignores the CSS variable. Fix it to use the token.

**Step 1: Find and update the hardcoded value**

In the `<style lang="scss">` block of `UiInput.vue`, find:

```scss
.ui-input {
  // ...
  border-radius: 8px;
  box-shadow: var(--ui-input-shadow);
```

Change to:

```scss
.ui-input {
  // ...
  border-radius: var(--radius-md);
  box-shadow: var(--ui-input-shadow);
```

Note: The `.is-compact` variant uses `border-radius: 100px` (a pill shape) — leave that unchanged.

**Step 2: Verify in browser**

The search input on `/earn` should have 6px corners. Compact pill inputs (if any are visible) should still be fully rounded.

**Step 3: Commit**

```bash
git add components/ui/UiInput.vue
git commit -m "design: use radius token in UiInput instead of hardcoded 8px"
```

---

## Task 6: Update active nav item in TheHeader

**Files:**
- Modify: `components/layout/TheHeader.vue`

The current active state is a filled `bg-surface-secondary` pill. Replace it with a gold bottom-border underline.

**Step 1: Find the nav link classes**

In `TheHeader.vue`, find the `NuxtLink` for nav items (around line 158–172):

```html
<NuxtLink
  v-for="item in menuItems"
  :key="item.name"
  :to="'/' + item.name"
  class="flex gap-8 text-[13px] font-medium no-underline py-10 px-16 rounded-8 text-content-secondary items-center justify-center hover:text-content-primary hover:bg-surface-secondary transition-all"
  :class="[getIsMenuItemActive(item) ? 'bg-surface-secondary text-content-primary' : '']"
>
```

**Step 2: Replace the active treatment**

```html
<NuxtLink
  v-for="item in menuItems"
  :key="item.name"
  :to="'/' + item.name"
  class="flex gap-8 text-[13px] font-medium no-underline py-10 px-16 rounded-8 text-content-secondary items-center justify-center hover:text-content-primary transition-all border-b-2 border-transparent"
  :class="[getIsMenuItemActive(item) ? 'text-content-primary border-b-accent-500' : 'hover:bg-surface-secondary']"
>
```

Key changes:
- Added `border-b-2 border-transparent` as the base (so height doesn't jump on active)
- Active class: `text-content-primary border-b-accent-500` (gold underline, no bg fill)
- Non-active hover: `hover:bg-surface-secondary` still gives feedback on hover

Note: `border-b-accent-500` in Tailwind maps to `border-bottom-color: var(--accent-500)` which picks up the new `#c8960c` gold automatically.

**Step 3: Verify in browser**

Navigate to `/earn` — the Earn nav item should show a gold bottom border, no background pill. Hover on other nav items should still show a subtle background.

**Step 4: Commit**

```bash
git add components/layout/TheHeader.vue
git commit -m "design: replace nav active pill with gold bottom border"
```

---

## Task 7: Remove shadow-card from vault list cards and harden borders

**Files:**
- Modify: `components/entities/vault/VaultEarnItem.vue`
- Modify: `components/entities/vault/VaultBorrowItem.vue`
- Modify: `components/entities/vault/VaultItem.vue`
- Modify: `components/entities/vault/SecuritizeVaultItem.vue`
- Modify: `components/entities/portfolio/PortfolioEarnItem.vue`
- Modify: `components/entities/portfolio/PortfolioBorrowItem.vue`
- Modify: `components/entities/portfolio/PortfolioSavingItem.vue`
- Modify: `components/entities/portfolio/PortfolioRewardItem.vue`
- Modify: `components/entities/portfolio/PortfolioBrevisRewardItem.vue`

**Context:** Token Task 1 already sets `--shadow-card: none`, which strips the shadow via the CSS variable. But the main card wrappers use `border-line-subtle` (very faint `rgba(0,0,0,0.06)` → now `0.10`), while we want the primary card border to be the harder `border-line-default` (`#d4d4d4`). This task upgrades those borders.

The pattern to find and update in each file is:

```
// Find:        border border-line-subtle shadow-card
// Replace with: border border-line-default
```

Or:
```
// Find:        border border-line-default shadow-card
// Replace with: border border-line-default
```

(Just remove `shadow-card` — `border-line-default` is already correct in some files.)

**Step 1: Update VaultEarnItem.vue**

Line 83:
```html
<!-- Before -->
class="block no-underline bg-surface rounded-xl border border-line-subtle shadow-card transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"

<!-- After -->
class="block no-underline bg-surface rounded-xl border border-line-default transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"
```

**Step 2: Update VaultBorrowItem.vue**

Line 190:
```html
<!-- Before -->
class="grid gap-x-16 mobile:block no-underline text-content-primary bg-surface rounded-12 border border-line-default shadow-card hover:shadow-card-hover hover:border-line-emphasis transition-all"

<!-- After -->
class="grid gap-x-16 mobile:block no-underline text-content-primary bg-surface rounded-12 border border-line-default hover:shadow-card-hover hover:border-line-emphasis transition-all"
```

**Step 3: Update VaultItem.vue**

Line 117:
```html
<!-- Before -->
class="block no-underline text-content-primary bg-surface rounded-12 border border-line-default shadow-card hover:shadow-card-hover hover:border-line-emphasis transition-all"

<!-- After -->
class="block no-underline text-content-primary bg-surface rounded-12 border border-line-default hover:shadow-card-hover hover:border-line-emphasis transition-all"
```

**Step 4: Update SecuritizeVaultItem.vue**

Line 76:
```html
<!-- Before -->
class="block no-underline text-content-primary bg-surface rounded-12 border border-line-default shadow-card hover:shadow-card-hover hover:border-line-emphasis transition-all"

<!-- After -->
class="block no-underline text-content-primary bg-surface rounded-12 border border-line-default hover:shadow-card-hover hover:border-line-emphasis transition-all"
```

**Step 5: Update PortfolioEarnItem.vue**

Line 98:
```html
<!-- Before -->
class="block no-underline bg-surface rounded-xl border border-line-subtle shadow-card cursor-pointer transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"

<!-- After -->
class="block no-underline bg-surface rounded-xl border border-line-default cursor-pointer transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"
```

**Step 6: Update PortfolioBorrowItem.vue**

Find the root element class (line ~284):
```html
<!-- Before -->
class="block no-underline bg-surface rounded-xl border border-line-subtle shadow-card transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"

<!-- After -->
class="block no-underline bg-surface rounded-xl border border-line-default transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"
```

**Step 7: Update PortfolioSavingItem.vue**

There are two instances (line ~136 and ~234):
```html
<!-- Before (both) -->
class="block no-underline bg-surface rounded-xl border border-line-subtle shadow-card cursor-pointer transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"

<!-- After (both) -->
class="block no-underline bg-surface rounded-xl border border-line-default cursor-pointer transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"
```

**Step 8: Update PortfolioRewardItem.vue**

Line ~118:
```html
<!-- Before -->
class="bg-surface rounded-xl border border-line-subtle shadow-card p-16"

<!-- After -->
class="bg-surface rounded-xl border border-line-default p-16"
```

**Step 9: Update PortfolioBrevisRewardItem.vue**

Line ~110:
```html
<!-- Before -->
class="bg-surface rounded-xl border border-line-subtle shadow-card p-16"

<!-- After -->
class="bg-surface rounded-xl border border-line-default p-16"
```

**Step 10: Verify in browser**

Check `/earn`, `/borrow`, `/portfolio`. Cards should sit flat against the `#f3f3f3` body with a visible `#d4d4d4` border. On hover, a subtle shadow should lift them. No card should have a shadow at rest.

**Step 11: Commit**

```bash
git add components/entities/vault/VaultEarnItem.vue \
        components/entities/vault/VaultBorrowItem.vue \
        components/entities/vault/VaultItem.vue \
        components/entities/vault/SecuritizeVaultItem.vue \
        components/entities/portfolio/PortfolioEarnItem.vue \
        components/entities/portfolio/PortfolioBorrowItem.vue \
        components/entities/portfolio/PortfolioSavingItem.vue \
        components/entities/portfolio/PortfolioRewardItem.vue \
        components/entities/portfolio/PortfolioBrevisRewardItem.vue
git commit -m "design: strip shadow-card from vault/portfolio cards, harden border"
```

---

## Task 8: Add uppercase tracking to sort/filter labels

**Files:**
- Modify: `components/entities/vault/VaultSortButton.vue`

The sort button label on vault list pages should use the data-table uppercase style.

**Step 1: Read VaultSortButton.vue to find the label element**

Open `components/entities/vault/VaultSortButton.vue` and find the element that renders the sort label text.

**Step 2: Add uppercase tracking classes**

Find the element rendering the sort label. Add Tailwind classes:
- `text-[11px]` (or keep current if already small)
- `uppercase`
- `tracking-[0.06em]`
- `font-semibold`

Example — if the label is rendered like:
```html
<span class="text-p3 text-content-secondary">{{ currentSort }}</span>
```

Change to:
```html
<span class="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-secondary">{{ currentSort }}</span>
```

**Step 3: Verify in browser**

On `/earn`, the sort button (e.g. "Total Supply") label should appear in small-caps uppercase with wide tracking — like a data table column header.

**Step 4: Commit**

```bash
git add components/entities/vault/VaultSortButton.vue
git commit -m "design: add uppercase tracking to sort button labels"
```

---

## Task 9: Final visual pass — dark mode check

**Step 1: Switch to dark mode in the app settings**

Open the app in the browser, go to Settings, and toggle dark mode.

**Step 2: Check these specific things:**

- Body background: should be deep `#0a0a0a`
- Cards: should have `#333333` border (slightly brighter than before), no shadow
- Header: `rgba(17,17,17,0.9)` with harder border
- Gold accents (APY numbers, primary buttons): should be visible and richer-looking
- Input focus ring: gold ring should be visible on dark input

**Step 3: If any dark mode borders look off:**

The dark mode border tokens in `variables.scss` were updated in Task 1. If something looks wrong, inspect with DevTools and check which token is driving it.

**Step 4: Commit any fixes found during this pass**

```bash
git add -p   # stage only specific files
git commit -m "design: fix dark mode visual issues found during QA pass"
```

---

## Completion checklist

- [ ] `variables.scss`: accent gold, backgrounds, borders, shadows, radii all updated
- [ ] `tailwind.config.js`: borderRadius values capped at 6px
- [ ] `components/ui/styles/main.scss`: input shadows, secondary button, toast gold
- [ ] `assets/styles/main.scss`: heading tracking, body tracking, tabular-nums
- [ ] `UiInput.vue`: hardcoded `8px` replaced with `var(--radius-md)`
- [ ] `TheHeader.vue`: active nav → gold underline, no fill
- [ ] 9 vault/portfolio card components: `shadow-card` removed, `border-line-subtle` → `border-line-default`
- [ ] `VaultSortButton.vue`: uppercase tracking on sort label
- [ ] Dark mode verified visually
