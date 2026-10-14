import {
  applyEulerLabelVaultOverrides,
  isEulerEarn,
  isEVault,
  isSecuritizeCollateralVault,
  type EulerLabelProduct,
  type EVault,
} from '@eulerxyz/euler-v2-sdk'
import type { RouteLocationRaw } from 'vue-router'
import { getProductByVault } from '~/utils/eulerLabelsUtils'
import { shortenAddress } from '~/utils/string-utils'
import { formatVaultReferenceName, getOraclePairCollateral, getVaultCheckSubject } from '~/utils/vault-assessment/subjects'
import { oracleAdapterAnchor, type VaultCheckLine } from '~/utils/vault-assessment/presentation'

export interface VaultReferenceTarget {
  kind: 'vault' | 'adapter' | 'address'
  label: string
  to?: RouteLocationRaw
}

const RETRY_FAILED_AFTER_MS = 5 * 60_000
const failedLookups = new Map<string, number>()
const pendingAdapterLookups = new Set<string>()

const lookupKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`
const recentlyFailed = (key: string) => {
  const at = failedLookups.get(key)
  return at !== undefined && Date.now() - at < RETRY_FAILED_AFTER_MS
}

export const useVaultReferences = () => {
  const route = useRoute()
  const { chainId } = useEulerAddresses()
  const { get, getOrFetch, getVaultCategory, registryVersion } = useVaultRegistry()
  const { oracleAdapters, loadOracleAdapters } = useEulerLabels()

  const networkQuery = () => route.query.network ? { network: route.query.network } : {}

  const productName = (address: string): string | undefined => {
    const product = getProductByVault(address)
    if (!product.name) return undefined
    return (applyEulerLabelVaultOverrides(product, address) as EulerLabelProduct).name || undefined
  }

  const describe = (address: string, fallback?: string): VaultReferenceTarget => {
    void registryVersion.value
    const vault = get(address)?.vault
    if (vault) {
      const label = formatVaultReferenceName({
        productName: productName(address),
        sharesName: vault.shares?.name,
        assetSymbol: vault.asset?.symbol,
        escrow: getVaultCategory(address) === 'escrow',
      }) ?? fallback ?? shortenAddress(address)
      if (isSecuritizeCollateralVault(vault)) return { kind: 'vault', label }
      const path = isEulerEarn(vault) ? `/earn/${vault.address}` : `/lend/${vault.address}`
      return { kind: 'vault', label, to: { path, query: networkQuery() } }
    }
    const adapter = oracleAdapters[address.toLowerCase()]
    const adapterLabel = adapter?.label || adapter?.name
    if (adapterLabel) return { kind: 'adapter', label: adapterLabel }
    return { kind: 'address', label: fallback ?? shortenAddress(address) }
  }

  /** The registry dedupes in-flight lookups and may be cleared, so only failures are remembered here. */
  const ensureVaults = (addresses: readonly string[]) => {
    const id = chainId.value
    if (!id) return
    for (const address of new Set(addresses.map(item => item.toLowerCase()))) {
      const key = lookupKey(id, address)
      if (get(address) || recentlyFailed(key)) continue
      getOrFetch(address)
        .then((vault) => {
          if (!vault) failedLookups.set(key, Date.now())
        })
        .catch(() => failedLookups.set(key, Date.now()))
    }
  }

  const ensureAdapters = (addresses: readonly string[]) => {
    const id = chainId.value
    if (!id) return
    const missing = [...new Set(addresses.map(item => item.toLowerCase()))].filter((address) => {
      const key = lookupKey(id, address)
      return !oracleAdapters[address] && !pendingAdapterLookups.has(key) && !recentlyFailed(key)
    })
    if (!missing.length) return
    missing.forEach(address => pendingAdapterLookups.add(lookupKey(id, address)))
    loadOracleAdapters(id, missing)
      .catch(() => {})
      .finally(() => {
        for (const address of missing) {
          const key = lookupKey(id, address)
          pendingAdapterLookups.delete(key)
          if (!oracleAdapters[address]) failedLookups.set(key, Date.now())
        }
      })
  }

  /** Only a check's own subject is fetched as a vault: other addresses in its text can be hooks, rate models or owners. */
  const ensureResolved = (lines: readonly Pick<VaultCheckLine, 'key' | 'parts'>[]) => {
    const vaults: string[] = []
    const adapters: string[] = []
    for (const line of lines) {
      if (line.key.replace(/^scheduled\./, '').startsWith('oracle.')) {
        adapters.push(...(line.parts ?? []).flatMap(part => part.address ? [part.address] : []))
        continue
      }
      const subject = getVaultCheckSubject(line.key)
      if (subject) vaults.push(subject.address)
    }
    ensureVaults(vaults)
    ensureAdapters(adapters)
  }

  const oraclePairLink = (vaultAddress: string, adapter: string): RouteLocationRaw | undefined => {
    void registryVersion.value
    const vault = get(vaultAddress)?.vault
    if (!vault || !isEVault(vault)) return undefined
    const collateral = getOraclePairCollateral(vault as EVault, adapter)
    if (!collateral) return undefined
    const path = `/borrow/${collateral}/${vault.address}`
    return path.toLowerCase() === route.path.toLowerCase()
      ? undefined
      : { path, query: networkQuery(), hash: `#${oracleAdapterAnchor(adapter)}` }
  }

  const oracleLinkFor = (line: Pick<VaultCheckLine, 'anchor' | 'adapter'>, vaultAddress: string, hasLocalAnchor: boolean): RouteLocationRaw | undefined => {
    if (line.anchor && hasLocalAnchor) return { query: route.query, hash: `#${line.anchor}` }
    return line.adapter ? oraclePairLink(vaultAddress, line.adapter) : undefined
  }

  return { describe, ensureVaults, ensureResolved, oracleLinkFor }
}
