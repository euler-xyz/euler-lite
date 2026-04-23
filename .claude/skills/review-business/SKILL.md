---
name: claude-review-business
description: Review PR changes for correctness of DeFi business logic in the Euler lending protocol UI
---

# Business Logic Review

Review this PR's changes for correctness of DeFi business logic in the Euler lending protocol UI.

## Context

euler-lite is the frontend for Euler v2, a modular DeFi lending protocol. Key domain concepts:
- **Vaults** — ERC-4626 lending/borrowing vaults; assets and shares are distinct
- **Positions** — a user's borrow or collateral position in a vault
- **Health factor** — ratio of collateral value to borrow value; below 1 = liquidatable
- **Collateral swap** — swapping collateral assets while maintaining a position
- **Repay** — paying back borrowed assets, reducing debt
- **Leverage / multiply** — using borrowed assets to buy more collateral, amplifying exposure
- All on-chain values are `bigint` in wei; display values use fixed-point utilities in `utils/fixed-point.ts`
- Position estimates live in `utils/position-estimates.ts`

## Instructions

### Step 0: Fetch relevant protocol skills

Fetch the euler-xyz skill files whose domain overlaps with the diff. If in doubt, always fetch `euler-vaults`.

- `euler-vaults` — vault operations, EVC orchestration, risk management, batching: `https://raw.githubusercontent.com/euler-xyz/agent-skills/77b444666398f8471747edf014aeed832831ee5e/skills/euler-vaults/SKILL.md`
- `euler-irm-oracles` — oracle adapters, price feed configuration, IRM types: `https://raw.githubusercontent.com/euler-xyz/agent-skills/77b444666398f8471747edf014aeed832831ee5e/skills/euler-irm-oracles/SKILL.md`
- `euler-earn` — EulerEarn yield aggregation, allocator roles: `https://raw.githubusercontent.com/euler-xyz/agent-skills/77b444666398f8471747edf014aeed832831ee5e/skills/euler-earn/SKILL.md`
- `euler-advanced` — hooks, flash loans, debt mechanics, reward systems: `https://raw.githubusercontent.com/euler-xyz/agent-skills/77b444666398f8471747edf014aeed832831ee5e/skills/euler-advanced/SKILL.md`
- `euler-data` — subgraph queries, contract interfaces, deployment tooling: `https://raw.githubusercontent.com/euler-xyz/agent-skills/77b444666398f8471747edf014aeed832831ee5e/skills/euler-data/SKILL.md`

Protocol docs: https://docs.euler.finance — cross-check any flow that diverges from documented semantics.

### Step 1: Get the diff

```bash
git diff origin/$BASE_REF...HEAD
```

Also read any composables in `composables/repay/`, `composables/borrow/`, `composables/position/` that are touched by the diff to understand full context.

### Step 2: Check against these criteria

**Arithmetic Safety**
- All on-chain arithmetic uses `bigint` — no `Number()` conversion on values that could exceed `Number.MAX_SAFE_INTEGER`
- Division never loses precision silently — check that `utils/fixed-point.ts` helpers are used for scaled arithmetic
- Rounding direction is correct for user safety: when in doubt, round against the user (e.g. debt rounds up, collateral rounds down)
- No floating-point arithmetic on values that will be sent on-chain or displayed as exact amounts

**Vault / Position Logic**
- Shares vs assets distinction respected — `convertToAssets` / `convertToShares` called where needed, not assumed 1:1
- Health factor calculations use up-to-date oracle prices and account for both sides of the position
- Collateral swap flows correctly handle: approval, swap execution, vault deposit/withdraw ordering
- Repay flows: correct handling of `type(uint256).max` for full repay vs exact amount
- Borrow flows: collateral check before borrow, correct controller/vault sequencing

**User-Facing Number Formatting**
- `formatUnits` called with the correct vault asset decimals (not hardcoded 18)
- Display values shown to appropriate precision — not truncating significant digits on small amounts
- "Max" input values account for gas/buffer where relevant (e.g. don't allow borrowing 100% of available liquidity)
- Signed vs unsigned: debt amounts displayed as positive to user even though internally they may be negative deltas

**Flow Correctness**
- `useGeoBlock` checked before allowing any transaction that moves funds — new flows must not bypass geo-blocking
- Operation guard registry (`utils/operationGuardRegistry.ts`) consulted for any new operations — two distinct mechanisms: `isOperationBlocked` is the hard gate that prevents execution; `applyOperationGuards` transforms the tx plan but does not block. Check that new flows call `isOperationBlocked` before submission and pass the plan through `applyOperationGuards`
- Error states (wallet rejection, RPC failure, slippage exceeded) handled and surfaced to user — no silent failures
- Loading/pending states correctly tracked so UI doesn't allow double-submission

**Leverage / Multiply Math**
- Leverage calculations in `utils/leverage.ts` / `utils/multiply-math.ts` used — not reimplemented inline
- Slippage tolerance applied correctly on swap leg

### Step 3: Classify findings

- `🚨 CRITICAL:` — incorrect financial calculation, missing guard that could cause fund loss, silent failure on transaction error, broken repay/borrow flow
- `⚠️ WARNING:` — imprecise rounding, missing edge case (zero balance, max uint), fragile assumption about vault decimals
- `💬 SUGGESTION:` — clarity improvement, better use of existing utility

### Step 4: Return findings

Return all findings as structured text to the orchestrator. Do NOT call /inline-pr-comments — the orchestrator collects findings from all three reviews and posts them in a single consolidated review. Include a summary of which flows were reviewed.
