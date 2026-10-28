import { computed, toValue, type MaybeRefOrGetter } from 'vue'

interface PortfolioActivityRuntimeState {
  contextKey?: string
  unsupported: boolean
}

export const buildPortfolioActivityContextKey = (
  owner: string | null | undefined,
  chainId: number | string | null | undefined,
): string | undefined => {
  const resolvedChainId = Number(chainId)
  if (!owner || !Number.isSafeInteger(resolvedChainId) || resolvedChainId <= 0) return undefined
  return `${owner.toLowerCase()}:${resolvedChainId}`
}

export const shouldShowPortfolioActivityTab = (
  availabilityShouldRender: boolean,
  runtimeUnsupported: boolean,
): boolean => availabilityShouldRender && !runtimeUnsupported

export const shouldLeavePortfolioActivityRoute = ({
  routeName,
  isChecking,
  shouldShow,
}: {
  routeName: string | symbol | null | undefined
  isChecking: boolean
  shouldShow: boolean
}): boolean => routeName === 'portfolio-activity' && !isChecking && !shouldShow

export const usePortfolioActivityRuntimeSupport = (
  owner: MaybeRefOrGetter<string | null | undefined>,
  chainId: MaybeRefOrGetter<number | string | null | undefined>,
) => {
  const state = useState<PortfolioActivityRuntimeState>('portfolio-activity-runtime-support', () => ({
    unsupported: false,
  }))
  const contextKey = computed(() =>
    buildPortfolioActivityContextKey(toValue(owner), toValue(chainId)),
  )
  const isRuntimeUnsupported = computed(() =>
    Boolean(
      contextKey.value
      && state.value.contextKey === contextKey.value
      && state.value.unsupported,
    ),
  )

  const setRuntimeUnsupported = (unsupported: boolean) => {
    const key = contextKey.value
    if (!key) return
    state.value = { contextKey: key, unsupported }
  }

  const clearRuntimeUnsupported = () => {
    if (state.value.contextKey !== contextKey.value) return
    state.value = { unsupported: false }
  }

  return {
    clearRuntimeUnsupported,
    contextKey,
    isRuntimeUnsupported,
    setRuntimeUnsupported,
  }
}
