import { computed, provide, reactive, ref, watch, onUnmounted, type ComputedRef, type Ref } from 'vue'
import type { EulerEarn, EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getEulerLabelsVersion } from '~/composables/useEulerLabels'
import { registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { recordUnverifiedVaultAcknowledgement, unverifiedVaultAcknowledgementKey } from '~/features/reviewed-execution/policy/acknowledgements'

export interface UnverifiedVaultGuardState {
  isAcknowledgmentRequired: boolean
  acknowledgeRisk: () => void
}

interface UnverifiedVaultGuardContext {
  account: Ref<string | undefined>
  chainId: Ref<number | undefined>
  operation: ComputedRef<string>
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

  const acknowledgedContextKey = ref('')
  const blockerKey = `unverified-vault:${++unverifiedVaultGuardSequence}`
  let resolutionGeneration = 0

  watch([vaultAddresses, context.chainId], async ([addresses, activeChainId]) => {
    const generation = ++resolutionGeneration
    await Promise.all(addresses.map(address => getOrFetch(address)))
    if (generation !== resolutionGeneration || context.chainId.value !== activeChainId) return
  }, { immediate: true })

  const hasCanonicalVerification = (address: string): boolean => {
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
    return vaultAddresses.value.filter(address => !hasCanonicalVerification(address))
  })
  const hasUnverifiedVault = computed(() => unverifiedVaultAddresses.value.length > 0)

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

  const acknowledgeRisk = () => {
    const acknowledgement = acknowledgementContext.value
    if (!acknowledgement.chainId || !context.account.value) return
    recordUnverifiedVaultAcknowledgement({
      ...acknowledgement,
      account: context.account.value,
    })
    acknowledgedContextKey.value = contextKey.value
  }

  watch(isAcknowledgmentRequired, (required) => {
    if (required) {
      registerOperationBlocker(blockerKey, 'Unverified vault risk acknowledgment required')
    }
    else {
      unregisterOperationBlocker(blockerKey)
    }
  }, { immediate: true })

  onUnmounted(() => {
    unregisterOperationBlocker(blockerKey)
  })

  const guardState = reactive({
    isAcknowledgmentRequired,
    acknowledgeRisk,
  })
  provide('unverified-vault-guard', guardState)

  return guardState
}
