import type { EulerLabelsFileData } from '@eulerxyz/euler-v2-sdk/public-labels'
import { normalizeLabelsBundle, type StaticLabelsBundle } from '~/utils/public-labels'

export const cozy = {
  address: '0x63bA834bFf27Dd1d80533a56cA27Aa058AAA1130', chainId: 1,
  asset: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin' },
}

// Authored files for a fork with no discovery entry for the SDK-resolved position.
export const staticGeoBundle = (files: Partial<EulerLabelsFileData> = {}): StaticLabelsBundle => ({
  source: 'static', version: 'geo-regression', logoBaseUrl: 'https://fork.test/labels/logo', fetchedAt: Date.now(),
  files: { products: {}, entities: {}, points: [], earnVaults: [], assets: [], ...files },
})

export const staticGeoLabels = (files: Partial<EulerLabelsFileData> = {}) => normalizeLabelsBundle(1, staticGeoBundle(files))
