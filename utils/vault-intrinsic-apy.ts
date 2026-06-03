import type { IntrinsicApyInfo } from '@eulerxyz/euler-v2-sdk'

export const EMPTY_INTRINSIC_APY: IntrinsicApyInfo = { apy: 0, provider: '' }

interface VaultWithIntrinsicApy {
  intrinsicApy?: IntrinsicApyInfo
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

export function withVaultIntrinsicApy(
  baseApy: number,
  vault: VaultWithIntrinsicApy | undefined,
  enabled: boolean,
): number {
  const intrinsic = getVaultIntrinsicApy(vault, enabled)
  if (intrinsic === 0) return baseApy
  return baseApy + (1 + baseApy / 100) * intrinsic
}
