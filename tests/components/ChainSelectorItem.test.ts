import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const imageState = { isReady: false, error: null as unknown }

vi.mock('@vueuse/core', () => ({
  useImage: () => imageState,
}))

const { default: BaseAvatar } = await import('~/components/base/BaseAvatar.vue')
const { default: ChainSelectorItem } = await import('~/components/entities/chains/ChainSelectorItem.vue')

const BASE = 'https://v3.example/v3/images'

const render = (props: { chainId: number, name: string }, v3ImagesUrl = BASE) => {
  vi.stubGlobal('useEnvConfig', () => ({ v3ImagesUrl }))
  const app = createSSRApp({ render: () => h(ChainSelectorItem, props) })
  app.component('BaseAvatar', BaseAvatar)
  return renderToString(app)
}

describe('ChainSelectorItem', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the V3 chain logo once it has loaded', async () => {
    imageState.isReady = true
    const html = await render({ chainId: 8453, name: 'Base' })

    expect(html).toContain(`src="${BASE}/chains/8453"`)
  })

  it('shows the bundled chain logo while the V3 logo loads', async () => {
    imageState.isReady = false
    const html = await render({ chainId: 8453, name: 'Base' })

    expect(html).toMatch(/<img[^>]+src="data:image\//)
    expect(html).not.toContain('data-label')
  })

  it('goes straight to the bundled logo when the images base is unknown', async () => {
    imageState.isReady = false
    const html = await render({ chainId: 8453, name: 'Base' }, '')

    expect(html).toMatch(/<img[^>]+src="data:image\//)
    expect(html).not.toContain('/chains/8453')
  })

  it('shows the chain initials for a chain with no bundled logo', async () => {
    imageState.isReady = false
    const html = await render({ chainId: 424242, name: 'Forknet' })

    expect(html).toContain('data-label="Fo"')
    expect(html).not.toContain('<img')
  })
})
