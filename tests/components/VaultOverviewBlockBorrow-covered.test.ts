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

describe('collateral exposure of a vault with no listed collateral pair', () => {
  const renderBlock = (vault: EVault) => {
    const app = createSSRApp({ render: () => h(VaultOverviewBlockBorrow, { vault }) })
    app.config.warnHandler = () => undefined
    app.component('VaultOverviewAccordionSection', defineComponent({
      props: { title: String },
      setup: (props, { slots }) => () => h('section', { 'data-section': props.title }, slots.default?.()),
    }))
    return renderToString(app)
  }
  const withCollaterals = (collaterals: unknown[]) => ({ ...makeEusdc42(), collaterals }) as unknown as EVault
  const eusdc42Uncovered = { usd: 17_556.296, unpricedUsd: 17_556.296, scope: '' }

  it('says collateral details are unavailable when configured collateral is not resolved, and keeps the uncovered line', async () => {
    uncovered = eusdc42Uncovered
    useVaultRegistry().clear()
    const html = await renderBlock(makeEusdc42())
    expect(html).toContain('data-id="collateral-exposure-uncovered"')
    expect(html).toContain('Collateral details are not available right now.')
    expect(html).not.toContain('No collateral is currently accepted')
  })

  it.each([
    ['no collateral configured', []],
    ['only collateral with zero borrow and liquidation LTV', [{ ...makeEusdc42().collaterals[0], borrowLTV: 0, liquidationLTV: 0, currentLiquidationLTV: 0 }]],
  ])('says no collateral is accepted when there is %s, and keeps the uncovered line', async (_label, collaterals) => {
    uncovered = eusdc42Uncovered
    const html = await renderBlock(withCollaterals(collaterals))
    expect(html).toContain('data-section="Collateral exposure"')
    expect(html).toContain('data-id="collateral-exposure-uncovered"')
    expect(html).toContain('No collateral is currently accepted for this vault&#39;s borrows.')
    expect(html).not.toContain('Review the borrows each collateral covers')
  })

  it('stays hidden with neither collateral nor uncovered borrows', async () => {
    expect(await renderBlock(withCollaterals([]))).not.toContain('data-section')
  })
})
