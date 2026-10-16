import { createSSRApp, defineComponent, h, ref, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LiquidationCoverageBadge from '~/components/entities/vault/LiquidationCoverageBadge.vue'
import LiquidationCoverageNotice from '~/components/entities/vault/overview/LiquidationCoverageNotice.vue'

const vault = { address: '0x692b9F0C2701699b7a352C9331DFAE6A6a163294', isBorrowable: true, totalBorrowed: 0n }

const render = (component: Component, props: Record<string, unknown>, notCovered: boolean) => {
  const ensureLiquidationCoverage = vi.fn()
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(8453) }))
  vi.stubGlobal('useLiquidationCoverage', () => ({
    ensureLiquidationCoverage,
    isNotCoveredByDefaultBot: () => notCovered,
  }))
  const app = createSSRApp({ render: () => h(component, props) })
  app.component('UiHoverPreviewTooltip', defineComponent({
    props: { title: String, text: String },
    setup: (tooltip, { slots }) => () => h('div', { 'data-title': tooltip.title, 'data-text': tooltip.text }, slots.default?.()),
  }))
  app.component('SvgIcon', { render: () => h('span') })
  return { html: renderToString(app), ensureLiquidationCoverage }
}

afterEach(() => vi.unstubAllGlobals())

describe('LiquidationCoverageBadge', () => {
  it('shows on a vault the default bot does not cover, with the lender explanation', async () => {
    const { html, ensureLiquidationCoverage } = render(LiquidationCoverageBadge, { vault }, true)

    const markup = await html
    expect(markup).toContain('data-id="liquidation-coverage"')
    expect(markup).toContain('Not covered by default liquidation bot')
    expect(markup).toContain('losses from unhealthy positions can reach lenders')
    expect(markup).toMatch(/<span class="mobile:hidden">Not covered by default liquidation bot<\/span>/)
    expect(ensureLiquidationCoverage).toHaveBeenCalledWith(8453)
  })

  it('explains the borrower view on a borrow position', async () => {
    const { html } = render(LiquidationCoverageBadge, { vault, context: 'borrow' }, true)

    expect(await html).toContain('Other liquidators may still liquidate your position')
  })

  it('renders nothing for a covered vault or while coverage is unknown', async () => {
    const { html } = render(LiquidationCoverageBadge, { vault }, false)

    expect(await html).not.toContain('liquidation-coverage')
  })
})

describe('LiquidationCoverageNotice', () => {
  it('states the lender explanation on the vault overview', async () => {
    const { html, ensureLiquidationCoverage } = render(LiquidationCoverageNotice, { vault }, true)

    const markup = await html
    expect(markup).toContain('data-id="liquidation-coverage-notice"')
    expect(markup).toContain('The default liquidation bot does not cover borrows from this vault.')
    expect(ensureLiquidationCoverage).toHaveBeenCalledWith(8453)
  })

  it('explains the borrower view on a borrow pair', async () => {
    const { html } = render(LiquidationCoverageNotice, { vault, context: 'borrow' }, true)

    expect(await html).toContain('Other liquidators may still liquidate your position')
  })

  it('renders nothing for a covered vault', async () => {
    const { html } = render(LiquidationCoverageNotice, { vault }, false)

    expect(await html).not.toContain('liquidation-coverage-notice')
  })
})
