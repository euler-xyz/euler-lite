import type { Component, ComputedRef, Ref } from 'vue'
import { logWarn } from '~/utils/errorHandling'
import type { DisplayStep, StepAssetInfo } from '~/utils/stepDecoding'
import type { ModalData } from '~/components/ui/composables/useModal'
import type {
  CowSwapCancellationMode,
  CowSwapCancellationStatus,
  CowSwapExecutionStatus,
  CowSwapOrderStatus,
  CowSwapOrderUid,
} from '~/entities/cowswap'
import { APPROVE_RESET_REQUIRED_TOKENS } from '~/entities/constants'
import { CowSwapReviewModal } from '#components'

type CowSwapExecutionRef<TExecuteParams> = {
  status: Ref<CowSwapExecutionStatus>
  error: Ref<Error | null>
  explorerUrl: ComputedRef<string | undefined>
  locallyCancelled: Ref<boolean>
  cancellationMode: Ref<CowSwapCancellationMode | undefined>
  cancellationStatus: Ref<CowSwapCancellationStatus>
  executeAsync: (params: TExecuteParams) => Promise<CowSwapOrderUid>
  cancelOrder: () => Promise<void>
}

type CowSwapOrderStatusRef = {
  orderStatus: Ref<CowSwapOrderStatus | null>
}

/**
 * Build approval DisplaySteps for CoW review modal. When the token requires
 * a reset-to-zero before re-approving (e.g. USDT), prepends a "Reset approval" step.
 */
export const buildApprovalSignSteps = (params: {
  tokenAddress: string
  currentAllowance: bigint
  requiredAmount: bigint
  label: string
  assetInfo: StepAssetInfo
  startIndex: number
}): { steps: DisplayStep[], nextIndex: number } => {
  const steps: DisplayStep[] = []
  let idx = params.startIndex

  if (params.currentAllowance >= params.requiredAmount) {
    return { steps, nextIndex: idx }
  }

  const needsReset = params.currentAllowance > 0n
    && APPROVE_RESET_REQUIRED_TOKENS.has(params.tokenAddress.toLowerCase())

  if (needsReset) {
    steps.push({
      index: idx++,
      label: 'Reset approval',
      isSeparateTx: true,
      assetInfo: params.assetInfo,
    })
  }

  steps.push({
    index: idx++,
    label: params.label,
    isSeparateTx: true,
    assetInfo: params.assetInfo,
  })

  return { steps, nextIndex: idx }
}

let mooolerAudio: HTMLAudioElement | null = null
let mooolerUnlocked = false

if (typeof window !== 'undefined') {
  mooolerAudio = new Audio('/sounds/moooler.wav')
  mooolerAudio.preload = 'auto'

  const unlock = () => {
    if (!mooolerAudio || mooolerUnlocked) return
    const prevVolume = mooolerAudio.volume
    mooolerAudio.volume = 0
    mooolerAudio.play().then(() => {
      mooolerAudio!.pause()
      mooolerAudio!.currentTime = 0
      mooolerAudio!.volume = prevVolume
      mooolerUnlocked = true
    }).catch(() => {
      if (mooolerAudio) mooolerAudio.volume = prevVolume
    })
  }

  const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart']
  for (const ev of events) {
    window.addEventListener(ev, unlock, { capture: true, passive: true })
  }
}

const playMooolerSound = () => {
  if (!mooolerAudio) return
  try {
    mooolerAudio.currentTime = 0
    void mooolerAudio.play().catch((err) => {
      logWarn('cowswap/moooler-play-blocked', err)
    })
  }
  catch (err) {
    logWarn('cowswap/moooler-play-throw', err)
  }
}

export const openCowSwapReviewModal = <TExecuteParams>(
  modal: { open: (component: Component, options?: ModalData) => void },
  options: {
    signSteps: DisplayStep[]
    wrapperSteps: DisplayStep[]
    walletWarningsDescription: string
    execution: CowSwapExecutionRef<TExecuteParams>
    orderStatus: CowSwapOrderStatusRef
    executeParams: TExecuteParams
    quoteFetchedAt?: number | null
    logPrefix: string
  },
) => {
  playMooolerSound()
  modal.open(CowSwapReviewModal, {
    isNotClosable: true,
    closeOnBackdropWhenAllowed: true,
    props: {
      signSteps: options.signSteps,
      wrapperSteps: options.wrapperSteps,
      walletWarningsDescription: options.walletWarningsDescription,
      executionStatus: options.execution.status,
      executionError: options.execution.error,
      explorerUrl: options.execution.explorerUrl,
      orderStatus: options.orderStatus.orderStatus,
      locallyCancelled: options.execution.locallyCancelled,
      cancellationMode: options.execution.cancellationMode,
      cancellationStatus: options.execution.cancellationStatus,
      quoteFetchedAt: options.quoteFetchedAt,
      onConfirm: async () => {
        try {
          await options.execution.executeAsync(options.executeParams)
        }
        catch (e) {
          logWarn(`${options.logPrefix}/execute`, e)
        }
      },
      onCancel: async () => {
        try {
          await options.execution.cancelOrder()
        }
        catch (e) {
          logWarn(`${options.logPrefix}/cancel`, e)
        }
      },
    },
  })
}
