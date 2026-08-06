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

interface TosRequirementState {
  hasWalletAddress: boolean
  enableTosSignature: boolean
  hasSigned: boolean | null
  sessionAccepted: boolean
  tosLoadFailed: boolean
}

export const TOS_ACCEPTANCE_PENDING_REASON = 'Checking Terms of Use acceptance'
export const TOS_LOAD_FAILED_REASON = 'Unable to load Terms of Use'
export const TOS_ACCEPTANCE_REQUIRED_REASON = 'Terms of Use acceptance required'

export const isTosAcceptanceRequired = ({
  hasWalletAddress,
  enableTosSignature,
  hasSigned,
  sessionAccepted,
  tosLoadFailed,
}: TosRequirementState): boolean =>
  hasWalletAddress
  && enableTosSignature
  && hasSigned === false
  && !sessionAccepted
  && !tosLoadFailed

export const getTosBlockReason = ({
  hasWalletAddress,
  enableTosSignature,
  hasSigned,
  sessionAccepted,
  tosLoadFailed,
}: TosRequirementState): string | undefined => {
  if (!hasWalletAddress || !enableTosSignature) return undefined
  if (tosLoadFailed) return TOS_LOAD_FAILED_REASON
  if (hasSigned === null) return TOS_ACCEPTANCE_PENDING_REASON
  if (hasSigned === false && !sessionAccepted) return TOS_ACCEPTANCE_REQUIRED_REASON
  return undefined
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
  let checkGeneration = 0

  const tosRequirementState = computed<TosRequirementState>(() => ({
    hasWalletAddress: !!address.value,
    enableTosSignature,
    hasSigned: hasSigned.value,
    sessionAccepted: sessionAccepted.value,
    tosLoadFailed: tosLoadFailed.value,
  }))
  const isTermsRequired = computed(() => isTosAcceptanceRequired(tosRequirementState.value))
  const tosBlockReason = computed(() => getTosBlockReason(tosRequirementState.value))

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
    const signerAddress = tosSignerAddress.value
    if (!signerAddress) {
      hasSigned.value = false
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
      if (!isCurrentCheck()) return
      logWarn('tosGuard/loadTos', e)
      tosLoadFailed.value = true
      hasSigned.value = false
      return
    }

    try {
      const client = rpcClient.value!
      const lastSignTimestamp = await client.readContract({
        address: signerAddress,
        abi: tosSignerReadAbi,
        functionName: 'lastTermsOfUseSignatureTimestamp',
        authorizationList: undefined,
        args: [checkedAddress as Address, data.tosMessageHash],
      })
      if (!isCurrentCheck()) return
      hasSigned.value = (lastSignTimestamp as bigint) > 0
    }
    catch (e) {
      if (!isCurrentCheck()) return
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

  watch([sessionAccepted, hasSigned, tosSignerAddress, () => tosData.value, address, chainId], () => {
    updateSdkSignature()
  }, { immediate: true })

  // Keep execution fail-closed while the connected account's signature state
  // is pending or TOS data is unavailable, without showing the acceptance UI
  // until the account is confirmed unsigned.
  watch(tosBlockReason, (reason) => {
    if (reason) registerOperationBlocker('tos', reason)
    else unregisterOperationBlocker('tos')
  }, { immediate: true })

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
