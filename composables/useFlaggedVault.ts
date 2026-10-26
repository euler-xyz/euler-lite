import { getFlaggedVerdict } from '~/utils/vault-assessment/flagged'

export const useFlaggedVault = (address: () => string) => {
  const { isReady, source, visibility } = useEulerLabels()
  return computed(() => isReady.value && !!getFlaggedVerdict(address(), source.value, visibility.value))
}
