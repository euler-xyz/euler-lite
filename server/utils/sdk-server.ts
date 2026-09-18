/**
 * Lazy per-chain server-side `EulerSDK` builder.
 *
 * Used by:
 *   - `server/utils/labels-view.ts` (public labels endpoint surface)
 *   - `server/utils/vaults-cache.ts` (vault snapshot refresh, warmed every
 *     5 min by the warm-cache plugin and as the cold-path fallback for
 *     `/api/internal/vaults?chainId=N`)
 *
 * Each chain gets one SDK instance, cached at module scope; the promise is
 * cleared on build failure so the next call retries instead of poisoning
 * the entry.
 *
 * Regular chains use `SERVER_VAULT_CACHE_SOURCE`:
 *   - `fallback` (default): V3 primary, onchain secondary. With no V3
 *     configured the SDK degrades to onchain via `disableV3: true`.
 *   - `onchain`: pin every service to onchain.
 *   - `v3`: pin to V3; SDK build throws when V3 is not configured.
 *
 * Chains listed in `ONCHAIN_SDK_CHAINS` always use the onchain config.
 *
 * Turtle Earn requires `X-API-Key` on every endpoint. The direct and
 * fallback rewards adapters call Turtle upstream themselves rather than via
 * `/api/internal/proxy/turtle`, so the builder hands them the same server-only
 * `TURTLE_EARN_API_KEY` and trust-checked upstream the proxy uses. Without a
 * usable key every Turtle call is a guaranteed 401, so Turtle discovery is
 * disabled instead of hammering upstream.
 */
import {
  buildEulerSDK,
  type EulerSDK,
  type EulerSDKConfig,
} from '@eulerxyz/euler-v2-sdk'
import {
  readResolvedV3ApiUrl,
  readServerVaultCacheSource,
  readTurtleEarnApiKey,
  readV3ApiKey,
  readV3ApiUrl,
  type VaultDataSource,
} from '~/utils/api-url-env'
import { parseChainIds } from '~/utils/parseChainIds'
import { resolveRpcUrl } from './rpc'
import { resolveLabelsBaseUrl } from './labels-base-url'
import { resolveTurtleUpstreamBase } from './turtle-proxy'

const sdkByChain = new Map<number, Promise<EulerSDK>>()

const fallbackAdapterConfig: Partial<EulerSDKConfig> = {
  accountServiceAdapter: 'fallback',
  eVaultServiceAdapter: 'fallback',
  eulerEarnServiceAdapter: 'fallback',
  rewardsServiceAdapter: 'fallback',
}

const onchainAdapterConfig: Partial<EulerSDKConfig> = {
  accountServiceAdapter: 'onchain',
  eVaultServiceAdapter: 'onchain',
  eulerEarnServiceAdapter: 'onchain',
  rewardsServiceAdapter: 'direct',
}

const v3AdapterConfig: Partial<EulerSDKConfig> = {
  accountServiceAdapter: 'v3',
  eVaultServiceAdapter: 'v3',
  eulerEarnServiceAdapter: 'v3',
  rewardsServiceAdapter: 'v3',
}

const adapterConfigForSource = (source: VaultDataSource): Partial<EulerSDKConfig> => {
  switch (source) {
    case 'onchain': return onchainAdapterConfig
    case 'v3': return v3AdapterConfig
    default: return fallbackAdapterConfig
  }
}

/**
 * Turtle rewards config for the server SDK. The key only travels to an
 * upstream that passed the proxy's trust check; a missing key or an untrusted
 * override disables Turtle discovery rather than issuing unauthenticated calls.
 */
export const resolveServerTurtleRewardsConfig = (
  env: NodeJS.ProcessEnv = process.env,
): Partial<EulerSDKConfig> => {
  const apiKey = readTurtleEarnApiKey(env).trim()
  const upstream = resolveTurtleUpstreamBase(env)
  if (!apiKey || !upstream.ok) return { rewardsEnableTurtle: false }
  return { rewardsTurtleApiKey: apiKey, rewardsTurtleApiUrl: upstream.base }
}

const isOnchainSdkChain = (chainId: number): boolean =>
  parseChainIds(process.env.ONCHAIN_SDK_CHAINS, new Set([chainId])).includes(chainId)

const buildServerSdkConfig = (chainId: number): EulerSDKConfig => {
  const rpcUrl = resolveRpcUrl(chainId)
  if (!rpcUrl) throw new Error(`No RPC URL configured for chain ${chainId}`)

  const v3ApiUrl = readResolvedV3ApiUrl()
  const v3ApiKey = readV3ApiKey().trim()
  const source = isOnchainSdkChain(chainId) ? 'onchain' : readServerVaultCacheSource()
  const hasV3 = !!readV3ApiUrl()

  return {
    rpcUrls: { [chainId]: rpcUrl },
    v3ApiUrl,
    eulerLabelsBaseUrl: resolveLabelsBaseUrl(),
    tokenlistApiBaseUrl: v3ApiUrl,
    ...(v3ApiKey ? { v3ApiKey } : {}),
    ...resolveServerTurtleRewardsConfig(),
    ...adapterConfigForSource(source),
    // Fallback short-circuits to onchain when no V3 is configured —
    // otherwise the SDK keeps trying V3 and every refresh logs failures.
    ...(source === 'fallback' && !hasV3 ? { disableV3: true } : {}),
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
