import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import VaultExposureListModal from '~/components/entities/vault/VaultExposureListModal.vue'
import VaultExposureUncoveredIcon from '~/components/entities/vault/VaultExposureUncoveredIcon.vue'
import {
  buildAllocatedVaultExposureDisplayItems,
  UNCOVERED_EXPOSURE_LABEL,
  UNCOVERED_EXPOSURE_NOTE,
} from '~/utils/vault/exposure-display'
import { BOLD, EUSDC_42_BAD_DEBT_USD } from '~/tests/fixtures/liquity-hub'

const render = (items: ReturnType<typeof buildAllocatedVaultExposureDisplayItems>) => {
  const app = createSSRApp({ render: () => h(VaultExposureListModal, { items, valueState: 'ready' }) })
  app.component('BaseModalWrapper', defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }))
  app.component('AssetAvatar', defineComponent({ props: { asset: Object }, setup: () => () => h('span', { 'data-test': 'asset-avatar' }) }))
  app.component('VaultExposureUncoveredIcon', VaultExposureUncoveredIcon)
  app.component('UiRadialProgress', { render: () => h('span') })
  app.component('SvgIcon', { render: () => h('span') })
  return renderToString(app)
}

describe('exposure list with uncovered bad debt', () => {
  it('shows the uncovered debt as a warning row and the covered collateral with its asset', async () => {
    const html = await render(buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [{
        asset: { address: BOLD.address.toLowerCase(), symbol: 'BOLD' },
        items: [],
        vaultCount: 1,
        maxBorrowLTV: 0.925,
        maxCurrentLiquidationLTV: 0.95,
        openInterestUsd: 1.29,
      }],
      totalExposureUsd: EUSDC_42_BAD_DEBT_USD + 1.29,
      utilization: 100,
      uncoveredShare: EUSDC_42_BAD_DEBT_USD / (EUSDC_42_BAD_DEBT_USD + 1.29),
    }))

    expect(html).toContain(UNCOVERED_EXPOSURE_LABEL)
    expect(html).toContain(UNCOVERED_EXPOSURE_NOTE)
    expect(html).toContain('data-id="exposure-uncovered-icon"')
    expect(html).toContain('text-warning-500')
    expect(html).toContain('$17.56K')
    expect(html.match(/data-test="asset-avatar"/g)).toHaveLength(1)
  })
})
