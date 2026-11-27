import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VaultOverviewBlockAddresses from '~/components/entities/vault/overview/VaultOverviewBlockAddresses.vue'
import VaultOverviewAddressValue from '~/components/entities/vault/overview/VaultOverviewAddressValue.vue'
import { LIQUITY_HUB_GOVERNOR, makeEusdc42 } from '~/tests/fixtures/liquity-hub'

beforeEach(() => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useClipboardCopy', () => ({ copyToClipboard: async () => undefined }))
  vi.stubGlobal('useVaultAssessmentEvidence', () => ({ assessment: ref(undefined), fallbackReady: ref(true) }))
  vi.stubGlobal('useOracleRouterGovernor', () => ({ governor: ref(null) }))
})

afterEach(() => vi.unstubAllGlobals())

const render = () => {
  const app = createSSRApp({ render: () => h(VaultOverviewBlockAddresses, { vault: makeEusdc42() }) })
  app.config.warnHandler = () => undefined
  app.component('VaultOverviewAccordionSection', defineComponent({ setup: (_, { slots }) => () => h('section', slots.default?.()) }))
  app.component('VaultOverviewLabelValue', defineComponent({
    props: { label: String },
    setup: (props, { slots }) => () => h('div', { 'data-label': props.label }, slots.default?.()),
  }))
  app.component('VaultOverviewAddressValue', VaultOverviewAddressValue)
  app.component('SafeAccountBadge', defineComponent({
    props: { address: String },
    setup: props => () => h('span', { 'data-test-safe': props.address }),
  }))
  for (const name of ['NuxtLink', 'SvgIcon', 'UiHoverPreviewTooltip']) app.component(name, { render: () => h('span') })
  return renderToString(app)
}

describe('Safe badge in the Addresses block', () => {
  it('keeps the Safe badge on the curator address row', async () => {
    const html = await render()
    const curatorRow = html.match(/data-label="Curator"[^>]*>([\s\S]*?)<\/div><\/div>/)?.[1] ?? ''

    expect(curatorRow).toContain(`data-test-safe="${LIQUITY_HUB_GOVERNOR}"`)
  })
})
