import { EulerLabelsService, type EulerLabelsData } from '@eulerxyz/euler-v2-sdk'
import { isLabelsSnapshotUsable } from '~/utils/labels-freshness'
import { normalizeLabelsBundle, type PublicLabelsBundle } from '~/utils/public-labels'

const unsupportedFileRead = async (): Promise<never> => {
  throw new Error('Lite labels are available as a complete V3 or static snapshot')
}

/** Keep SDK label population on the same source as Lite's verification and discovery. */
export class LiteEulerLabelsService extends EulerLabelsService {
  constructor() {
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
    const bundle = await $fetch<PublicLabelsBundle>('/api/internal/public-labels', {
      query: { chainId },
      timeout: 35_000,
    })
    if (bundle.source !== 'static' && !isLabelsSnapshotUsable(bundle.sourceFetchedAt)) {
      throw new Error('Vault labels snapshot is too old')
    }
    return normalizeLabelsBundle(chainId, bundle)
  }
}
