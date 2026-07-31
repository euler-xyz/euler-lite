import type {
  ActivityCapabilities,
  ActivityScopeSupport,
  ActivityVaultType,
} from '@eulerxyz/euler-v2-sdk'
import {
  computed,
  onScopeDispose,
  ref,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue'

export type ActivityAvailabilityScope
  = | { kind: 'account' }
    | { kind: 'vault', vaultType: ActivityVaultType }

export type ActivityAvailabilityReason
  = | 'invalid-chain'
    | 'v3-disabled'
    | 'source-not-configured'
    | 'unsupported-scope'
    | 'capability-check-failed'

export const useActivityAvailability = (
  scope: MaybeRefOrGetter<ActivityAvailabilityScope>,
  chainId: MaybeRefOrGetter<number | string | null | undefined>,
) => {
  const { isV3EnabledForChain } = useV3ChainGate()
  const capabilities = shallowRef<ActivityCapabilities>()
  const isChecking = ref(false)
  const isSupported = ref(false)
  const scopeSupport = ref<ActivityScopeSupport>()
  const reason = ref<ActivityAvailabilityReason>()
  let activeRequestId = 0

  const resolvedChainId = computed(() => Number(toValue(chainId)))
  const scopeKey = computed(() => {
    const value = toValue(scope)
    return value.kind === 'account' ? 'account' : `vault:${value.vaultType}`
  })
  const shouldRender = computed(() =>
    isSupported.value || reason.value === 'capability-check-failed',
  )

  const checkAvailability = async ({ preserveCapabilityFailure = false } = {}) => {
    const requestId = ++activeRequestId
    const targetChainId = resolvedChainId.value
    const targetScope = toValue(scope)
    const keepCapabilityFailure = preserveCapabilityFailure
      && reason.value === 'capability-check-failed'

    capabilities.value = undefined
    isSupported.value = false
    scopeSupport.value = undefined
    if (!keepCapabilityFailure) reason.value = undefined

    if (!Number.isSafeInteger(targetChainId) || targetChainId <= 0) {
      reason.value = 'invalid-chain'
      isChecking.value = false
      return
    }
    if (!isV3EnabledForChain(targetChainId)) {
      reason.value = 'v3-disabled'
      isChecking.value = false
      return
    }

    isChecking.value = true
    try {
      const { getEulerSdkForChain } = useEulerSdk()
      const sdk = await getEulerSdkForChain(targetChainId)
      if (requestId !== activeRequestId) return

      const activityService = sdk.activityService
      const nextCapabilities = activityService.getCapabilities()
      capabilities.value = nextCapabilities
      if (!nextCapabilities.configured) {
        reason.value = nextCapabilities.reason === 'source-not-configured'
          ? 'source-not-configured'
          : 'v3-disabled'
        return
      }

      const routeShapeSupported = targetScope.kind === 'account'
        ? nextCapabilities.canQueryAccount
        : nextCapabilities.requestableVaultTypes.includes(targetScope.vaultType)
      if (!routeShapeSupported) {
        reason.value = 'unsupported-scope'
        return
      }

      const nextScopeSupport = activityService.getScopeSupport(targetScope.kind === 'account'
        ? { kind: 'account', chainId: targetChainId }
        : { kind: 'vault', chainId: targetChainId, vaultType: targetScope.vaultType })
      scopeSupport.value = nextScopeSupport
      // `unknown` means the route is requestable and response coverage is the
      // authority. Only an explicit unsupported result hides the surface.
      isSupported.value = nextScopeSupport !== 'unsupported'
      reason.value = isSupported.value ? undefined : 'unsupported-scope'
    }
    catch {
      if (requestId !== activeRequestId) return
      reason.value = 'capability-check-failed'
    }
    finally {
      if (requestId === activeRequestId) isChecking.value = false
    }
  }

  watch([resolvedChainId, scopeKey], () => {
    void checkAvailability()
  }, { immediate: true })

  const refreshAvailability = () => checkAvailability({ preserveCapabilityFailure: true })

  onScopeDispose(() => {
    activeRequestId++
  })

  return {
    capabilities,
    isChecking,
    isSupported,
    reason,
    shouldRender,
    scopeSupport,
    refreshAvailability,
  }
}
