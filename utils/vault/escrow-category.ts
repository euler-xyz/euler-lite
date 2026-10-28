import type { IEVault } from '@eulerxyz/euler-v2-sdk'

type EVaultCategory = 'standard' | 'escrow'

/** Map the SDK verdict to a UI category without selecting or recovering data sources. */
export const resolveEVaultCategory = (
  vault: Pick<IEVault, 'isEscrow'>,
): EVaultCategory | undefined => {
  if (typeof vault.isEscrow === 'boolean') return vault.isEscrow ? 'escrow' : 'standard'
  return undefined
}
