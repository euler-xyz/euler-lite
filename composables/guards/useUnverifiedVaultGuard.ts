import { computed, provide, reactive, ref, watch, onUnmounted, type ComputedRef, type Ref } from 'vue'
import type { EulerEarn, EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getEulerLabelsVersion } from '~/composables/useEulerLabels'
import { registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { deprecatedDepositAcknowledgementKey, recordDeprecatedDepositAcknowledgement, recordUnverifiedVaultAcknowledgement, unverifiedVaultAcknowledgementKey } from '~/features/reviewed-execution/policy/acknowledgements'
import { getKnownUnlistedActionNotice } from '~/utils/vault-assessment/presentation'
import { getVaultDeprecation } from '~/utils/eulerLabelsUtils'

export interface UnverifiedVaultGuardState {
  isAcknowledgmentRequired: boolean
  isDeprecatedDepositAcknowledgmentRequired: boolean
  deprecatedDepositNotice: string | null
  unlistedNotice: string | null
  isVerificationLoading: boolean
  verificationError: string | undefined
  retryVerification: () => Promise<void>
  acknowledgeRisk: () => void
  acknowledgeDeprecatedDeposit: () => void
}

interface UnverifiedVaultGuardContext {
  account: Ref<string | undefined>
  chainId: Ref<number | undefined>
  operation: ComputedRef<string>
  allowUnavailableLabels?: boolean
  depositedVaultAddresses?: ComputedRef<string[]>
}

let unverifiedVaultGuardSequence = 0

export const useUnverifiedVaultGuard = (
  vaultAddresses: ComputedRef<string[]>,
  context: UnverifiedVaultGuardContext,
) => {
  const { get, getOrFetch, registryVersion } = useVaultRegistry()
  const {
    isVaultGovernorVerified,
    isSecuritizeGovernorVerified,
    isEarnVaultOwnerVerified,
  } = useVaults()

  const { isReady: labelsReady, loadError: labelsError, retryLabels, source, visibility } = useEulerLabels()
  const isResolvingVaults = ref(false)
  const acknowledgedContextKey = ref('')
  const acknowledgedDeprecatedKey = ref('')
  const blockerKey = `unverified-vault:${++unverifiedVaultGuardSequence}`
  let resolutionGeneration = 0

  const resolveVaults = async () => {
    const generation = ++resolutionGeneration
    const activeChainId = context.chainId.value
    isResolvingVaults.value = true
    try {
      await Promise.all(vaultAddresses.value.map(address => getOrFetch(address)))
    }
    finally {
      if (generation === resolutionGeneration && context.chainId.value === activeChainId) {
        isResolvingVaults.value = false
      }
    }
  }
  watch([vaultAddresses, context.chainId], resolveVaults, { immediate: true })

  const hasVaultMetadata = computed(() => {
    void registryVersion.value
    return vaultAddresses.value.every((address) => {
      const entry = get(address)
      return !!entry && !!context.chainId.value && entry.vault.chainId === context.chainId.value
    })
  })
  const isVerificationReady = computed(() => (labelsReady.value || context.allowUnavailableLabels === true) && hasVaultMetadata.value)
  const isVerificationLoading = computed(() =>
    (!context.allowUnavailableLabels && !labelsReady.value && !labelsError.value) || (!hasVaultMetadata.value && isResolvingVaults.value),
  )
  const verificationError = computed(() => {
    if (!context.allowUnavailableLabels && !labelsReady.value && labelsError.value) return labelsError.value
    if (!hasVaultMetadata.value && !isResolvingVaults.value) return 'Unable to load vault verification. Please retry.'
    return undefined
  })
  const retryVerification = async () => {
    if (!labelsReady.value) await retryLabels()
    await resolveVaults()
  }

  const hasCanonicalVerification = (address: string): boolean => {
    if (!labelsReady.value) return false
    const entry = get(address)
    if (!entry || !context.chainId.value || entry.vault.chainId !== context.chainId.value) return false

    switch (entry.type) {
      case 'earn':
        return isEarnVaultOwnerVerified(entry.vault as EulerEarn)
      case 'securitize':
        return isSecuritizeGovernorVerified(entry.vault as SecuritizeCollateralVault)
      case 'evk':
        return isVaultGovernorVerified(entry.vault as EVault)
      default:
        return false
    }
  }

  const unverifiedVaultAddresses = computed(() => {
    void registryVersion.value
    getEulerLabelsVersion()
    return isVerificationReady.value
      ? vaultAddresses.value.filter(address => !hasCanonicalVerification(address))
      : []
  })
  const hasUnverifiedVault = computed(() => unverifiedVaultAddresses.value.length > 0)
  const unlistedNotice = computed(() => getKnownUnlistedActionNotice(
    unverifiedVaultAddresses.value,
    source.value,
    visibility.value,
  ))

  const acknowledgementContext = computed(() => ({
    chainId: context.chainId.value ?? 0,
    account: context.account.value ?? '0x0000000000000000000000000000000000000000',
    operation: context.operation.value,
    vaults: unverifiedVaultAddresses.value,
  }))
  const contextKey = computed(() => unverifiedVaultAcknowledgementKey(acknowledgementContext.value))

  const isAcknowledgmentRequired = computed(() =>
    hasUnverifiedVault.value && acknowledgedContextKey.value !== contextKey.value,
  )

  const deprecatedDepositAddresses = computed(() => {
    if (!labelsReady.value) return []
    getEulerLabelsVersion()
    return (context.depositedVaultAddresses?.value ?? []).filter(address => getVaultDeprecation(address).deprecated)
  })
  const deprecatedDepositContext = computed(() => ({
    ...acknowledgementContext.value,
    vaults: deprecatedDepositAddresses.value,
  }))
  const deprecatedContextKey = computed(() => deprecatedDepositAcknowledgementKey(deprecatedDepositContext.value))
  const isDeprecatedDepositAcknowledgmentRequired = computed(() =>
    deprecatedDepositAddresses.value.length > 0
    && acknowledgedDeprecatedKey.value !== deprecatedContextKey.value,
  )
  const deprecatedDepositNotice = computed(() => {
    const reasons = [...new Set(deprecatedDepositAddresses.value.map(address => getVaultDeprecation(address).reason))]
    return reasons.length ? reasons.join(' ') : null
  })

  const acknowledgeRisk = () => {
    const acknowledgement = acknowledgementContext.value
    if (!isVerificationReady.value || !acknowledgement.chainId || !context.account.value) return
    recordUnverifiedVaultAcknowledgement({
      ...acknowledgement,
      account: context.account.value,
    })
    acknowledgedContextKey.value = contextKey.value
  }
  const acknowledgeDeprecatedDeposit = () => {
    const acknowledgement = deprecatedDepositContext.value
    if (!isVerificationReady.value || !acknowledgement.chainId || !context.account.value || !acknowledgement.vaults.length) return
    recordDeprecatedDepositAcknowledgement({ ...acknowledgement, account: context.account.value })
    acknowledgedDeprecatedKey.value = deprecatedContextKey.value
  }

  const blockReason = computed(() => {
    if (verificationError.value) return verificationError.value
    if (!isVerificationReady.value) return 'Checking vault verification'
    if (isAcknowledgmentRequired.value) return 'Unverified vault risk acknowledgment required'
    if (isDeprecatedDepositAcknowledgmentRequired.value) return 'Deprecated vault deposit acknowledgment required'
    return undefined
  })
  watch(blockReason, (reason) => {
    if (reason) {
      registerOperationBlocker(blockerKey, reason)
    }
    else {
      unregisterOperationBlocker(blockerKey)
    }
  }, { immediate: true })

  onUnmounted(() => {
    resolutionGeneration++
    unregisterOperationBlocker(blockerKey)
  })

  const guardState = reactive({
    isAcknowledgmentRequired,
    isDeprecatedDepositAcknowledgmentRequired,
    deprecatedDepositNotice,
    unlistedNotice,
    isVerificationLoading,
    verificationError,
    retryVerification,
    acknowledgeRisk,
    acknowledgeDeprecatedDeposit,
  })
  provide('unverified-vault-guard', guardState)

  return guardState
}
