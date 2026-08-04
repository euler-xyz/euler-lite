import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'

/**
 * Canonical sink for loss coverage on EulerEarn. `IEulerEarn.lostAssets` advises
 * covering a shortfall by supplying on behalf of `address(1)`, whose shares are
 * unrecoverable and therefore absorb the loss instead of real depositors.
 */
export const EARN_LOSS_COVERAGE_ADDRESS: Address = '0x0000000000000000000000000000000000000001'

type EarnLossSource = Pick<EulerEarn, 'lostAssets' | 'convertToAssets'>

/**
 * The part of `lostAssets` that nobody has made good on yet.
 *
 * `lostAssets` only ever grows — `EulerEarn._accruedFeeAndAssets` never writes it
 * back down when a shortfall gets covered. Coverage shows up instead as shares
 * parked at `address(1)`, so the amount still unbacked is the recorded shortfall
 * minus what those shares are currently worth. Coverage can overshoot (donations
 * keep earning yield after the fact), hence the clamp at zero.
 */
export const computeUncoveredLosses = (
  vault: EarnLossSource,
  coverageShares: bigint | undefined,
): bigint => {
  if (vault.lostAssets <= 0n) return 0n
  if (coverageShares === undefined || coverageShares <= 0n) return vault.lostAssets

  const coverageAssets = vault.convertToAssets(coverageShares)
  return coverageAssets >= vault.lostAssets ? 0n : vault.lostAssets - coverageAssets
}
