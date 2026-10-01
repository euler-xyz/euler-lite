import { isEulerEarn, isEVault, type VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import type { AnyVault } from '~/composables/useVaultRegistry'
import { useEulerLabels } from '~/composables/useEulerLabels'
import { getVaultCheckFindings } from '~/utils/vault-assessment/presentation'

const getAssessmentFamily = (vault: AnyVault): VaultAssessmentFamily | null =>
  isEulerEarn(vault) ? 'earn' : isEVault(vault) ? 'evk' : null

export const useDiscoveryVaultWarningDetails = () => {
  const {
    isReady, source, loadError, vaultAssessments,
    getVaultAssessmentEntry, loadVaultAssessment,
  } = useEulerLabels()

  const getWarningText = (vault: AnyVault | undefined, fallback?: string | null): string => {
    const summary = fallback || 'Vault checks need review'
    const family = vault && getAssessmentFamily(vault)
    if (!family || !isReady.value || source.value !== 'v3' || loadError.value) return summary

    // getEntry reads a non-reactive per-chain map; track its published snapshot.
    void vaultAssessments.value
    const entry = getVaultAssessmentEntry(vault.chainId, vault.address, family)
    if (entry.status !== 'available' || !entry.assessment?.assessed) return summary

    const findings = getVaultCheckFindings(entry.assessment)
    if (!findings.lines.length) return summary
    const lines = findings.lines.map(finding => `• ${finding.text}`)
    if (findings.moreCount) lines.push(`• ${findings.moreCount} more not shown`)
    return lines.join('\n')
  }

  const loadWarningDetails = (vault: AnyVault | undefined) => {
    const family = vault && getAssessmentFamily(vault)
    if (!vault || !family || !isReady.value || source.value !== 'v3' || loadError.value) return
    if (getVaultAssessmentEntry(vault.chainId, vault.address, family).status === 'idle') {
      void loadVaultAssessment(vault.chainId, vault.address, family)
    }
  }

  return { getWarningText, loadWarningDetails }
}
