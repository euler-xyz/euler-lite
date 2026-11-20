import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import { watchEffect } from 'vue'
import { isConfigHiddenVerdict } from '~/utils/vault-assessment/flagged'

export type HiddenVaultEvidenceTarget = { chainId: number, address: string, family: VaultAssessmentFamily }

export const useHiddenVaultEvidence = (targets: () => readonly HiddenVaultEvidenceTarget[]) => {
  const { isReady, source, visibility, ensureVaultAssessment } = useEulerLabels()
  watchEffect(() => {
    if (!isReady.value || source.value !== 'v3') return
    for (const { chainId, address, family } of targets()) {
      if (isConfigHiddenVerdict(visibility.value?.[address.toLowerCase()])) void ensureVaultAssessment(chainId, address, family)
    }
  })
}
