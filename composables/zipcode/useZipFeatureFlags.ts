import { type FeatureFlags, featureFlags } from '~/types/zipcode'

// Reactive view over the demo feature flags (spec §19). Held in `useState` so a
// future dev toolbar or query-param override can flip flags at runtime without
// reloading. Components read these for `v-if` gating; szipUSD/staking stay off.

const FLAGS_KEY = 'zip-feature-flags'

export const useZipFeatureFlags = () => {
  const flags = useState<FeatureFlags>(FLAGS_KEY, () => ({ ...featureFlags }))

  const setFlag = <K extends keyof FeatureFlags>(key: K, value: FeatureFlags[K]) => {
    flags.value = { ...flags.value, [key]: value }
  }

  return { flags, setFlag }
}
