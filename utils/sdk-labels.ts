import { EulerLabelsService, type EulerLabelsData } from '@eulerxyz/euler-v2-sdk'
import { isLabelsSnapshotUsable } from '~/utils/labels-freshness'
import { normalizeLabelsBundle, type PublicLabelsBundle } from '~/utils/public-labels'
import { chainReadPolicyKey, type ChainReadPolicy } from '~/utils/chain-policy'

const unsupportedFileRead = async (): Promise<never> => {
  throw new Error('Lite labels are available as a complete V3 or static snapshot')
}

type LoadLabelsBundle = (chainId: number) => Promise<PublicLabelsBundle>

/** Shared by discovery and SDK population so HTTP-cached labels obey the same policy. */
export const loadBrowserLabelsBundle = async (chainId: number, policy?: ChainReadPolicy, forceRefresh = false): Promise<PublicLabelsBundle> => {
  const fetchBundle = (uncached: boolean) => $fetch<PublicLabelsBundle>('/api/internal/public-labels', {
    query: { chainId }, timeout: 35_000,
    ...(uncached && { cache: 'no-store' as const, headers: { 'cache-control': 'no-cache' } }),
  })
  const matchesPolicy = (bundle: PublicLabelsBundle) => !policy || (bundle.chainPolicy
    && chainReadPolicyKey(bundle.chainPolicy) === chainReadPolicyKey(policy)
    && (bundle.source === 'v3-metadata') === policy.metadataOnly)
  let bundle = await fetchBundle(forceRefresh)
  if (!matchesPolicy(bundle) && !forceRefresh) bundle = await fetchBundle(true)
  if (!matchesPolicy(bundle)) throw new Error('Vault labels do not match the current chain policy')
  return bundle
}

/** Keep SDK label population on the same source as Lite's verification and discovery. */
export class LiteEulerLabelsService extends EulerLabelsService {
  constructor(private readonly loadBundle: LoadLabelsBundle = loadBrowserLabelsBundle) {
    // SDK internals use fetchEulerLabelsData through populateLabels. File-specific
    // reads are unavailable here so they cannot silently contact euler-labels.
    super({
      fetchEulerLabelsEntities: unsupportedFileRead,
      fetchEulerLabelsProducts: unsupportedFileRead,
      fetchEulerLabelsPoints: unsupportedFileRead,
      fetchEulerLabelsEarnVaults: unsupportedFileRead,
      fetchEulerLabelsAssets: unsupportedFileRead,
    })
  }

  override async fetchEulerLabelsData(chainId: number): Promise<EulerLabelsData> {
    const bundle = await this.loadBundle(chainId)
    if (bundle.source !== 'static' && !isLabelsSnapshotUsable(bundle.sourceFetchedAt)) {
      throw new Error('Vault labels snapshot is too old')
    }
    return normalizeLabelsBundle(chainId, bundle)
  }
}
