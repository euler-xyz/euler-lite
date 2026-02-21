# UI Reskin Design — Sharp Fintech

**Date:** 2026-02-21
**Approach:** Option A — Surgical sharpening (Mercury / Brex style)
**Theme:** Light-first, gold accent retained and enriched, square-ish geometry (max 6px radius)

---

## Goals

Make the UI feel sharper, more modern, and fintech-credible without restructuring pages or changing component APIs. All changes are additive — tokens cascade, logic is untouched.

---

## Section 1: Color & Surface Tokens

### Backgrounds
| Token | Before | After |
|---|---|---|
| `--bg-body` | `#fafafa` | `#f3f3f3` |
| `--bg-surface-secondary` | `#fafafa` | `#efefef` |
| `--bg-header` | `rgba(255,255,255,0.85)` | `rgba(255,255,255,0.90)` |

Cards remain `#ffffff` — the cooler body makes them float without shadow.

### Borders
| Token | Before | After |
|---|---|---|
| `--border-default` (neutral-200) | `#e5e5e5` | `#d4d4d4` |
| `--border-subtle` | `rgba(0,0,0,0.06)` | `rgba(0,0,0,0.10)` |
| `--border-emphasis` (neutral-300) | `#d4d4d4` | `#b5b5b5` |

### Gold Accent
| Token | Before | After |
|---|---|---|
| `--accent-500` | `#c49b64` | `#c8960c` |
| `--accent-600` | `#a88347` | `#b07d0a` |
| `--accent-300` | `#e8d5b7` | `#f5e09a` |

More saturated amber-gold. Richer and more deliberate at small sizes.

### Shadows
| Context | Before | After |
|---|---|---|
| Cards | `var(--shadow-sm)` | `none` (border only) |
| Card hover | `var(--shadow-md)` | `0 2px 8px rgba(0,0,0,0.08)` |
| Modals / tooltips | deep shadows | unchanged |

---

## Section 2: Border Radius & Typography

### Border Radius — 6px ceiling
| Token | Before | After |
|---|---|---|
| `--radius-sm` | `6px` | `4px` |
| `--radius-md` | `8px` | `6px` |
| `--radius-lg` | `10px` | `6px` |
| `--radius-xl` | `12px` | `6px` |
| `--radius-2xl` | `16px` | `6px` |

Applies to: buttons, inputs, cards, modals, dropdowns, chips, tooltips.
Exception: avatar circles and icon badges remain `border-radius: 50%`.

Tailwind `borderRadius` config updated to match (`8: '6px'`, `12: '6px'`, `16: '6px'`).

### Typography
- Headings (`h1`–`h4`): `letter-spacing: -0.02em`
- Body (`p2`, `p3`): `letter-spacing: -0.01em`
- Numeric data (APY, USD, amounts): `font-variant-numeric: tabular-nums` via utility class
- `font-variation-settings: "opsz" 32` — retained (already set)
- No font change — Inter stays

---

## Section 3: Component Changes

### `TheHeader.vue`
- Active nav item: replace filled `bg-surface-secondary` pill with gold bottom border (`border-b-2 border-accent-500`), no background fill
- Socials dropdown: inherits square corners from tokens

### `UiButton`
- Primary: gold background `#c8960c`, white text — cascades from accent tokens
- Secondary: `bg-white` with `border border-line-default` (stroke-only, cleaner on light bg)
- Hover lift (`translateY(-1px)`) retained

### `UiInput`
- Border: `1px solid #d4d4d4` (no shadow by default)
- Focus ring: `2px solid #c8960c`, no blur — precise

### Cards / vault rows
- `box-shadow` removed — `border: 1px solid var(--border-default)` only
- Hover: border color shifts to `--border-emphasis` + subtle `box-shadow-card-hover`
- Padding unchanged

### `BasePageHeader`
- Heading tracking inherits from typography tokens
- Divider below header: `1px solid var(--border-emphasis)`

---

## Section 4: Page-Level Changes

### Earn / Borrow / Lend
- Filter bar: tighter chip corners (tokens), sharper input border
- Vault list rows: no shadow, white cards over `#f3f3f3` body bg provide natural depth
- Column/sort labels: `font-size: 11px, letter-spacing: 0.06em, text-transform: uppercase` for data-table feel

### Portfolio
- Summary stat cards: border-only, no shadow
- Position rows: same border treatment as vault rows

### Onboarding
- No structural change — 3D logo scene untouched, surrounding UI tokens cascade in

### Mobile
- No structural changes — token changes cascade automatically

### Dark Mode
- Mirror sharpening: `--border-default` `#262626` → `#333333`, `--border-subtle` `rgba(255,255,255,0.06)` → `rgba(255,255,255,0.10)`
- Gold accent stays unchanged in dark overrides (already slightly brighter there)

---

## What Does Not Change

- Page routing, data fetching, composables — zero logic changes
- Component APIs — no prop signature changes anywhere
- Page structure / layout — no DOM restructuring
- Dark mode block structure — only token values updated within existing overrides

---

## Files to Change

| File | Change |
|---|---|
| `assets/styles/variables.scss` | Color tokens, shadow tokens, radius variables |
| `tailwind.config.js` | `borderRadius` config values |
| `components/ui/styles/main.scss` | Component-level CSS variables (button, input, etc.) |
| `assets/styles/main.scss` | Heading/body letter-spacing, tabular-nums utility |
| `components/layout/TheHeader.vue` | Active nav item treatment |
| `components/ui/UiButton.vue` | Secondary button base style tweak |
| `components/ui/UiInput.vue` | Border + focus ring |
| Entity / vault card components | Strip box-shadow, add border |
| Page filter bars (earn, borrow, lend) | Sort label typography |
| Portfolio stat cards | Strip box-shadow |
