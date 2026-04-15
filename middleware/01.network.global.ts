import { parseChainId } from '~/entities/chainRegistry'

const rawNetworkParam = (value: unknown): string | null => {
  const normalized = Array.isArray(value) ? value[0] : value
  return typeof normalized === 'string' ? normalized : null
}

// Legacy path rewrites from the pre-lite app. Preserves any trailing segments
// (e.g. vault/collateral addresses) after the renamed prefix.
const LEGACY_PATH_REWRITES: ReadonlyArray<{ from: RegExp, to: string }> = [
  { from: /^\/vault(\/.*)?$/, to: '/lend' },
  { from: /^\/positions(\/.*)?$/, to: '/borrow' },
]

const rewriteLegacyPath = (path: string): string | null => {
  for (const { from, to } of LEGACY_PATH_REWRITES) {
    const match = path.match(from)
    if (match) return to + (match[1] ?? '')
  }
  return null
}

export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) {
    return
  }

  const { chainId, changeCurrentChainId } = useEulerAddresses()

  const queryChainId = parseChainId(to.query.network)
  const savedChainId = parseChainId(localStorage.getItem('chainId'))
  const fallbackChainId = queryChainId ?? savedChainId ?? (chainId.value || 1)

  const rawNetwork = rawNetworkParam(to.query.network)
  const needsNormalization = queryChainId != null && rawNetwork !== String(queryChainId)
  const rewrittenPath = rewriteLegacyPath(to.path)

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

  if (rewrittenPath || !queryChainId || queryChainId !== fallbackChainId || needsNormalization) {
    return navigateTo({
      path: rewrittenPath ?? to.path,
      query: {
        ...to.query,
        network: fallbackChainId,
      },
      hash: to.hash,
    }, { replace: true })
  }
})
