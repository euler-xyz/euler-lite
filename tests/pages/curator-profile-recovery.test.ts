import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { createRenderer, defineComponent, h, nextTick, ref, ssrContextKey, type App } from 'vue'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EulerLabelEntity } from '~/entities/euler/labels'
import type { CuratorProfileData } from '~/utils/curator-profile'
import CuratorProfilePage from '~/pages/curators/[slug].vue'

vi.mock('~/entities/euler/labels', () => ({ getEulerLabelEntityLogo: () => '' }))
vi.mock('~/entities/chainRegistry', () => ({ getChainById: () => ({ name: 'Ethereum' }) }))
vi.mock('~/utils/chain-logo', () => ({ getChainLogoUrl: () => '' }))
vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<typeof import('vue')>()
  return {
    ...vue,
    Transition: vue.defineComponent({ inheritAttrs: false, setup: (_, { slots }) => () => slots.default?.() }),
  }
})

// Compile the client template so clicks and recovery update the same mounted page.
const { descriptor } = parse(readFileSync(new URL('../../pages/curators/[slug].vue', import.meta.url), 'utf8'))
const { bindings } = compileScript(descriptor, { id: 'curator-recovery-test' })
const { code } = compileTemplate({
  source: descriptor.template!.content,
  filename: 'CuratorProfilePage.vue',
  id: 'curator-recovery-test',
  compilerOptions: { mode: 'function', bindingMetadata: bindings },
})
const Page = { ...CuratorProfilePage, render: new Function('Vue', code)(Vue) }

type TestNode = {
  type: string
  props: Record<string, unknown>
  children: TestNode[]
  parent: TestNode | null
  text: string
}
const node = (type: string, text = ''): TestNode => ({ type, text, props: {}, children: [], parent: null })
const descendants = (root: TestNode): TestNode[] => [root, ...root.children.flatMap(descendants)]
const textContent = (root: TestNode): string => root.type === 'comment'
  ? ''
  : root.text + (root.props.innerHTML ?? '') + root.children.map(textContent).join('')
const detach = (child: TestNode) => {
  if (!child.parent) return
  child.parent.children.splice(child.parent.children.indexOf(child), 1)
  child.parent = null
}

const curator: EulerLabelEntity = {
  id: 'test-curator', name: 'Test Curator', logo: '', description: 'Network-label description',
  url: 'https://curator.example', addresses: {},
  social: { twitter: '', youtube: '', discord: '', telegram: '', github: '' },
}
let app: App | undefined

const mountProfile = (fallback: EulerLabelEntity | null = curator) => {
  const data = ref<CuratorProfileData>()
  const status = ref<'success' | 'pending' | 'error'>('error')
  const error = ref<Error | null>(new Error('Profile unavailable'))
  let finishRefresh: (result: CuratorProfileData | Error) => void
  const refresh = vi.fn(() => {
    status.value = 'pending'
    return new Promise<void>((resolve) => {
      finishRefresh = (result) => {
        if (result instanceof Error) {
          error.value = result
          status.value = 'error'
        }
        else {
          data.value = result
          error.value = null
          status.value = 'success'
        }
        resolve()
      }
    })
  })
  vi.stubGlobal('useRoute', () => ({ params: { slug: curator.id }, query: { network: '1' }, hash: '' }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
  vi.stubGlobal('useWagmi', () => ({ changeChain: vi.fn() }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1), allowedChainIds: ref([1]) }))
  vi.stubGlobal('useEulerCuratorProfile', () => ({
    fallbackEntity: ref(fallback), managedMarkets: ref([]), earnVaults: ref([]),
    isUnavailable: ref(false), isLoading: ref(false),
  }))
  const useFetch = vi.fn((url: () => string) => url().includes('curator-profiles')
    ? { data, status, error, refresh }
    : { data: ref({ networks: [] }), status: ref('success'), error: ref(null), refresh: vi.fn() })
  vi.stubGlobal('useFetch', useFetch)

  const renderer = createRenderer<TestNode, TestNode>({
    createElement: type => node(type),
    createText: text => node('text', text),
    createComment: text => node('comment', text),
    patchProp: (el, key, _previous, value) => { el.props[key] = value },
    insert: (child, parent, anchor) => {
      detach(child)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child)
      child.parent = parent
    },
    remove: detach,
    setText: (el, text) => { el.text = text },
    setElementText: (el, text) => {
      el.text = text
      el.children = []
    },
    parentNode: el => el.parent,
    nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  })
  app = renderer.createApp(Page)
  const stub = defineComponent({ setup: (_, { slots }) => () => h('div', [slots.default?.(), slots.action?.()]) })
  for (const name of [
    'BackButton', 'BaseAvatar', 'UiHoverPreviewTooltip', 'UiProgress', 'UiIcon', 'UiTabs',
    'UiLoader', 'LabelsUnavailableState', 'UiEmptyState', 'NuxtLink',
    'DiscoveryMarketAccordion', 'VaultEarnItem',
  ]) app.component(name, stub)
  app.component('UiButton', defineComponent({ setup: (_, { slots }) => () => h('button', slots.default?.()) }))
  app.provide(ssrContextKey, {})
  const root = node('root')
  app.mount(root)
  return {
    text: () => textContent(root),
    retry: () => descendants(root).find(el => el.type === 'button' && /Try again|Retrying/.test(textContent(el))),
    refresh,
    finish: (result: CuratorProfileData | Error) => finishRefresh(result),
    useFetch,
  }
}

afterEach(() => {
  app?.unmount()
  app = undefined
  vi.unstubAllGlobals()
})

describe('curator profile recovery', () => {
  it('retries from fallback details and restores the published profile without remounting', async () => {
    const page = mountProfile()
    expect(page.text()).toContain('Test Curator')
    expect(page.text()).toContain('Network-label description')
    expect(page.text()).not.toContain('% complete')
    expect(page.retry()).toBeDefined()

    const pending = (page.retry()!.props.onClick as () => Promise<void>)()
    await nextTick()
    expect(page.refresh).toHaveBeenCalledTimes(1)
    expect(page.retry()!.props.disabled).toBe(true)
    expect(page.text()).toContain('Retrying…')
    expect(page.text()).toContain('Network-label description')

    page.finish({ source: 'v3', entity: { ...curator, description: 'Published profile description' } })
    await pending
    await nextTick()
    expect(page.text()).toContain('Published profile description')
    expect(page.text()).toContain('25% complete')
    expect(page.text()).not.toContain('Network-label description')
    expect(page.retry()).toBeUndefined()
    expect(page.useFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps fallback details and re-enables retry after another failure', async () => {
    const page = mountProfile()
    expect(page.retry()).toBeDefined()
    const pending = (page.retry()!.props.onClick as () => Promise<void>)()
    page.finish(new Error('Still unavailable'))
    await pending
    await nextTick()

    expect(page.text()).toContain('Network-label description')
    expect(page.text()).not.toContain('% complete')
    expect(page.retry()!.props.disabled).toBe(false)
    expect(page.text()).toContain('Try again')
  })

  it('retains the unavailable-state retry when no fallback profile exists', async () => {
    const page = mountProfile(null)
    expect(page.retry()).toBeDefined()
    const pending = (page.retry()!.props.onClick as () => Promise<void>)()
    page.finish({ source: 'v3', entity: curator })
    await pending
    await nextTick()

    expect(page.refresh).toHaveBeenCalledTimes(1)
    expect(page.text()).toContain('Test Curator')
    expect(page.text()).toContain('25% complete')
  })
})
