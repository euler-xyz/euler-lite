import { parseChainId } from '~/entities/chainRegistry'
import { omitQueryKeys, rewriteLegacyPath } from '~/utils/legacy-route-rewrites'

const parseChainIds = (value: unknown): number[] => {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(values.flatMap((entry) => {
    if (typeof entry !== 'string') return []
    return entry.split(',').flatMap((part) => {
      const parsed = parseChainId(part.trim())
      return parsed == null ? [] : [parsed]
    })
  }))]
}

const rawNetworkParam = (value: unknown): string | null => {
  const normalized = Array.isArray(value) ? value[0] : value
  return typeof normalized === 'string' ? normalized : null
}

export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) {
    return
  }

  const { chainId, changeCurrentChainId, selectedChainIds, setSelectedChainIds } = useEulerAddresses()

  const rawChainParam = to.query.network ?? to.query.chainId
  const queryChainIds = parseChainIds(to.query.networks)
  const queryChainId = parseChainId(rawChainParam)
  const savedChainIds = parseChainIds(localStorage.getItem('chainIds'))
  const savedChainId = parseChainId(localStorage.getItem('chainId'))
  const fallbackChainId = queryChainId ?? savedChainId ?? (chainId.value || 1)
  const fallbackChainIds = queryChainIds.length
    ? queryChainIds
    : savedChainIds.length
      ? savedChainIds
      : queryChainId
        ? [queryChainId]
        : selectedChainIds.value

  const rawNetwork = rawNetworkParam(rawChainParam)
  const needsNormalization = queryChainId != null && rawNetwork !== String(queryChainId)
  const hasLegacyChainIdParam = to.query.chainId != null
  const legacyPathRewrite = rewriteLegacyPath(to.path)

  // Sync state chainId to the URL's chainId before downstream middleware
  // (e.g. ensure-vault) runs chain-scoped lookups. Without this, a legacy URL
  // like /vault/0x…?network=monad would redirect to /lend/0x…?network=143 but
  // ensure-vault would still try to resolve the vault on the previously-set
  // chain (typically allowedChainIds[0]), fail, and bounce to the default page.
  // changeCurrentChainId is a no-op if the target isn't in allowedChainIds or
  // already matches. The wallet-level chain switch still happens via useWagmi's
  // route.query.network watcher.
  if (fallbackChainId) {
    changeCurrentChainId(fallbackChainId)
    localStorage.setItem('chainId', String(fallbackChainId))
  }
  if (fallbackChainIds.length) {
    setSelectedChainIds(fallbackChainIds)
    localStorage.setItem('chainIds', fallbackChainIds.join(','))
  }

  if (legacyPathRewrite || !queryChainId || queryChainId !== fallbackChainId || needsNormalization || hasLegacyChainIdParam) {
    const { chainId: _legacyChainId, ...restQuery } = to.query
    const sanitizedQuery = omitQueryKeys(restQuery, legacyPathRewrite?.dropQueryKeys ?? [])
    return navigateTo({
      path: legacyPathRewrite?.path ?? to.path,
      query: {
        ...sanitizedQuery,
        network: fallbackChainId,
        networks: fallbackChainIds.join(','),
      },
      hash: to.hash,
    }, { replace: true })
  }
})
