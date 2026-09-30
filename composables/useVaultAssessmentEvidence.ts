import type { VaultAssessment, VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import { toValue, type MaybeRefOrGetter } from 'vue'

export const useVaultAssessmentEvidence = (
  address: MaybeRefOrGetter<string>,
  family: VaultAssessmentFamily,
) => {
  const { chainId } = useEulerAddresses()
  const {
    source, loadError, vaultAssessments, loadVaultAssessment,
    getVaultAssessmentEntry, isVaultAssessmentAvailableForChain,
  } = useEulerLabels()
  const canLoad = computed(() => !!chainId.value && source.value === 'v3'
    && !loadError.value && isVaultAssessmentAvailableForChain(chainId.value))
  const entry = computed(() => {
    void vaultAssessments.value
    return canLoad.value && chainId.value
      ? getVaultAssessmentEntry(chainId.value, toValue(address), family)
      : { status: 'idle' as const }
  })
  const assessment = computed<VaultAssessment | undefined>(() => entry.value.assessment)
  const fallbackReady = computed(() => {
    if (source.value === 'v3-metadata' || source.value === 'static') return true
    if (source.value !== 'v3') return false
    if (loadError.value || !chainId.value || !isVaultAssessmentAvailableForChain(chainId.value)) return true
    return entry.value.status === 'available' || entry.value.status === 'unavailable'
  })

  watch([canLoad, chainId, () => toValue(address)], ([enabled, id, target]) => {
    if (enabled && id) void loadVaultAssessment(id, target, family)
  }, { immediate: true })

  return { assessment, fallbackReady }
}
