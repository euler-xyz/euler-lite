# Terms of Use Signing Flow

Users must sign the Terms of Use on-chain before executing operations. The signature is recorded by the `TermsOfUseSigner` contract and checked on every subsequent visit.

## Configuration

| Env var | Purpose |
|---------|---------|
| `NUXT_PUBLIC_CONFIG_TOS_MD_URL` | URL to raw TOS markdown. **Master switch** — if empty, TOS signing is disabled entirely. |
| `NUXT_PUBLIC_CONFIG_TOS_URL` | URL to the human-readable TOS page (shown in the modal). Fallback: `https://www.euler.finance/terms` |

## How the signed message is constructed

1. The app fetches the TOS markdown from `/api/tos` (which proxies `NUXT_PUBLIC_CONFIG_TOS_MD_URL` with a 5-min cache).

2. A content hash is computed:
   ```
   tosHash = keccak256(stringToHex(markdownContent))
   tosHashShort = tosHash.slice(0, 14)   // first 6 bytes, e.g. "0x1a2b3c4d5e6f"
   ```

3. The human-readable message is assembled:
   ```
   By proceeding to engage with and use Euler, you accept and agree to abide by the Terms of Use: {tosUrl}

   hash:{tosHashShort}
   ```
   Where `{tosUrl}` is from `NUXT_PUBLIC_CONFIG_TOS_URL`.

4. The message hash used as the on-chain key:
   ```
   tosMessageHash = keccak256(stringToHex(tosMessage))
   ```

**Key point:** if the TOS markdown content changes OR the TOS URL changes, the hashes change and users must re-sign.

See: `composables/useTosData.ts`

## On-chain contract

The `TermsOfUseSigner` contract (address from `eulerPeripheryAddresses.termsOfUseSigner`) exposes:

```solidity
// Record signature — called as part of an EVC batch
function signTermsOfUse(string message, bytes32 messageHash) external

// Check if user signed a specific TOS version
function lastTermsOfUseSignatureTimestamp(address account, bytes32 termsOfUseHash) view returns (uint256)
```

- `signTermsOfUse` stores `block.timestamp` keyed by `(account, messageHash)`
- `lastTermsOfUseSignatureTimestamp` returns `0` if never signed, otherwise the timestamp

See: `abis/tos.ts`

## Checking if a user signed (and which version)

To verify off-chain or on-chain whether a user has signed a specific TOS version:

1. **Reconstruct `tosMessageHash`** using the steps above (fetch markdown, compute hashes, build message, hash message).
2. **Call** `lastTermsOfUseSignatureTimestamp(userAddress, tosMessageHash)` on the `TermsOfUseSigner` contract.
3. If the result is `> 0`, the user signed that version at that timestamp.

To check against the **current** TOS version, the app does this automatically in `useTosGuard`.

See: `composables/guards/useTosGuard.ts`

## User-facing flow

1. User navigates to an operation page (supply, borrow, etc.).
2. `useOperationGuard` initializes `useTosGuard`, which checks the on-chain signature.
3. If not signed: the submit button shows "Accept Terms Of Use" instead of the normal action.
4. User clicks it → `AcknowledgeTermsModal` opens with legal checkpoints.
5. User clicks "Accept" → `sessionAccepted` flag is set.
6. The normal submit button reappears. When the user executes their operation, a `signTermsOfUse` call is **prepended** to the EVC batch — so the TOS signature and the operation happen in a single transaction.
7. On next visit, the on-chain check finds `timestamp > 0` and skips the modal.

## Failure handling

- If `/api/tos` is unreachable and no cached content exists, `tosLoadFailed` is set to `true`. The app **fails open** — operations are not blocked, so users can still repay/withdraw. The TOS signing will happen on a future operation when the endpoint recovers.
- If the `TermsOfUseSigner` contract read fails, `hasSigned` is set to `false` and the modal will show.

## Key files

| File | Role |
|------|------|
| `composables/useTosData.ts` | Fetches TOS markdown, computes hashes |
| `composables/guards/useTosGuard.ts` | Guard logic, on-chain signature check, blocker/guard registration |
| `utils/tos-injection.ts` | Prepends `signTermsOfUse` call to EVC batch |
| `utils/operationGuardRegistry.ts` | Generic guard registry (TOS guard registers here) |
| `server/api/tos.get.ts` | Server proxy for TOS markdown with caching |
| `abis/tos.ts` | `TermsOfUseSigner` contract ABIs |
| `components/entities/operation/AcknowledgeTermsModal.vue` | Acceptance modal UI |
| `components/entities/vault/form/VaultFormSubmit.vue` | Submit button that triggers the modal |
