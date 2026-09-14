import type { IntrinsicApyInfo } from '@eulerxyz/euler-v2-sdk'

export const EMPTY_INTRINSIC_APY: IntrinsicApyInfo = { apy: 0, provider: '' }

export interface VaultWithIntrinsicApy {
  intrinsicApy?: IntrinsicApyInfo
}

export function resolveVaultIntrinsicApySource(
  ...vaults: Array<VaultWithIntrinsicApy | undefined>
): VaultWithIntrinsicApy | undefined {
  return vaults.find(vault => vault?.intrinsicApy !== undefined)
}

export function getVaultIntrinsicApyInfo(
  vault: VaultWithIntrinsicApy | undefined,
  enabled: boolean,
): IntrinsicApyInfo {
  if (!enabled || !vault || !vault.intrinsicApy) return EMPTY_INTRINSIC_APY
  return vault.intrinsicApy
}

export function getVaultIntrinsicApy(
  vault: VaultWithIntrinsicApy | undefined,
  enabled: boolean,
): number {
  return getVaultIntrinsicApyInfo(vault, enabled).apy
}

/**
 * Combine a base APY with an intrinsic (e.g. staking) APY the way a yield-bearing
 * position actually accrues: the intrinsic yield compounds on top of the base
 * rather than being a flat sum. `combineApyWithIntrinsic(5, 4) = 5 + 1.05 * 4 = 9.2`.
 * Shared by the headline figures (via withVaultIntrinsicApy) and the APY tooltips
 * so both report the same total.
 */
export function combineApyWithIntrinsic(baseApy: number, intrinsicApy: number): number {
  if (!intrinsicApy) return baseApy
  return baseApy + (1 + baseApy / 100) * intrinsicApy
}

export function withVaultIntrinsicApy(
  baseApy: number,
  vault: VaultWithIntrinsicApy | undefined,
  enabled: boolean,
): number {
  return combineApyWithIntrinsic(baseApy, getVaultIntrinsicApy(vault, enabled))
}

/**
 * Recompute a vault APY from the projected raw rate so base/intrinsic
 * compounding remains correct whenever utilization changes.
 */
export function withProjectedVaultIntrinsicApy(
  currentRawApy: number,
  projectedRawApy: number | null | undefined,
  vault: VaultWithIntrinsicApy | undefined,
  enabled: boolean,
): number {
  return withVaultIntrinsicApy(projectedRawApy ?? currentRawApy, vault, enabled)
}
