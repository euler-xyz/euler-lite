import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import RestrictedBadge from '~/components/entities/vault/RestrictedBadge.vue'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { useGeoBlock } from '~/composables/useGeoBlock'
import { cozy } from '~/tests/fixtures/static-geo-labels'

vi.mock('#components', () => ({ RestrictedInfoModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: vi.fn() }) }))
vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => ({ getVault: () => undefined }) }))
const render = async () => {
  const app = createSSRApp({ render: () => h(RestrictedBadge, { vaultAddresses: [cozy.address], chainId: 1 }) })
  app.config.warnHandler = () => {}
  app.component('UiHoverPreviewTooltip', { template: '<span><slot /></span>' })
  return renderToString(app)
}
beforeEach(() => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  useGeoBlock().country.value = 'NL'
  __setEulerLabelsDataForTest({ geoContext: { chainId: 1, policies: [], productByVault: {} } })
})
describe('shared geographic badge', () => {
  it('does not turn an absent registry entry into an affirmative region badge', async () => {
    expect(await render()).not.toContain('Restricted')
  })
  it('does not turn unknown country into an affirmative region badge', async () => {
    useGeoBlock().country.value = null
    expect(await render()).not.toContain('Restricted')
  })
  it('keeps a confirmed sanction badge', async () => {
    useGeoBlock().country.value = 'IR'
    expect(await render()).toContain('Restricted')
  })
})
