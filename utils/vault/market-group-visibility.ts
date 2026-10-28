import { isEVault } from '@eulerxyz/euler-v2-sdk'
import type { AnyVault } from '~/composables/useVaultRegistry'
import { getVaultAddress } from '~/utils/discoveryCalculations'
import { isVaultNotExplorableBorrow, isVaultNotExplorableLend } from '~/utils/eulerLabelsUtils'
import { isVaultBorrowable } from '~/utils/vault/classification'

/**
 * Should this product group be listed as a market in discovery?
 *
 * A group earns a listing when at least one member vault is explorable on
 * some side: open on the lend side, or borrowable (including residual debt,
 * mirroring isVaultBorrowable) and open on the borrow side. A product whose
 * every member is flagged away on both sides — e.g. issuer-governed
 * collateral wrappers — stays out of Explore while its vaults remain
 * resolvable as external collateral in other groups' graphs and via the
 * direct market URL.
 */
export const groupHasExplorableMarket = (vaults: AnyVault[]): boolean =>
  vaults.some((vault) => {
    const address = getVaultAddress(vault)
    if (!address) return false
    if (!isVaultNotExplorableLend(address)) return true
    return isEVault(vault) && isVaultBorrowable(vault) && !isVaultNotExplorableBorrow(address)
  })
