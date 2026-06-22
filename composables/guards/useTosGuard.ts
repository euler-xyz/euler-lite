import { provide, reactive } from 'vue'
import type { Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { tosSignerReadAbi } from '~/abis/tos'
import { getTosData, type TosData } from '~/composables/useTosData'
import { clearLiteTosSignature, setLiteTosSignature } from '~/utils/sdk-tos'
import { registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'

export interface TosGuardState {
  isTermsRequired: boolean
  tosLoadFailed: boolean
  acceptTerms: () => void
}

export const useTosGuard = () => {
  const { address } = useWagmi()
  const { eulerPeripheryAddresses, isReady, loadEulerConfig, chainId } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()
  const { enableTosSignature } = useDeployConfig()

  const hasSigned = useState<boolean | null>('tosGuardHasSigned', () => null)
  const sessionAccepted = useState<boolean>('tosGuardSessionAccepted', () => false)
  const tosLoadFailed = useState<boolean>('tosGuardLoadFailed', () => false)
  const tosData = ref<TosData | null>(null)

  const isTermsRequired = computed(() =>
    enableTosSignature && hasSigned.value === false && !sessionAccepted.value && !tosLoadFailed.value,
  )

  const tosSignerAddress = computed(() =>
    eulerPeripheryAddresses.value?.termsOfUseSigner as Address | undefined,
  )

  const checkHasSigned = async () => {
    if (!enableTosSignature) {
      hasSigned.value = true
      return
    }
    if (hasSigned.value === true) return
    if (!address.value) {
      hasSigned.value = false
      return
    }
    if (!isReady.value) {
      await loadEulerConfig()
    }
    if (!tosSignerAddress.value) {
      hasSigned.value = false
      return
    }

    let data: TosData
    try {
      data = await getTosData()
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
        authorizationList: undefined,
        args: [address.value as Address, data.tosMessageHash],
      })
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

  // Publish the accepted TOS signature to the SDK TOS plugin store. The SDK
  // prepends signTermsOfUse to evcBatch entries during plan construction;
  // Lite no longer mutates plans for TOS.
  const updateSdkSignature = () => {
    const data = tosData.value
    const user = address.value
    const cid = chainId.value

    if (sessionAccepted.value && !hasSigned.value && data && user && cid) {
      setLiteTosSignature({
        chainId: cid,
        account: user as Address,
        tosMessage: data.tosMessage,
        tosMessageHash: data.tosMessageHash,
      })
    }
    else if (user && cid) {
      clearLiteTosSignature({ chainId: cid, account: user as Address })
    }
  }

  // Register/unregister blocker — fail closed
  const updateBlockerRegistration = () => {
    if (enableTosSignature && tosLoadFailed.value) {
      registerOperationBlocker('tos', 'Unable to load Terms of Use')
    }
    else if (isTermsRequired.value) {
      registerOperationBlocker('tos', 'Terms of Use acceptance required')
    }
    else {
      unregisterOperationBlocker('tos')
    }
  }

  watch([sessionAccepted, hasSigned, tosSignerAddress, () => tosData.value, address, chainId], () => {
    updateSdkSignature()
    updateBlockerRegistration()
  }, { immediate: true })

  watch(isTermsRequired, () => {
    updateBlockerRegistration()
  })

  watch(address, (next, prev) => {
    hasSigned.value = null
    sessionAccepted.value = false
    if (prev && chainId.value) clearLiteTosSignature({ chainId: chainId.value, account: prev as Address })
    if (enableTosSignature) {
      void checkHasSigned()
    }
  })

  watch(chainId, (next, prev) => {
    hasSigned.value = null
    sessionAccepted.value = false
    if (prev && address.value) clearLiteTosSignature({ chainId: prev, account: address.value as Address })
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

  // NOTE: deliberately no signature clear on unmount. The acceptance is
  // session-scoped per (chain, account) — `sessionAccepted` survives navigation
  // — and the batch flow executes from the drawer/portfolio after the form page
  // (and its guard) is gone. Clearing here would strip signTermsOfUse from the
  // prepared batch. Account/chain switches are handled by the watches above.
  onUnmounted(() => {
    unregisterOperationBlocker('tos')
  })

  provide('tos-guard', reactive({
    isTermsRequired,
    tosLoadFailed,
    acceptTerms,
  }))
}
