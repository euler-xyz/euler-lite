---
name: claude-review-stack
description: Review PR changes for Vue 3 / Nuxt 3 / TypeScript / Viem best practices in the euler-lite codebase
---

# Tech Stack Hygiene Review

Review this PR's changes for Vue 3 / Nuxt 3 / TypeScript / Viem best practices as used in the euler-lite codebase.

## Context

euler-lite is a Nuxt 3 frontend for the Euler DeFi lending protocol. Key tech:
- **Vue 3** with `<script setup>` composition API (no Options API)
- **Nuxt 3** with file-based routing in `pages/`, SSR-aware composables
- **TypeScript** throughout — strict typing expected, especially for on-chain data
- **Viem** for all Ethereum interactions (no ethers.js)
- **Tailwind CSS** for styling
- State is managed via composables in `composables/` (no Pinia — Nuxt 3 native composition)
- Business logic lives in `composables/`, `utils/`, and `entities/`

## Instructions

### Step 1: Get the diff

```bash
git diff origin/$BASE_REF...HEAD -- '*.vue' '*.ts' '*.js' '*.json'
```

Read the diff carefully. Focus only on changed lines and their immediate context.

### Step 2: Check against these criteria

**Vue 3 / Nuxt 3 Patterns**
- All components use `<script setup lang="ts">` — no Options API, no `defineComponent` wrapper unless required
- `defineProps` and `defineEmits` use TypeScript generic syntax, not runtime declarations
- `computed()`, `ref()`, `watch()` are imported from `vue` — not used as global injections
- No `.value` access forgotten on refs inside `<template>` (auto-unwrapped there)
- Composables in `composables/` follow the pattern: accept `Ref`/`ComputedRef` options, return reactive state/computed refs
- `useAsyncData` / `useFetch` used for server-side data fetching; plain `fetch` only in client-only contexts
- No `process.server` / `process.client` checks in components (use `onMounted` or `<ClientOnly>` instead)
- Auto-imports are relied upon for composables and Vue APIs — avoid manual imports of things Nuxt auto-imports

**TypeScript Strictness**
- No `any` types — use proper types or `unknown` with narrowing
- On-chain values (balances, amounts) typed as `bigint`, not `number` or `string`
- Contract return types properly typed via viem's inferred ABI types
- No `as unknown as X` double-cast unless absolutely necessary
- `computed<T>(() => ...)` explicit generic when return type is ambiguous

**Viem Patterns**
- `readContract` / `writeContract` / `simulateContract` used correctly
- No manual ABI encoding/decoding when viem helpers exist
- Address comparisons use `getAddress()` normalisation, not raw string equality
- `parseUnits` / `formatUnits` used with correct decimals — never hardcoded to 18 without justification

**Component Structure**
- Props are the only source of truth for component inputs — no direct store reads inside deeply-nested components
- Events flow up via `emit`, not by mutating props or calling parent composables directly
- `v-for` always has `:key` bound to a stable, unique value (not array index for dynamic lists)
- No inline styles — Tailwind classes only; no `style=""` attribute unless truly dynamic

### Step 3: Classify findings

For each issue found:
- `🚨 CRITICAL:` — broken pattern that will cause runtime errors, hydration mismatches, or type safety regressions
- `⚠️ WARNING:` — bad practice that should be fixed but won't immediately break
- `💬 SUGGESTION:` — minor improvement

Skip nits about formatting, comment style, or ordering unless they create confusion.

### Step 4: Return findings

Return all findings as structured text to the orchestrator. Do NOT call /inline-pr-comments — the orchestrator collects findings from all three reviews and posts them in a single consolidated review. Include a brief summary of which files were reviewed and overall assessment.
