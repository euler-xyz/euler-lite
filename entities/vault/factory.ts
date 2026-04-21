import axios from 'axios'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { logWarn } from '~/utils/errorHandling'

// Client-side in-memory cache keyed by `${chainId}:${lowercaseAddress}`.
// Factories are immutable per vault, so entries never need to expire within a session.
const vaultFactoryCache = new Map<string, string>()

const getChainId = (): number | null => {
  try {
    const { chainId } = useEulerAddresses()
    return chainId.value ?? null
  }
  catch {
    return null
  }
}

const cacheKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

const postFactories = async (
  chainId: number,
  addresses: string[],
): Promise<Record<string, string>> => {
  try {
    const { data } = await axios.post('/api/vault-factories', { chainId, addresses })
    return (data?.factories ?? {}) as Record<string, string>
  }
  catch (e) {
    logWarn('fetchVaultFactories', 'Proxy request failed:', e)
    return {}
  }
}

// Fetch vault factory for a single vault
export const fetchVaultFactory = async (vaultAddress: string): Promise<string | null> => {
  const chainId = getChainId()
  if (!chainId) return null

  const key = cacheKey(chainId, vaultAddress)
  const cached = vaultFactoryCache.get(key)
  if (cached) return cached

  const factories = await postFactories(chainId, [vaultAddress])
  const factory = factories[vaultAddress.toLowerCase()]
  if (factory) {
    vaultFactoryCache.set(key, factory)
    return factory
  }
  return null
}

// Check if vault is a securitize vault - first checks registry, then falls back to subgraph
export const isSecuritizeVault = async (address: string): Promise<boolean> => {
  try {
    // First check the vault registry (if populated)
    const { getType } = useVaultRegistry()
    const registryType = getType(address)
    if (registryType) {
      return registryType === 'securitize'
    }

    // Fall back to subgraph query — wait for addresses to load
    const { eulerPeripheryAddresses, isReady, loadEulerConfig } = useEulerAddresses()
    if (!isReady.value) {
      loadEulerConfig()
      await until(computed(() => isReady.value)).toBeTruthy()
    }
    const securitizeFactory = eulerPeripheryAddresses.value?.securitizeFactory
    if (!securitizeFactory) {
      return false
    }

    const factory = await fetchVaultFactory(address)
    if (!factory) {
      return false
    }
    return factory.toLowerCase() === securitizeFactory.toLowerCase()
  }
  catch {
    return false
  }
}

// Synchronous check using cached factory data
export const isSecuritizeVaultSync = (address: string): boolean => {
  const { eulerPeripheryAddresses } = useEulerAddresses()
  const securitizeFactory = eulerPeripheryAddresses.value?.securitizeFactory
  if (!securitizeFactory) {
    return false
  }

  const chainId = getChainId()
  if (!chainId) return false

  const factory = vaultFactoryCache.get(cacheKey(chainId, address))
  if (!factory) {
    return false
  }
  return factory.toLowerCase() === securitizeFactory.toLowerCase()
}

// Batch fetch vault factories via the server proxy
export const fetchVaultFactories = async (
  vaultAddresses: string[],
): Promise<Map<string, string>> => {
  const result = new Map<string, string>()

  if (!vaultAddresses.length) {
    return result
  }

  const chainId = getChainId()
  if (!chainId) return result

  const uncachedAddresses: string[] = []
  vaultAddresses.forEach((addr) => {
    const lower = addr.toLowerCase()
    const cached = vaultFactoryCache.get(cacheKey(chainId, lower))
    if (cached) {
      result.set(lower, cached)
    }
    else {
      uncachedAddresses.push(lower)
    }
  })

  if (!uncachedAddresses.length) {
    return result
  }

  const factories = await postFactories(chainId, uncachedAddresses)
  for (const [addr, factory] of Object.entries(factories)) {
    vaultFactoryCache.set(cacheKey(chainId, addr), factory)
    result.set(addr, factory)
  }

  return result
}

// Get all securitize vault addresses from a list of addresses
export const filterSecuritizeVaults = async (vaultAddresses: string[]): Promise<string[]> => {
  const { eulerPeripheryAddresses } = useEulerAddresses()
  const securitizeFactory = eulerPeripheryAddresses.value?.securitizeFactory
  if (!securitizeFactory) {
    return []
  }

  const factories = await fetchVaultFactories(vaultAddresses)
  const securitizeAddresses: string[] = []

  factories.forEach((factory, address) => {
    if (factory.toLowerCase() === securitizeFactory.toLowerCase()) {
      securitizeAddresses.push(address)
    }
  })

  return securitizeAddresses
}
