# Keyring Hooks (Private Vaults)

This document explains how euler-lite supports vaults that require identity verification via Keyring Network.

## Overview

Certain Euler vaults are configured with a **hook target** contract that intercepts vault operations (deposit, withdraw, borrow, repay, etc.) and reverts if the caller lacks a valid Keyring credential. These vaults are labeled as "Private" in the UI and require users to complete a one-time KYC verification through the Keyring browser extension before interacting.

## Architecture

### Detection: Labels

Keyring vaults are flagged via the labels system (`products.json`):

```jsonc
{
  "private-market": {
    "name": "Private Market",
    "tags": ["keyring"],       // All vaults in this product require keyring
    "vaults": ["0x1234..."],
    "vaultOverrides": {
      "0x5678...": {
        "tags": ["keyring"]    // Per-vault classification
      }
    }
  }
}
```

Utility functions in `utils/eulerLabelsUtils.ts`:
- `isVaultKeyring(vaultAddress)` — checks product-level or vault-override `keyring` tag
- `isProductKeyring(productKey)` — checks the product-level `keyring` tag

### On-chain reads (zero hardcoded addresses)

Unlike the monorepo which hardcodes keyring contract addresses per chain, euler-lite reads everything from the vault's `hookTarget` (already fetched by the vault lens):

| View function | Returns | Purpose |
|--------------|---------|---------|
| `hookTarget.policyId()` | `uint32` | Keyring policy ID for this vault |
| `hookTarget.keyring()` | `address` | Keyring credentials contract address |
| `hookTarget.checkKeyringCredentialOrWildCard(account)` | `bool` | Whether the account has a valid credential |

The Keyring credentials contract (`entityExp(policyId, address)`) is used to check credential expiration.

### Composables

**`composables/useKeyring/index.ts`** — encapsulates all keyring logic:
- Checks credential status on-chain
- Manages the Keyring Connect SDK browser extension flow
- Returns reactive state: `isVerificationRequired`, `flowState`, `credentialData`, etc.

**`composables/useOperationGuard.ts`** — wires keyring to the SDK plugin and the guard registry:
- Calls `useKeyring` for the first keyring-flagged vault address
- Provides keyring state to `VaultFormSubmit` via `provide('keyring-guard', ...)`
- Publishes verified credentials to the SDK keyring plugin store via `setSdkKeyringCredential()` (`utils/sdk-keyring.ts`) and sets credential-cost metadata
- Registers/unregisters submit blockers in the guard registry while verification is pending

### Guard registry and SDK plugin

`utils/operationGuardRegistry.ts` holds reactive submit blockers and per-concern metadata. Plan transformation itself runs inside the SDK's keyring plugin (`createKeyringPlugin`, registered in `composables/useEulerSdk.ts`):

```text
Page calls useOperationGuard([vaultAddresses])
  → useKeyring detects keyring vault
  → credential obtained from extension
  → setSdkKeyringCredential(...) publishes it to the SDK plugin store

Page calls executePlan(plan) as normal
  → the SDK keyring plugin automatically prepends createCredential
  → transaction executes with credential registration + vault operation atomically
```

This means **pages need zero changes to their submit handlers** — they just call `useOperationGuard()` in setup and the rest is automatic.

### Transaction injection

The SDK's `createKeyringPlugin` performs the injection. It is registered in `composables/useEulerSdk.ts` with two inputs from `utils/sdk-keyring.ts`:

- `hookTargets` from `buildSdkKeyringHookTargets()` — hook-target addresses derived from keyring-tagged vaults in the registry
- `getCredentialData` from `getSdkKeyringCredential()` — serves credentials published by `useOperationGuard`, returning `null` for expired credentials or when the hook target's keyring contract address no longer matches the cached one

When a plan touches a keyring hook target and a credential is available, the plugin:
1. Creates a `createCredential` `EVCBatchItem` targeting the Keyring credentials contract
2. Includes the ETH/native currency fee as the call's `value`
3. Prepends it to every `evcBatch` item in the SDK `TransactionPlan`

The `createCredential` call executes first in the batch, registering the credential on-chain. Subsequent vault operations in the same batch then pass the hook target's credential check.

## User Flow

1. User navigates to a keyring vault's supply/borrow/withdraw page
2. `useOperationGuard` detects keyring requirement, checks credential on-chain
3. If no valid credential: the submit button is replaced with the verification flow
4. User installs Keyring extension (if needed) and completes verification
5. Extension returns `CredentialData` with the signed credential and fee
6. Submit button reappears; credential fee is displayed
7. On submit, `createCredential` is automatically injected into the EVC batch
8. Transaction executes: credential registered + vault operation atomically

## UI Components

| Component | Purpose |
|-----------|---------|
| `KeyringBadge` | "Private" pill badge on vault cards and overview. Clickable → opens `KeyringInfoModal`. Supports `size="small"` (cards) and `size="large"` (overview). |
| `KeyringInfoModal` | Modal explaining keyring verification requirements |
| `KeyringAlert` | Alert banner shown in the submit area. Two variants: initial and expired. |
| `KeyringVerificationFlow` | Extension install/start/progress/ready flow replacing the submit button |
| `VaultTypeBadges` | Unified vault type display used across all overview components. Shows governance type + extra type (Securitize) + Private badge. |

## Adding Keyring Support to a New Page

1. Call `useOperationGuard()` in the page's `<script setup>` with all involved vault addresses:

```typescript
useOperationGuard([collateralAddress, borrowAddress])
// or with reactive addresses:
useOperationGuard(computed(() => [fromVault?.address, toVault?.address].filter(Boolean)))
```

2. That's it. The guard registry handles everything else automatically.

## Key Files

| File | Role |
|------|------|
| `abis/keyring.ts` | Hook target + credentials contract ABIs |
| `composables/useKeyring/index.ts` | Main keyring composable |
| `composables/useOperationGuard.ts` | Publishes credentials to the SDK plugin store, registers blockers, provide/inject |
| `utils/operationGuardRegistry.ts` | Reactive submit blocker and metadata registry |
| `utils/sdk-keyring.ts` | Credential store and hook-target config for the SDK `createKeyringPlugin` |
| `components/keyring/*` | UI components (badge, alert, flow, modal) |
| `components/entities/vault/VaultTypeBadges.vue` | Unified vault type + private badge display |
