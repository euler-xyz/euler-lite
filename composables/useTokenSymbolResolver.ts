import type { Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { USD_ADDRESS, EUR_ADDRESS, BTC_ADDRESS, ETH_ADDRESS } from '~/entities/constants'
import { readErc20StringField } from '~/utils/erc20-metadata'
import { shortenAddress } from '~/utils/string-utils'

const resolvedSymbols: Ref<Map<string, string>> = shallowRef(new Map())
const pendingAddresses = new Set<string>()
const failedAddresses = new Set<string>()
let cachedRpcUrl: string | null = null

export const useTokenSymbolResolver = () => {
  const { client: rpcClient, rpcUrl } = useRpcClient()
  const { getAll } = useVaultRegistry()

  const ensureClient = () => {
    if (cachedRpcUrl !== rpcUrl.value) {
      cachedRpcUrl = rpcUrl.value
      resolvedSymbols.value = new Map()
      pendingAddresses.clear()
      failedAddresses.clear()
    }
    return rpcClient.value!
  }

  const buildKnownSymbols = (): Map<string, string> => {
    const map = new Map<string, string>()

    map.set(USD_ADDRESS.toLowerCase(), 'USD')
    map.set(EUR_ADDRESS.toLowerCase(), 'EUR')
    map.set(BTC_ADDRESS.toLowerCase(), 'BTC')
    map.set(ETH_ADDRESS.toLowerCase(), 'ETH')

    getAll().forEach(({ vault }) => {
      if (vault.asset?.address && vault.asset?.symbol) {
        map.set(vault.asset.address.toLowerCase(), vault.asset.symbol)
      }
    })

    return map
  }

  const lazyResolveSymbol = (address: string) => {
    const key = address.toLowerCase()
    if (pendingAddresses.has(key)) return
    if (resolvedSymbols.value.has(key)) return
    if (failedAddresses.has(key)) return

    pendingAddresses.add(key)
    const client = ensureClient()

    readErc20StringField(client, address as Address, 'symbol')
      .then((symbol) => {
        if (!symbol) {
          failedAddresses.add(key)
          return
        }
        const updated = new Map(resolvedSymbols.value)
        updated.set(key, symbol)
        resolvedSymbols.value = updated
      })
      .catch((error: unknown) => {
        failedAddresses.add(key)
        logWarn('tokenSymbolResolver', error)
      })
      .finally(() => {
        pendingAddresses.delete(key)
      })
  }

  const resolveSymbol = (address: Address | string, knownSymbols: Map<string, string>): string => {
    const key = address.toLowerCase()

    const known = knownSymbols.get(key)
    if (known) return known

    const resolved = resolvedSymbols.value.get(key)
    if (resolved) return resolved

    lazyResolveSymbol(address)
    return shortenAddress(address)
  }

  return {
    buildKnownSymbols,
    resolveSymbol,
    shortenAddress,
  }
}
