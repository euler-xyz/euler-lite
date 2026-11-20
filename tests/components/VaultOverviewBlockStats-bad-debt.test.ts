import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import VaultOverviewBlockStats from '~/components/entities/vault/overview/VaultOverviewBlockStats.vue'
import type { VaultBadDebtCacheEntry } from '~/utils/vault-bad-debt'
import { EUSDC_42, EUSDC_42_BAD_DEBT_USD, EUSDC_42_TOTAL_SUPPLY_USD, makeEusdc42 } from '~/tests/fixtures/liquity-hub'

const EUSDC_42_BORROWS_USD = 17_558

vi.mock('#components', () => ({
  VaultApyModal: {},
  UiModalPreviewTrigger: { setup: (_: unknown, { slots }: { slots: { default?: () => unknown } }) => () => slots.default?.() },
}))
vi.mock('~/utils/sdk-prices', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/sdk-prices')>()),
  formatAssetValue: async (amount: bigint, vault: EVault) => {
    const usdValue = amount === vault.totalAssets ? EUSDC_42_TOTAL_SUPPLY_USD : amount === vault.totalBorrowed ? EUSDC_42_BORROWS_USD : 0
    return { hasPrice: true, usdValue, display: `$${usdValue}` }
  },
}))

const eusdc42BadDebt = {
  badDebtUsd: EUSDC_42_BAD_DEBT_USD,
  accountCount: 3,
  pricing: { status: 'not-reported' },
} as VaultBadDebtCacheEntry

beforeEach(() => {
  vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false }) }))
  vi.stubGlobal('useRewardsApy', () => ({
    getSupplyRewardApy: () => 0,
    getBorrowRewardApy: () => 0,
    getSupplyRewardCampaigns: () => [],
    getBorrowRewardCampaigns: () => [],
    hasSupplyRewards: () => false,
    hasBorrowRewards: () => false,
  }))
  vi.stubGlobal('useVaultBadDebt', () => ({
    getVaultBadDebt: (address: string) => address.toLowerCase() === EUSDC_42.toLowerCase() ? eusdc42BadDebt : undefined,
    isBadDebtEnabled: ref(true),
    isBadDebtLoaded: ref(true),
    isBadDebtLoading: ref(false),
    loadBadDebtForChain: vi.fn(),
  }))
  vi.stubGlobal('getVaultSupplyApy', () => 0)
  vi.stubGlobal('getVaultBorrowApy', () => 0)
})

afterEach(() => vi.unstubAllGlobals())

const LabelValue = defineComponent({
  props: { label: String, value: String },
  setup: (props, { slots }) => () => h('div', { 'data-row': props.label ?? '' }, [
    h('span', { 'data-part': 'label' }, slots.label?.() ?? props.label),
    h('span', { 'data-part': 'value' }, slots.default?.() ?? props.value),
  ]),
})

const Tooltip = defineComponent({
  props: { title: String, text: String, ariaLabel: String },
  setup: (props, { slots }) => () => h('span', { 'data-tooltip': props.title, 'data-text': props.text, 'aria-label': props.ariaLabel }, slots.default?.()),
})

const render = async () => {
  const app = createSSRApp({ render: () => h(VaultOverviewBlockStats, { vault: makeEusdc42() }) })
  app.config.warnHandler = () => undefined
  app.component('VaultOverviewAccordionSection', defineComponent({ setup: (_, { slots }) => () => h('section', slots.default?.()) }))
  app.component('VaultOverviewLabelValue', LabelValue)
  app.component('UiHoverPreviewTooltip', Tooltip)
  for (const name of ['SvgIcon', 'VaultWarningIcon', 'UiRadialProgress']) app.component(name, { render: () => h('i') })
  return renderToString(app)
}

const rowPart = (html: string, row: string, part: 'label' | 'value') => {
  const match = html.match(new RegExp(`data-row="${row}"[^>]*><span data-part="label">([\\s\\S]*?)</span><span data-part="value">([\\s\\S]*?)</span></div>`))
  return match?.[part === 'label' ? 1 : 2] ?? ''
}

describe('pending bad debt row of the Statistics block', () => {
  it('puts the info icon in the label and keeps the value plain', async () => {
    const html = await render()
    const label = rowPart(html, 'Pending bad debt', 'label')
    const value = rowPart(html, 'Pending bad debt', 'value')

    expect(label).toContain('Pending bad debt')
    expect(label).toContain('data-tooltip="Pending bad debt"')
    expect(label).toContain('aria-label="About pending bad debt"')
    expect(value).not.toContain('data-tooltip')
    expect(value).toContain('$17.56K')
  })

  it('explains the term in the tooltip', async () => {
    const html = await render()
    const label = rowPart(html, 'Pending bad debt', 'label')

    expect(label).toContain('data-text="Debt that no collateral currently covers.')
  })
})
