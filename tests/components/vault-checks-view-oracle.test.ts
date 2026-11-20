import { createRenderer, createSSRApp, defineComponent, h, markRaw, ssrContextKey, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createMemoryHistory, createRouter, type RouteLocationRaw, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultAssessment } from '@eulerxyz/euler-v2-sdk'
import VaultAssessmentChecksModal from '~/components/entities/vault/overview/VaultAssessmentChecksModal.vue'
import VaultAssessmentCheckRow from '~/components/entities/vault/overview/VaultAssessmentCheckRow.vue'
import type { VaultCheckRowView } from '~/utils/vault-assessment/check-rows'
import { useModal } from '~/components/ui/composables/useModal'
import { EUSDC_42 } from '~/tests/fixtures/liquity-hub'
import { EUSDC_42_RAW_ASSESSMENT, assessmentEntry } from '~/tests/fixtures/v3-hidden-vault-assessments'

const ADAPTER = '0x94a31084a0e8dbed217ee8763a20ab03e18b38f5'
const ANCHOR = `oracle-adapter-${ADAPTER}`
const EXPLORE = '/explore/k3-liquity-hub'
const assessment = assessmentEntry(EUSDC_42_RAW_ASSESSMENT).assessment as VaultAssessment

type HistoryState = Record<string, unknown> | null
const browser = vi.hoisted(() => ({ state: null as HistoryState, listeners: new Set<() => void>(), back: vi.fn(), scrolled: [] as Array<{ id: string, openModals: number }> }))

const stubBrowser = () => {
  browser.state = null
  browser.listeners.clear()
  browser.scrolled = []
  browser.back.mockReset().mockImplementation(() => {
    browser.state = null
    queueMicrotask(() => browser.listeners.forEach(listener => listener()))
  })
  vi.stubGlobal('window', {
    innerWidth: 1440,
    history: {
      get state() { return browser.state },
      pushState: (state: HistoryState) => { browser.state = state },
      back: browser.back,
    },
    addEventListener: (type: string, listener: () => void) => { if (type === 'popstate') browser.listeners.add(listener) },
    removeEventListener: (type: string, listener: () => void) => { if (type === 'popstate') browser.listeners.delete(listener) },
  })
  vi.stubGlobal('document', {
    body: { style: {} },
    documentElement: { clientWidth: 1440, style: { setProperty: () => {}, removeProperty: () => {} } },
    getElementById: (id: string) => ({
      scrollIntoView: () => browser.scrolled.push({ id, openModals: useModal().list.length }),
    }),
  })
}

const makeRouter = async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:path(.*)*', component: { render: () => null } }] })
  await router.push(EXPLORE)
  return router
}

const mountClient = (component: Component, props: Record<string, unknown>) => {
  const renderer = createRenderer<object, object>({
    patchProp: () => {}, insert: () => {}, remove: () => {},
    createElement: (type: string) => ({ type }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), setText: () => {}, setElementText: () => {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp({ render: () => h({ ...component, render: () => null }, props) })
  app.provide(ssrContextKey, {})
  app.mount({ type: 'root' })
  return ((app._instance?.subTree.component as { setupState?: unknown } | null)?.setupState ?? {}) as Record<string, unknown>
}

let router: Router

beforeEach(async () => {
  stubBrowser()
  vi.stubGlobal('markRaw', markRaw)
  router = await makeRouter()
  vi.stubGlobal('useRouter', () => router)
  vi.stubGlobal('useVaultReferences', () => ({
    ensureResolved: vi.fn(),
    oracleLinkFor: (line: { adapter?: string }) => line.adapter ? { path: `/borrow/0x01/${EUSDC_42}`, hash: `#oracle-adapter-${line.adapter}` } : undefined,
  }))
  vi.stubGlobal('useVaultCheckWeights', () => ({ weighAll: (subjects: unknown[]) => subjects.map(() => null), getUncoveredBorrows: () => null }))
})

afterEach(() => {
  useModal().list.splice(0)
  vi.unstubAllGlobals()
})

const openChecksModal = () => useModal().open(VaultAssessmentChecksModal, { props: { assessment } })

describe('View oracle in the vault checks opened by "+K more · see checks"', () => {
  it('closes the full modal, then follows the link to another page', async () => {
    const id = openChecksModal()
    const view = mountClient(VaultAssessmentChecksModal, { assessment, modalId: id })
    const link: RouteLocationRaw = { path: `/borrow/0x01/${EUSDC_42}`, hash: `#${ANCHOR}` }

    await (view.followOracleLink as (to: RouteLocationRaw) => Promise<void>)(link)

    expect(useModal().list.some(modal => modal.id === id)).toBe(false)
    expect(browser.back).toHaveBeenCalledOnce()
    expect(router.currentRoute.value.fullPath).toBe(`/borrow/0x01/${EUSDC_42}#${ANCHOR}`)
  })

  it('closes the full modal before scrolling to an anchor on the same page', async () => {
    const id = openChecksModal()
    const view = mountClient(VaultAssessmentChecksModal, { assessment, modalId: id })

    await (view.followOracleLink as (to: RouteLocationRaw) => Promise<void>)({ path: EXPLORE, hash: `#${ANCHOR}` })

    expect(useModal().list.some(modal => modal.id === id)).toBe(false)
    expect(router.currentRoute.value.hash).toBe(`#${ANCHOR}`)
    expect(browser.scrolled).toEqual([{ id: ANCHOR, openModals: 0 }])
  })

  it('hides the hover preview and follows the link when the checks view is not a modal', async () => {
    const onClose = vi.fn()
    const view = mountClient(VaultAssessmentChecksModal, { assessment, inline: true, close: false, onClose })

    await (view.followOracleLink as (to: RouteLocationRaw) => Promise<void>)({ path: `/borrow/0x01/${EUSDC_42}`, hash: `#${ANCHOR}` })

    expect(onClose).toHaveBeenCalledOnce()
    expect(browser.back).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe(`/borrow/0x01/${EUSDC_42}`)
  })
})

describe('View oracle link in a check row', () => {
  const link = { path: `/borrow/0x01/${EUSDC_42}`, hash: `#${ANCHOR}` }
  const row: VaultCheckRowView = {
    key: 'oracle.adapters-checks#0',
    subject: null,
    weight: null,
    checks: [{
      key: 'oracle.adapters-checks',
      title: 'Adapters checks',
      status: 'failed',
      tone: 'warning',
      icon: 'warning',
      parts: [],
      tag: null,
      adapters: [{
        address: ADAPTER,
        oracleLink: link,
        oracleHref: `/borrow/0x01/${EUSDC_42}#${ANCHOR}`,
        findings: [{ key: 'session-tolerance', text: 'Its quote reverts are no longer excused.', severity: 'high' }],
      }],
    }],
  }

  it('renders a real link and hands the navigation to the checks view', async () => {
    const app = createSSRApp({ render: () => h(VaultAssessmentCheckRow, { row }) })
    app.config.warnHandler = () => undefined
    app.component('SvgIcon', { render: () => h('i') })
    app.component('VaultReference', defineComponent({ props: { address: String }, setup: props => () => h('span', props.address) }))
    expect(await renderToString(app)).toMatch(new RegExp(`<a href="/borrow/0x01/${EUSDC_42}#${ANCHOR}"[^>]*data-id="vault-check-oracle-link"`))

    const onNavigate = vi.fn()
    const state = mountClient(VaultAssessmentCheckRow, { row, onNavigate })
    ;(state.followOracleLink as (to: RouteLocationRaw) => void)(link)
    expect(onNavigate).toHaveBeenCalledWith(link)
  })
})
