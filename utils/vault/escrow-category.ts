import type { IEVault } from '@eulerxyz/euler-v2-sdk'

type EVaultCategory = 'standard' | 'escrow'

/** SDK booleans are authoritative; unknown flags retain discovered/cached categories. */
export const resolveEVaultCategory = (
  vault: Pick<IEVault, 'isEscrow'>,
  fallback?: EVaultCategory,
): EVaultCategory | undefined => {
  if (typeof vault.isEscrow === 'boolean') return vault.isEscrow ? 'escrow' : 'standard'
  return fallback
}
