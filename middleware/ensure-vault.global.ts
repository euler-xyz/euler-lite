import { getAddress } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { useToast } from '~/components/ui/composables/useToast'
import { getDefaultPageRoute } from '~/entities/menu'
import { parseChainId } from '~/entities/chainRegistry'

const normalizeParam = (value: unknown) => (Array.isArray(value) ? value[0] : value)

const getDefaultRoute = () => {
  const { enableEarnPage, enableLendPage, enableExplorePage } = useDeployConfig()
  return getDefaultPageRoute(enableEarnPage, enableLendPage, enableExplorePage)
}

const scheduleVaultCheck = (vaultParam: string, path: string, expectedChainId: number | null) => {
  const router = useRouter()

  setTimeout(async () => {
    const { info } = useToast()
    const { getVault, getSecuritizeVault, isSecuritizeVault } = useVaults()
    const { chainId } = useEulerAddresses()

    if (path.includes('earn')) {
      return
    }

    const route = router.currentRoute.value

    const currentVault = normalizeParam(route.params?.vault)
    if (!currentVault || String(currentVault) !== vaultParam) {
      return
    }

    if (route.path !== path) {
      return
    }

    if (expectedChainId !== null && chainId.value !== expectedChainId) {
      return
    }

    try {
      const vaultAddress = getAddress(String(currentVault))
      if (await isSecuritizeVault(vaultAddress)) {
        await getSecuritizeVault(vaultAddress)
      }
      else {
        await getVault(vaultAddress)
      }
    }
    catch {
      const latestRoute = router.currentRoute.value

      if (latestRoute.path !== path) {
        return
      }

      if (expectedChainId !== null && chainId.value !== expectedChainId) {
        return
      }

      info('This vault could not be found on this chain!')
      void navigateTo({
        name: getDefaultRoute(),
        query: { ...latestRoute.query },
        hash: latestRoute.hash,
      }, { replace: true })
    }
  }, 0)
}

export default defineNuxtRouteMiddleware(async (to, from) => {
  const { info } = useToast()
  if (import.meta.server) {
    return
  }

  // Zip Code demo routes have no vault param; skip the vault-existence check.
  if (to.path.startsWith('/zipcode')) {
    return
  }

  if (from && to.path === from.path) {
    const toVaultParam = normalizeParam(to.params?.vault)
    const fromVaultParam = normalizeParam(from.params?.vault)
    if (toVaultParam === fromVaultParam) {
      const toNetworkId = parseChainId(to.query.network)
      const fromNetworkId = parseChainId(from.query.network)
      if (toVaultParam && toNetworkId !== fromNetworkId) {
        scheduleVaultCheck(String(toVaultParam), to.path, toNetworkId)
      }
      return
    }
  }

  const rawVault = to.params?.vault
  if (!rawVault) {
    return
  }

  let vaultAddress: string | null = null
  try {
    vaultAddress = getAddress(String(normalizeParam(rawVault)))
  }
  catch {
    info('This vault could not be found on this chain!')
    return navigateTo({
      name: getDefaultRoute(),
      query: { ...to.query },
      hash: to.hash,
    }, { replace: true })
  }

  const { getVault, getSecuritizeVault, isSecuritizeVault } = useVaults()

  if (!to.path.includes('earn') && vaultAddress) {
    try {
      if (await isSecuritizeVault(vaultAddress)) {
        await getSecuritizeVault(vaultAddress)
      }
      else {
        await getVault(vaultAddress)
      }
    }
    catch {
      logWarn('ensure-vault', 'failed to load vault')
      info('This vault could not be found on this chain!')
      return navigateTo({
        name: getDefaultRoute(),
        query: { ...to.query },
        hash: to.hash,
      }, { replace: true })
    }
  }
})
