import { parseChainId } from '~/entities/chainRegistry'
import { omitQueryKeys, rewriteLegacyPath } from '~/utils/legacy-route-rewrites'

const rawNetworkParam = (value: unknown): string | null => {
  const normalized = Array.isArray(value) ? value[0] : value
  return typeof normalized === 'string' ? normalized : null
}

export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) {
    return
  }

  // The Zip Code demo (/zipcode/*) is chain-agnostic; don't append ?network=.
  if (to.path.startsWith('/zipcode')) {
    return
  }

  const { chainId, changeCurrentChainId } = useEulerAddresses()

  const rawChainParam = to.query.network ?? to.query.chainId
  const queryChainId = parseChainId(rawChainParam)
  const savedChainId = parseChainId(localStorage.getItem('chainId'))
  const fallbackChainId = queryChainId ?? savedChainId ?? (chainId.value || 1)

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

  if (legacyPathRewrite || !queryChainId || queryChainId !== fallbackChainId || needsNormalization || hasLegacyChainIdParam) {
    const { chainId: _legacyChainId, ...restQuery } = to.query
    const sanitizedQuery = omitQueryKeys(restQuery, legacyPathRewrite?.dropQueryKeys ?? [])
    return navigateTo({
      path: legacyPathRewrite?.path ?? to.path,
      query: {
        ...sanitizedQuery,
        network: fallbackChainId,
      },
      hash: to.hash,
    }, { replace: true })
  }
})
