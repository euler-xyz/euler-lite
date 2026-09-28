import { createPublicClient, http, type Chain } from 'viem'
import type { IProviderService } from '@eulerxyz/euler-v2-sdk'

const SONIC_CHAIN_ID = 146
type SdkProvider = ReturnType<IProviderService['getProvider']>
type ProviderOverride = (provider: SdkProvider, rpcUrl: string) => SdkProvider

// Add chain-specific server provider replacements here. All other chains use the SDK provider.
const providerOverrides: Partial<Record<number, ProviderOverride>> = {
  [SONIC_CHAIN_ID]: (provider, rpcUrl) => createPublicClient({
    // Keep the SDK's chain metadata, including its Multicall3 address.
    // The SDK installs its own viem version, so its Chain type differs from Lite's.
    chain: provider.chain as unknown as Chain,
    batch: { multicall: { batchSize: 128, wait: 10 } },
    transport: http(rpcUrl, { batch: { batchSize: 100, wait: 10 } }),
  }) as unknown as SdkProvider,
}

export const createServerProviderService = (
  rpcUrls: Record<number, string>,
  delegate: IProviderService,
): IProviderService => {
  const overrides = new Map<number, SdkProvider>()
  for (const [chainIdString, rpcUrl] of Object.entries(rpcUrls)) {
    const chainId = Number(chainIdString)
    const buildProvider = providerOverrides[chainId]
    if (buildProvider) overrides.set(chainId, buildProvider(delegate.getProvider(chainId), rpcUrl))
  }

  return {
    getProvider: chainId => overrides.get(chainId) ?? delegate.getProvider(chainId),
    getSupportedChainIds: () => delegate.getSupportedChainIds(),
  }
}
