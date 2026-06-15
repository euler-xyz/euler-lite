import type { ComputedRef } from 'vue'
import type { Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { tosSignerReadAbi } from '~/abis/tos'
import { getRlpTouData, type RlpTouData } from '~/composables/useRlpTouData'
import { clearLiteRlpTouSignature, setLiteRlpTouSignature } from '~/utils/sdk-rlp-tou'
import { registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { isVaultRlpRedemptionTou } from '~/utils/eulerLabelsUtils'

export interface RlpRedemptionTouGuardState {
  isTermsRequired: boolean
  tosLoadFailed: boolean
  acceptTerms: () => void
}

export const useRlpRedemptionTouGuard = (vaultAddresses: ComputedRef<string[]>) => {
  const { address } = useWagmi()
  const { eulerPeripheryAddresses, isReady, loadEulerConfig, chainId } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()
  const { enableRlpTouSignature } = useDeployConfig()

  const hasSigned = useState<boolean | null>('rlpTouGuardHasSigned', () => null)
  const sessionAccepted = useState<boolean>('rlpTouGuardSessionAccepted', () => false)
  const tosLoadFailed = useState<boolean>('rlpTouGuardLoadFailed', () => false)
  const tosData = ref<RlpTouData | null>(null)

  const hasTaggedVault = computed(() =>
    vaultAddresses.value.some(addr => isVaultRlpRedemptionTou(addr)),
  )

  const isActive = computed(() => enableRlpTouSignature && hasTaggedVault.value)

  const isTermsRequired = computed(() =>
    isActive.value && hasSigned.value === false && !sessionAccepted.value && !tosLoadFailed.value,
  )

  const tosSignerAddress = computed(() =>
    eulerPeripheryAddresses.value?.termsOfUseSigner as Address | undefined,
  )

  const checkHasSigned = async () => {
    if (!isActive.value) {
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

    let data: RlpTouData
    try {
      data = await getRlpTouData()
      tosData.value = data
      tosLoadFailed.value = false
    }
    catch (e) {
      logWarn('rlpTouGuard/loadTos', e)
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
        args: [address.value as Address, data.tosMessageHash],
      })
      hasSigned.value = (lastSignTimestamp as bigint) > 0
    }
    catch (e) {
      logWarn('rlpTouGuard/checkSignature', e)
      hasSigned.value = false
    }
  }

  const prefetchTosData = async () => {
    if (!isActive.value || tosData.value) return
    try {
      tosData.value = await getRlpTouData()
      tosLoadFailed.value = false
    }
    catch (e) {
      logWarn('rlpTouGuard/prefetchTos', e)
      tosLoadFailed.value = true
    }
  }

  const acceptTerms = () => {
    sessionAccepted.value = true
  }

  const updateSdkSignature = () => {
    const data = tosData.value
    const user = address.value
    const cid = chainId.value

    if (sessionAccepted.value && !hasSigned.value && data && user && cid) {
      setLiteRlpTouSignature({
        chainId: cid,
        account: user as Address,
        tosMessage: data.tosMessage,
        tosMessageHash: data.tosMessageHash,
      })
    }
    else if (user && cid) {
      clearLiteRlpTouSignature({ chainId: cid, account: user as Address })
    }
  }

  const updateBlockerRegistration = () => {
    if (isActive.value && tosLoadFailed.value) {
      registerOperationBlocker('rlp-tou', 'Unable to load RLP redemption Terms of Use')
    }
    else if (isTermsRequired.value) {
      registerOperationBlocker('rlp-tou', 'RLP redemption Terms of Use acceptance required')
    }
    else {
      unregisterOperationBlocker('rlp-tou')
    }
  }

  watch([sessionAccepted, hasSigned, tosSignerAddress, () => tosData.value, address, chainId, isActive], () => {
    updateSdkSignature()
    updateBlockerRegistration()
  }, { immediate: true })

  watch(isTermsRequired, () => {
    updateBlockerRegistration()
  })

  watch(isActive, (active) => {
    if (active) {
      void prefetchTosData()
      void checkHasSigned()
    }
    else {
      hasSigned.value = null
      sessionAccepted.value = false
      if (address.value && chainId.value) {
        clearLiteRlpTouSignature({ chainId: chainId.value, account: address.value as Address })
      }
    }
  })

  watch(address, (next, prev) => {
    hasSigned.value = null
    sessionAccepted.value = false
    if (prev && chainId.value) clearLiteRlpTouSignature({ chainId: chainId.value, account: prev as Address })
    if (isActive.value) {
      void checkHasSigned()
    }
  })

  watch(chainId, (next, prev) => {
    hasSigned.value = null
    sessionAccepted.value = false
    if (prev && address.value) clearLiteRlpTouSignature({ chainId: prev, account: address.value as Address })
    if (isActive.value) {
      void checkHasSigned()
    }
  })

  onMounted(() => {
    if (isActive.value) {
      void prefetchTosData()
      void checkHasSigned()
    }
  })

  onUnmounted(() => {
    if (address.value && chainId.value) {
      clearLiteRlpTouSignature({ chainId: chainId.value, account: address.value as Address })
    }
    unregisterOperationBlocker('rlp-tou')
  })

  provide('rlp-redemption-tou-guard', reactive({
    isTermsRequired,
    tosLoadFailed,
    acceptTerms,
  }))
}
