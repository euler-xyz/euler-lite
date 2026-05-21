/**
 * Lazy per-chain server-side `EulerSDK` builder.
 *
 * Used by:
 *   - `server/utils/labels-view.ts` (public labels endpoint surface)
 *   - `server/utils/vaults-cache.ts` (vault snapshot refresh, warmed every
 *     5 min by the warm-cache plugin and as the cold-path fallback for
 *     `/api/vaults?chainId=N`)
 *
 * Each chain gets one SDK instance, cached at module scope; the promise is
 * cleared on build failure so the next call retries instead of poisoning
 * the entry.
 *
 * Service adapters are left unset so the SDK defaults to `'fallback'` —
 * V3 primary, onchain secondary when V3 is configured; pure onchain
 * otherwise. To force an onchain-only snapshot regardless of V3 health,
 * pin `*ServiceAdapter` in `buildServerSdkConfig` below.
 */
import {
  buildEulerSDK,
  type EulerSDK,
  type EulerSDKConfig,
} from '@eulerxyz/euler-v2-sdk'
import { readResolvedV3ApiUrl, readV3ApiKey } from '~/utils/api-url-env'
import { resolveRpcUrl } from './rpc'

const sdkByChain = new Map<number, Promise<EulerSDK>>()

const buildServerSdkConfig = (chainId: number): EulerSDKConfig => {
  const rpcUrl = resolveRpcUrl(chainId)
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain ${chainId}`)

  const v3ApiUrl = readResolvedV3ApiUrl()
  const v3ApiKey = readV3ApiKey().trim()
  // Service adapters left unset so the SDK defaults to 'fallback' — V3
  // primary, onchain secondary when V3 is configured. When V3 is not
  // configured, the SDK still resolves 'fallback' but with disableV3
  // semantics (the snapshot pipeline doesn't pass disableV3 explicitly;
  // V3 calls will fail and the SDK falls through to onchain). To force
  // an onchain-only snapshot regardless of V3 health, pin
  // `*ServiceAdapter` here.
  return {
    rpcUrls: { [chainId]: rpcUrl },
    v3ApiUrl,
    tokenlistApiBaseUrl: v3ApiUrl,
    ...(v3ApiKey ? { v3ApiKey } : {}),
  }
}

export const getServerSdk = (chainId: number): Promise<EulerSDK> => {
  const existing = sdkByChain.get(chainId)
  if (existing) return existing
  const promise = buildEulerSDK({ config: buildServerSdkConfig(chainId) }).catch((err) => {
    if (sdkByChain.get(chainId) === promise) sdkByChain.delete(chainId)
    throw err
  })
  sdkByChain.set(chainId, promise)
  return promise
}
