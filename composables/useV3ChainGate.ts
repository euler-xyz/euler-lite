/**
 * Per-chain gate for direct V3 backend fetches (open interest, bad debt,
 * vault history). Mirrors the SDK's routing in `getEulerSdkForChain`: chains
 * in the resolved onchain SDK list are pinned to on-chain reads, so the
 * V3-only endpoints must not be hit for them either — a lagging V3 indexer
 * would otherwise surface stale or missing data the SDK path already avoids.
 *
 * The list includes chains without V3 catalog indexing support and explicit
 * `ONCHAIN_SDK_CHAINS` overrides. A
 * deployment that pins *every* chain to on-chain reads via a global
 * `NUXT_PUBLIC_BROWSER_VAULT_SOURCE=onchain` while still configuring a V3 URL
 * is intentionally out of scope — the gated endpoints are V3-only with no
 * on-chain equivalent, so blanking them there would remove features rather
 * than avoid staleness. Gate on the per-chain list, not the global source.
 */
export const useV3ChainGate = () => {
  const { enableV3Backend } = useEnvConfig()
  const { onchainSdkChainIds } = useChainConfig()

  const isV3EnabledForChain = (chainId: number | string | null | undefined): boolean => {
    if (!enableV3Backend) return false
    const id = Number(chainId)
    if (!Number.isFinite(id) || id <= 0) return false
    return !onchainSdkChainIds.includes(id)
  }

  return { isV3EnabledForChain }
}
