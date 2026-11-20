import { createSSRApp, defineComponent, h, ref, type PropType } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import VaultOverviewBlockBorrow from '~/components/entities/vault/overview/VaultOverviewBlockBorrow.vue'
import type { VaultUncoveredBorrows } from '~/composables/useVaultCheckWeights'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import {
  EBOLD_1,
  EPT_SBOLD_1765325646,
  EPT_SBOLD_27NOV2025,
  ESBOLD_1,
  PT_SBOLD_1765325646,
  PT_SBOLD_27NOV2025,
  makeEbold1,
  makeEsbold1,
  makeEusdc42,
  makePtVault,
} from '~/tests/fixtures/liquity-hub'

vi.mock('#components', () => ({ VaultRampDownModal: {} }))

let openInterest: Record<string, number>
let uncovered: VaultUncoveredBorrows | null

beforeEach(() => {
  openInterest = { [EBOLD_1]: 1, [ESBOLD_1]: 5 }
  uncovered = null
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  const registry = useVaultRegistry()
  for (const vault of [makeEbold1(), makeEsbold1(), makePtVault(EPT_SBOLD_1765325646, PT_SBOLD_1765325646, 0n), makePtVault(EPT_SBOLD_27NOV2025, PT_SBOLD_27NOV2025, 0n)]) {
    registry.set(vault.address, vault, 'evk')
  }
  vi.stubGlobal('useCollateralOpenInterest', () => ({
    load: vi.fn(),
    getOpenInterestForVault: () => openInterest,
    hasError: ref(false),
    isLoaded: ref(true),
    isOpenInterestEnabled: ref(true),
  }))
  vi.stubGlobal('useVaultCheckWeights', () => ({ getUncoveredBorrows: () => uncovered }))
})

afterEach(() => {
  useVaultRegistry().clear()
  vi.unstubAllGlobals()
})

const render = () => {
  const app = createSSRApp({ render: () => h(VaultOverviewBlockBorrow, { vault: makeEusdc42() as EVault }) })
  app.config.warnHandler = () => undefined
  Object.assign(app.config.globalProperties, { ltvToPercent: (ltv: number) => ltv * 100 })
  app.component('VaultOverviewAccordionSection', defineComponent({ setup: (_, { slots }) => () => h('section', slots.default?.()) }))
  app.component('VaultOverviewLabelValue', defineComponent({
    props: { label: String, value: String },
    setup: (props, { slots }) => () => h('div', [slots.label?.() ?? props.label, slots.default?.() ?? props.value]),
  }))
  app.component('VaultLabelsAndAssets', defineComponent({
    props: { vault: { type: Object as PropType<{ address: string }>, required: true } },
    setup: props => () => h('span', { 'data-test-collateral': props.vault.address }),
  }))
  app.component('UiHoverPreviewTooltip', defineComponent({
    props: { title: String, text: String },
    setup: props => () => h('span', { 'data-tooltip': props.title, 'data-text': props.text }),
  }))
  for (const name of ['SvgIcon', 'UiModalPreviewTrigger']) app.component(name, { render: () => h('i') })
  return renderToString(app)
}

const collateralOrder = (html: string) => [...html.matchAll(/data-test-collateral="([^"]+)"/g)].map(match => match[1])

describe('collateral exposure of the vault overview', () => {
  it('calls each collateral\'s amount the borrows its current value covers', async () => {
    const html = await render()
    expect(html).toContain('Covered borrows')
    expect(html).not.toContain('Current exposure')
    expect(html).toContain('data-text="Borrows this collateral&#39;s current value covers. Debt above a collateral&#39;s value is not counted here."')
  })

  it('ranks collateral by covered borrows when the vault has no bad debt', async () => {
    expect(collateralOrder(await render()).slice(0, 2)).toEqual([ESBOLD_1, EBOLD_1])
  })

  it('states the uncovered borrows and stops ranking by covered value when the vault has bad debt', async () => {
    uncovered = { usd: 17_556.296, unpricedUsd: 3.6546, scope: '' }
    const html = await render()
    expect(html).toContain('data-id="collateral-exposure-uncovered"')
    expect(html).toContain('Uncovered: $17.56K of borrows are not covered by any collateral&#39;s current value; $3.65 of it against collateral without a usable price')
    expect(collateralOrder(html).slice(0, 2)).toEqual([EBOLD_1, ESBOLD_1])
  })
})
