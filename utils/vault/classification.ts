import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'

export const isCyclicalNoteVault = (
  vault: EVault | SecuritizeCollateralVault | null | undefined,
): boolean => {
  if (!vault) return false
  const type = (vault as { interestRateModel?: { type?: unknown } }).interestRateModel?.type
  return typeof type === 'number' && type === INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY
}
