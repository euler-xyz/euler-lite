import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VaultAssessmentWarning from '~/components/entities/vault/VaultAssessmentWarning.vue'

const address = '0x00000000000000000000000000000000000000aa'

const renderWarning = (ready: boolean) => {
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(ready),
    loadError: ref('Unable to load vault verification. Please retry.'),
    source: ref('v3'),
    visibility: ref({
      [address]: { status: 'warning', decidedBy: 'assessment', reason: 'Review the oracle.' },
    }),
  }))
  const app = createSSRApp({ render: () => h(VaultAssessmentWarning, { address }) })
  app.component('UiHoverPreviewTooltip', defineComponent({
    setup: (_, { slots }) => () => h('div', slots.default?.()),
  }))
  app.component('SvgIcon', { render: () => h('span') })
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('vault verdict warning during a labels outage', () => {
  it('keeps the last-good warning until verification expires', async () => {
    expect(await renderWarning(true)).toContain('Vault checks')
    expect(await renderWarning(false)).not.toContain('Vault checks')
  })
})
