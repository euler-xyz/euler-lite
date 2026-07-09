import type { YieldApyBreakdown } from '@eulerxyz/euler-v2-sdk'

// Viewer-aware APY breakdown consumer. Combines:
//   - viewer address (spy mode wins, else connected wallet) — passed to SDK
//     breakdown helpers to apply whitelist/blacklist eligibility on rewards.
//   - user settings (enableIntrinsicApy, enableRewardsApy) — applied locally
//     by zeroing the corresponding bucket; the SDK has no knowledge of UI
//     toggles, so this lives Lite-side.
export const useApyVisibility = () => {
  const { settings } = useUserSettings()
  const { address: connectedAddress } = useWagmi()
  const { spyAddress } = useSpyMode()

  const viewer = computed<string | undefined>(() =>
    spyAddress.value || connectedAddress.value || undefined,
  )

  const visibleTotal = (breakdown: YieldApyBreakdown | undefined): number | undefined => {
    if (!breakdown) return undefined
    const intrinsic = settings.value.enableIntrinsicApy ? breakdown.intrinsicApy : 0
    const rewards = settings.value.enableRewardsApy ? breakdown.rewards : 0
    return breakdown.lending + breakdown.borrowing + intrinsic + rewards
  }

  const visibleBreakdown = (breakdown: YieldApyBreakdown | undefined): YieldApyBreakdown | undefined => {
    if (!breakdown) return undefined
    const intrinsic = settings.value.enableIntrinsicApy ? breakdown.intrinsicApy : 0
    const rewards = settings.value.enableRewardsApy ? breakdown.rewards : 0
    return {
      lending: breakdown.lending,
      borrowing: breakdown.borrowing,
      intrinsicApy: intrinsic,
      rewards,
      total: breakdown.lending + breakdown.borrowing + intrinsic + rewards,
    }
  }

  return { viewer, visibleTotal, visibleBreakdown }
}
