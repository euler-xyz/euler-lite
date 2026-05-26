/**
 * Wire shape for the `/api/vaults?chainId=N` snapshot. Lives in `utils/`
 * (not `server/utils/`) so client-side hydration (`composables/useVaults.ts`)
 * can import the types without dragging server-side modules into the
 * browser bundle.
 *
 * The actual builder lives in `server/utils/vaults-cache.ts`.
 */
export type SerialisedVaultKind = 'evk' | 'earn' | 'securitize' | 'escrow'

export interface SerialisedVault {
  kind: SerialisedVaultKind
  /** Wire-shape vault data: bigints replaced by `{ __bi: "<decimal>" }` tags. */
  data: unknown
}

export interface SerialisedSnapshot {
  chainId: number
  fetchedAt: number
  evkVaults: SerialisedVault[]
  earnVaults: SerialisedVault[]
  securitizeVaults: SerialisedVault[]
  escrowVaults: SerialisedVault[]
}
