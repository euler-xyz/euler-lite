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

let tosGuardInstanceSequence = 0

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
  const checkGeneration = useState<number>('tosGuardCheckGeneration', () => 0)
  const acceptanceContext = useState<string>('tosGuardAcceptanceContext', () => '')
  const tosData = ref<TosData | null>(null)
  const blockerKey = `tos:${++tosGuardInstanceSequence}`

  const syncAcceptanceContext = () => {
    const nextContext = `${chainId.value ?? 'none'}:${address.value?.toLowerCase() ?? 'none'}`
    if (acceptanceContext.value === nextContext) return
    acceptanceContext.value = nextContext
    checkGeneration.value += 1
    hasSigned.value = null
    sessionAccepted.value = false
    tosLoadFailed.value = false
    tosData.value = null
  }

  // Shared state survives navigation. Rebind it synchronously when a guard
  // mounts so an account/chain switch that happened between pages cannot
  // inherit acceptance from the previous context.
  syncAcceptanceContext()

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
    syncAcceptanceContext()
    const generation = ++checkGeneration.value
    const checkedAddress = address.value
    const checkedChainId = chainId.value
    const isCurrentCheck = () =>
      generation === checkGeneration.value
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
    syncAcceptanceContext()
    const generation = checkGeneration.value
    const prefetchedAddress = address.value
    const prefetchedChainId = chainId.value
    const isCurrentPrefetch = () =>
      generation === checkGeneration.value
      && address.value === prefetchedAddress
      && chainId.value === prefetchedChainId
    try {
      const data = await getTosData()
      if (!isCurrentPrefetch()) return
      tosData.value = data
      tosLoadFailed.value = false
    }
    catch (e) {
      if (!isCurrentPrefetch()) return
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
    if (reason) registerOperationBlocker(blockerKey, reason)
    else unregisterOperationBlocker(blockerKey)
  }, { immediate: true })

  watch([address, chainId], (_next, [previousAddress, previousChainId]) => {
    syncAcceptanceContext()
    if (previousAddress && previousChainId) {
      clearLiteTosSignature({ chainId: previousChainId, account: previousAddress as Address })
    }
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
    unregisterOperationBlocker(blockerKey)
  })

  const guardState = reactive({
    isTermsRequired,
    tosLoadFailed,
    acceptTerms,
  })
  provide('tos-guard', guardState)

  return guardState
}
