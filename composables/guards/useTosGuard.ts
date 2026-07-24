import { provide, reactive } from 'vue'
import { getAddress, type Address } from 'viem'
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

type TosSessionAcceptanceMap = Record<string, true>

export const TOS_ACCEPTANCE_PENDING_REASON = 'Checking Terms of Use acceptance'
export const TOS_LOAD_FAILED_REASON = 'Unable to load Terms of Use'
export const TOS_ACCEPTANCE_REQUIRED_REASON = 'Terms of Use acceptance required'

export const getTosSessionAcceptanceKey = ({
  chainId,
  address,
}: {
  chainId?: number
  address?: Address | string
}): string | undefined => {
  if (!chainId || !address) return undefined
  return `${chainId}:${getAddress(address as Address)}`
}

export const hasTosSessionAcceptance = (
  accepted: TosSessionAcceptanceMap,
  key: string | undefined,
): boolean => !!key && accepted[key] === true

export const withTosSessionAcceptance = (
  accepted: TosSessionAcceptanceMap,
  key: string | undefined,
): TosSessionAcceptanceMap => key ? { ...accepted, [key]: true } : accepted

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
  const sessionAcceptances = useState<TosSessionAcceptanceMap>('tosGuardSessionAcceptances', () => ({}))
  const tosLoadFailed = useState<boolean>('tosGuardLoadFailed', () => false)
  const tosData = ref<TosData | null>(null)
  const tosSessionAcceptanceKey = computed(() =>
    getTosSessionAcceptanceKey({ chainId: chainId.value, address: address.value }),
  )
  const sessionAccepted = computed(() =>
    hasTosSessionAcceptance(sessionAcceptances.value, tosSessionAcceptanceKey.value),
  )

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
    sessionAcceptances.value = withTosSessionAcceptance(
      sessionAcceptances.value,
      tosSessionAcceptanceKey.value,
    )
  }

  // Publish the accepted TOS signature to the SDK TOS plugin store. The SDK
  // prepends signTermsOfUse to evcBatch entries during plan construction;
  // Lite no longer mutates plans for TOS.
  const updateSdkSignature = () => {
    const data = tosData.value
    const user = address.value
    const cid = chainId.value

    if (sessionAccepted.value && hasSigned.value === false && data && user && cid) {
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
    if (prev && chainId.value) clearLiteTosSignature({ chainId: chainId.value, account: prev as Address })
    if (enableTosSignature) {
      void checkHasSigned()
    }
  })

  watch(chainId, (next, prev) => {
    hasSigned.value = null
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

  // NOTE: deliberately no signature clear on unmount. Acceptance keys are
  // session-scoped per (chain, account), and the batch flow executes from the
  // drawer/portfolio after the form page (and its guard) is gone. Clearing here
  // would strip signTermsOfUse from the prepared batch.
  onUnmounted(() => {
    unregisterOperationBlocker('tos')
  })

  provide('tos-guard', reactive({
    isTermsRequired,
    tosLoadFailed,
    acceptTerms,
  }))
}
