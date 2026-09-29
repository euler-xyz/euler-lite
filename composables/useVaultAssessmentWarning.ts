import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import { toValue, type MaybeRefOrGetter } from 'vue'
import { getCriticalAssessmentWarning } from '~/utils/vault-assessment/presentation'

export const useVaultAssessmentWarning = (
  address: MaybeRefOrGetter<string>,
  family: VaultAssessmentFamily = 'evk',
) => {
  const { chainId } = useEulerAddresses()
  const {
    isReady,
    loadError,
    source,
    vaultAssessments,
    getVaultAssessmentEntry,
    loadVaultAssessment,
  } = useEulerLabels()
  const { isV3EnabledForChain } = useV3ChainGate()
  const enabled = computed(() => !!chainId.value && isReady.value && !loadError.value
    && source.value === 'v3' && isV3EnabledForChain(chainId.value))
  const entry = computed(() => {
    void vaultAssessments.value
    const vaultAddress = toValue(address)
    return enabled.value && chainId.value && vaultAddress
      ? getVaultAssessmentEntry(chainId.value, vaultAddress, family)
      : { status: 'idle' as const }
  })
  const warning = computed(() => entry.value.status === 'available'
    ? getCriticalAssessmentWarning(entry.value.assessment)
    : null)

  watch(
    () => [enabled.value, chainId.value, toValue(address)] as const,
    ([canLoad, id, vaultAddress]) => {
      if (canLoad && id && vaultAddress) void loadVaultAssessment(id, vaultAddress, family)
    },
    { immediate: true },
  )

  return { warning, entry }
}
