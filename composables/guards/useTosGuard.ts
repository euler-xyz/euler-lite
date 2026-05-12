import { provide, reactive } from 'vue'
import type { Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { tosSignerReadAbi } from '~/abis/tos'
import { getTosData, type TosData } from '~/composables/useTosData'
import { injectTosSignature } from '~/utils/tos-injection'
import { registerOperationGuard, unregisterOperationGuard, registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'

export interface TosGuardState {
  isTermsRequired: boolean
  tosLoadFailed: boolean
  acceptTerms: () => void
}

export const useTosGuard = () => {
  if (!import.meta.client) return

  const { address } = useWagmi()
  const { eulerPeripheryAddresses, isReady, loadEulerConfig, chainId } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()
  const { enableTosSignature } = useDeployConfig()

  const hasSigned = useState<boolean | null>('tosGuardHasSigned', () => null)
  const sessionAccepted = useState<boolean>('tosGuardSessionAccepted', () => false)
  const tosLoadFailed = useState<boolean>('tosGuardLoadFailed', () => false)
  const tosData = ref<TosData | null>(null)
  let checkGeneration = 0

  const isTermsRequired = computed(() =>
    enableTosSignature && hasSigned.value === false && !sessionAccepted.value && !tosLoadFailed.value,
  )

  const tosSignerAddress = computed(() =>
    eulerPeripheryAddresses.value?.termsOfUseSigner as Address | undefined,
  )

  const checkHasSigned = async () => {
    const generation = ++checkGeneration
    const checkedAddress = address.value
    const checkedChainId = chainId.value

    const isCurrentCheck = () =>
      generation === checkGeneration
      && address.value === checkedAddress
      && chainId.value === checkedChainId

    if (!enableTosSignature) {
      hasSigned.value = true
      return
    }
    if (hasSigned.value === true) return
    if (!checkedAddress) {
      hasSigned.value = false
      return
    }
    if (!isReady.value) {
      await loadEulerConfig()
      if (!isCurrentCheck()) return
    }
    if (!tosSignerAddress.value) {
      tosLoadFailed.value = true
      hasSigned.value = null
      return
    }

    let data: TosData
    try {
      data = await getTosData()
      if (!isCurrentCheck()) return
      tosData.value = data
      tosLoadFailed.value = false
    }
    catch (e) {
      logWarn('tosGuard/loadTos', e)
      tosLoadFailed.value = true
      hasSigned.value = false
      return
    }

    try {
      const client = rpcClient.value!
      const lastSignTimestamp = await client.readContract({
        address: tosSignerAddress.value,
        abi: tosSignerReadAbi,
        functionName: 'lastTermsOfUseSignatureTimestamp',
        args: [checkedAddress as Address, data.tosMessageHash],
      })
      if (!isCurrentCheck()) return
      hasSigned.value = (lastSignTimestamp as bigint) > 0
    }
    catch (e) {
      logWarn('tosGuard/checkSignature', e)
      hasSigned.value = false
    }
  }

  const prefetchTosData = async () => {
    if (!enableTosSignature || tosData.value) return
    try {
      tosData.value = await getTosData()
      tosLoadFailed.value = false
    }
    catch (e) {
      logWarn('tosGuard/prefetchTos', e)
      tosLoadFailed.value = true
    }
  }

  const acceptTerms = () => {
    sessionAccepted.value = true
  }

  // Register/unregister the plan transformer
  const updateGuardRegistration = () => {
    const signer = tosSignerAddress.value
    const data = tosData.value
    const user = address.value

    if (sessionAccepted.value && !hasSigned.value && signer && data && user) {
      registerOperationGuard(
        'tos',
        plan => injectTosSignature(plan, signer, data.tosMessage, data.tosMessageHash, user as Address),
        { priority: 0 },
      )
    }
    else {
      unregisterOperationGuard('tos')
    }
  }

  // Register/unregister blocker — fail closed
  const updateBlockerRegistration = () => {
    if (enableTosSignature && tosLoadFailed.value) {
      registerOperationBlocker('tos', 'Unable to load Terms of Use')
    }
    else if (enableTosSignature && hasSigned.value === null) {
      registerOperationBlocker('tos', 'Checking Terms of Use signature')
    }
    else if (isTermsRequired.value) {
      registerOperationBlocker('tos', 'Terms of Use acceptance required')
    }
    else {
      unregisterOperationBlocker('tos')
    }
  }

  watch([sessionAccepted, hasSigned, tosSignerAddress, () => tosData.value, address], () => {
    updateGuardRegistration()
    updateBlockerRegistration()
  }, { immediate: true })

  watch(isTermsRequired, () => {
    updateBlockerRegistration()
  })

  watch(address, () => {
    checkGeneration++
    hasSigned.value = null
    sessionAccepted.value = false
    unregisterOperationGuard('tos')
    if (enableTosSignature) {
      void checkHasSigned()
    }
  })

  watch(chainId, () => {
    checkGeneration++
    hasSigned.value = null
    sessionAccepted.value = false
    unregisterOperationGuard('tos')
    if (enableTosSignature) {
      void checkHasSigned()
    }
  })

  onMounted(() => {
    if (enableTosSignature) {
      void prefetchTosData()
      void checkHasSigned()
    }
  })

  onUnmounted(() => {
    unregisterOperationGuard('tos')
    unregisterOperationBlocker('tos')
  })

  provide('tos-guard', reactive({
    isTermsRequired,
    tosLoadFailed,
    acceptTerms,
  }))
}
