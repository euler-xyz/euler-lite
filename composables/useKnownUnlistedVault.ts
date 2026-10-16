export const useKnownUnlistedVault = (address: () => string) => {
  const { isReady, source, visibility } = useEulerLabels()
  return computed(() => {
    if (!isReady.value || source.value !== 'v3') return false
    const status = visibility.value?.[address().toLowerCase()]?.status
    return status === 'hidden' || status === 'pending_review'
  })
}
