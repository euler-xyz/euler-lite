import { useAccount, useDisconnect, useSwitchChain, useEnsName, useConfig } from '@wagmi/vue'
import { connect as connectWallet, getConnectors } from '@wagmi/vue/actions'
import { getAddress, isAddress, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { truncate } from '~/utils/string-utils'
import { useAddressScreen } from '~/composables/useAddressScreen'
import { parseChainId } from '~/entities/chainRegistry'
import { hasBaseAppInjectedProvider, selectBaseAppConnector } from '~/utils/base-app-wallet'

let isChangingChain = false
let chainChangeCooldownUntil = 0
let isRouterReplacing = false
let isInitialRouteSync = true
let hasWalletConnectedBefore = false
const isLoaded = ref(false)
const walletName = ref('Wallet')
const routeNetworkId: Ref<number | null> = ref(null)

let cachedWagmiData: ReturnType<typeof initializeWagmi> | null = null
let watchersInitialized = false

const parseChainIds = (value: unknown): number[] => {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(rawValues.flatMap((entry) => {
    if (typeof entry !== 'string') return []
    return entry.split(',').flatMap((part) => {
      const parsed = parseChainId(part.trim())
      return parsed == null ? [] : [parsed]
    })
  }))]
}

function initializeWagmi() {
  const { address: wagmiAddress, isConnected: wagmiIsConnected, connector, chain: wagmiChain, status } = useAccount()
  const { disconnect: wagmiDisconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const config = useConfig()
  const { screenConnectedAddress, resetScreeningCache, isAddressScreened } = useAddressScreen()

  const chainId = computed(() => wagmiChain.value?.id)

  // Route internal wagmi reads through the screened address so wallet-tied
  // queries (ENS, native balance) don't surface for an address whose
  // screening verdict isn't in yet.
  const screenedWagmiAddress: ComputedRef<Address | undefined> = computed(() =>
    isAddressScreened(wagmiAddress.value) ? (wagmiAddress.value || undefined) : undefined,
  )

  const { data: ensName } = useEnsName({
    address: screenedWagmiAddress,
    chainId: chainId.value,
  })

  // AppKit may be deferred-initialized (see plugins/00.wagmi.ts). Route
  // through the plugin-provided helper so the AppKit singleton is created
  // only on first connect for signed-out visitors.
  const modal = async () => {
    const nuxtApp = useNuxtApp()
    const open = nuxtApp.$openWalletModal as (() => Promise<void>) | undefined
    if (!open) {
      console.warn('[useWagmi] $openWalletModal not available — wallet plugin may not have loaded')
      return
    }
    await open()
  }

  const connectBaseAppInjectedWallet = async (): Promise<boolean> => {
    if (!hasBaseAppInjectedProvider()) {
      return false
    }

    const connector = selectBaseAppConnector(getConnectors(config))
    if (!connector) {
      return false
    }

    await connectWallet(config, { connector })
    return true
  }

  watch(wagmiAddress, (address, oldAddress) => {
    if (address && address !== oldAddress) {
      void screenConnectedAddress(address).catch(err => logWarn('useWagmi/screenConnectedAddress', err))
    }
    if (!address && oldAddress) {
      resetScreeningCache()
    }
  }, { immediate: true })

  return {
    wagmiAddress,
    wagmiIsConnected,
    connector,
    wagmiChain,
    status,
    wagmiDisconnect,
    switchChain,
    ensName,
    modal,
    connectBaseAppInjectedWallet,
    isAddressScreened,
  }
}

export const useWagmi = () => {
  if (!cachedWagmiData) {
    cachedWagmiData = initializeWagmi()
  }

  const route = useRoute()
  const router = useRouter()
  const {
    changeCurrentChainId,
    chainId: currentChainId,
    selectedChainIds,
    setSelectedChainIds,
    allowedChainIds,
  } = useEulerAddresses()
  const {
    wagmiAddress,
    wagmiIsConnected,
    connector,
    wagmiChain,
    status,
    wagmiDisconnect,
    switchChain,
    ensName,
    modal,
    connectBaseAppInjectedWallet,
    isAddressScreened,
  } = cachedWagmiData
  // Fail closed: a connected address only becomes user-visible once screening
  // returns a non-restricted verdict. Consumers that read `address`/`isConnected`
  // automatically see the gated state without each having to import useAddressScreen.
  const address: ComputedRef<Address | undefined> = computed(() =>
    isAddressScreened(wagmiAddress.value) ? (wagmiAddress.value || undefined) : undefined,
  )
  const isConnected = computed(() => Boolean(wagmiIsConnected.value && isAddressScreened(wagmiAddress.value)))
  const chain = computed(() => wagmiChain.value)
  const chainId = computed(() => wagmiChain.value?.id)

  const checksummedAddress = computed(() => {
    try {
      return address.value && isAddress(address.value) ? getAddress(address.value) : ''
    }
    catch {
      return address.value
    }
  })

  const friendlyAddress = computed(() => checksummedAddress.value)
  const shortAddress = computed(() => address.value ? truncate(address.value) : '')
  const shorterAddress = computed(() => address.value ? truncate(address.value, 3) : '')

  const displayName = computed(() => ensName.value || walletName.value)

  const getMainPathForRoute = (): string | null => {
    const path = route.path

    if (path.startsWith('/lend/')) {
      return '/lend'
    }

    if (path.startsWith('/earn/') && path !== '/earn') {
      return '/earn'
    }

    if (path.startsWith('/borrow/') && path !== '/borrow') {
      return '/borrow'
    }

    if (path.startsWith('/position/')) {
      return '/portfolio'
    }

    return null
  }

  const redirectToMainIfInternal = async (targetChainId: number) => {
    const mainPath = getMainPathForRoute()

    if (!mainPath) {
      return
    }

    await router.replace({
      path: mainPath,
      query: {
        ...route.query,
        network: targetChainId,
      },
      hash: route.hash,
    })
  }

  const disconnect = async () => {
    await wagmiDisconnect()
  }

  const connect = async () => {
    try {
      if (await connectBaseAppInjectedWallet()) {
        return
      }
    }
    catch (err) {
      logWarn('useWagmi/baseAppConnect', err)
    }

    modal().catch(err => logWarn('useWagmi/modal', err))
  }

  const syncRouteNetwork = async (targetChainId: number) => {
    if (routeNetworkId.value === targetChainId || isRouterReplacing) {
      return
    }

    isRouterReplacing = true
    await router.replace({
      path: route.path,
      query: {
        ...route.query,
        network: targetChainId,
      },
    })
    isRouterReplacing = false
  }

  const syncRouteNetworks = async (targetChainIds: readonly number[]) => {
    const normalized = [...new Set(targetChainIds)]
      .filter(id => allowedChainIds.value.includes(id))
      .sort((a, b) => a - b)
    const value = normalized.join(',')
    const currentValue = Array.isArray(route.query.networks)
      ? route.query.networks.join(',')
      : route.query.networks
    if (!value || currentValue === value || isRouterReplacing) {
      return
    }

    isRouterReplacing = true
    await router.replace({
      path: route.path,
      query: {
        ...route.query,
        networks: value,
      },
    })
    isRouterReplacing = false
  }

  const changeChain = async (targetChainId: number) => {
    if (!allowedChainIds.value.includes(targetChainId)) {
      logWarn('useWagmi', `chainId ${targetChainId} is not allowed`)
      return
    }

    // Re-selecting the active chain should be a no-op.
    if (targetChainId === currentChainId.value) {
      return
    }

    try {
      isChangingChain = true
      localStorage.setItem('chainId', String(targetChainId))
      changeCurrentChainId(targetChainId)
      localStorage.setItem('chainIds', selectedChainIds.value.join(','))
      await syncRouteNetwork(targetChainId)
      routeNetworkId.value = targetChainId
      if (!isInitialRouteSync) {
        await redirectToMainIfInternal(targetChainId)
      }
      if (isConnected.value) {
        await switchChain({ chainId: targetChainId })
      }
    }
    catch (error) {
      logWarn('useWagmi/changeChain', error, { severity: 'error' })
      throw error
    }
    finally {
      isChangingChain = false
      chainChangeCooldownUntil = Date.now() + 500
    }
  }

  const isConnecting = computed(() => status.value === 'connecting')
  const isReconnecting = computed(() => status.value === 'reconnecting')
  const isDisconnected = computed(() => status.value === 'disconnected')

  if (!watchersInitialized) {
    watchersInitialized = true

    watch([isConnected, connector], ([connected, conn]) => {
      if (connected && conn) {
        walletName.value = conn.name || 'Wallet'
      }

      if (connected && !isLoaded.value) {
        isLoaded.value = true
      }
      else {
        setTimeout(() => {
          isLoaded.value = true
        }, 5000)
      }
    }, { immediate: true })

    watch(computed(() => route.query.network), async (network, oldNetwork) => {
      if (isChangingChain || (!oldNetwork && !isInitialRouteSync)) {
        return
      }

      // Ignore route changes that arrive shortly after an app-initiated chain switch.
      // The wallet SDK or stale navigations can briefly revert the URL query param.
      if (Date.now() < chainChangeCooldownUntil) {
        return
      }

      const parsed = parseChainId(network)
      routeNetworkId.value = parsed && allowedChainIds.value.includes(parsed) ? parsed : null
      const targetChainId = routeNetworkId.value || allowedChainIds.value[0]

      // Skip if the route update targets the chain we're already on
      // (caused by app-initiated route syncs that fire after changeChain completes)
      if (targetChainId === currentChainId.value) {
        isInitialRouteSync = false
        return
      }

      await changeChain(targetChainId)
      isInitialRouteSync = false
    }, { immediate: true })

    watch(computed(() => route.query.networks), (networks) => {
      if (isRouterReplacing) return
      const parsed = parseChainIds(networks)
        .filter(id => allowedChainIds.value.includes(id))
      if (!parsed.length) return
      setSelectedChainIds(parsed)
      localStorage.setItem('chainIds', parsed.join(','))
    }, { immediate: true })

    watch(currentChainId, (val) => {
      if (!val) {
        return
      }

      syncRouteNetwork(val)
    }, { immediate: true })

    watch(selectedChainIds, (val) => {
      if (!val.length) return
      localStorage.setItem('chainIds', val.join(','))
      syncRouteNetworks(val)
    }, { immediate: true })

    watch(wagmiChain, async (val, oldVal) => {
      if (!val?.id || isChangingChain) {
        return
      }

      // Absorb stale wallet chainChanged events that arrive shortly after an
      // app-initiated chain switch. Some wallets fire delayed events for the
      // old chain after switchChain resolves.
      if (Date.now() < chainChangeCooldownUntil) {
        return
      }

      if (!allowedChainIds.value.includes(val.id)) {
        return
      }

      // Skip stale wallet events that report the chain we're already on.
      // The wallet fires chainChanged events asynchronously after switchChain resolves,
      // often including intermediate/duplicate events that would bounce chainId back.
      if (val.id === currentChainId.value) {
        return
      }

      // On initial wallet connection, app chain (from URL) takes priority
      const isInitialConnection = !hasWalletConnectedBefore && !oldVal?.id
      if (isInitialConnection) {
        hasWalletConnectedBefore = true
        if (currentChainId.value && currentChainId.value !== val.id) {
          isChangingChain = true
          try {
            await switchChain({ chainId: currentChainId.value })
          }
          catch {
            // Wallet rejected switch — fall back to wallet's chain
            changeCurrentChainId(val.id)
            localStorage.setItem('chainId', String(val.id))
            await syncRouteNetwork(val.id)
            routeNetworkId.value = val.id
          }
          finally {
            isChangingChain = false
          }
          return
        }
      }

      // Normal flow: user-initiated wallet chain change
      changeCurrentChainId(val.id)
      localStorage.setItem('chainId', String(val.id))
      routeNetworkId.value = val.id
      syncRouteNetwork(val.id)
    })

    watch(isConnected, (connected, wasConnected) => {
      if (wasConnected && !connected) {
        hasWalletConnectedBefore = false
      }
    })
  }

  return {
    isLoaded,
    isConnected,
    isConnecting,
    isReconnecting,
    isDisconnected,
    status,
    address,
    checksummedAddress,
    friendlyAddress,
    shortAddress,
    shorterAddress,
    walletName,
    displayName,
    ensName,
    connector,
    chain,
    chainId,
    modal,
    connect,
    disconnect,
    changeChain,
    switchChain,
  }
}
