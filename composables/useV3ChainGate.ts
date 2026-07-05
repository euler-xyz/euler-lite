/**
 * Per-chain gate for direct V3 backend fetches (open interest, bad debt,
 * vault history). Mirrors the SDK's routing in `getEulerSdkForChain`: chains
 * listed in `ONCHAIN_SDK_CHAINS` are pinned to on-chain reads, so the
 * V3-only endpoints must not be hit for them either — a lagging V3 indexer
 * would otherwise surface stale or missing data the SDK path already avoids.
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
