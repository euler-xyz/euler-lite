import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it, vi } from 'vitest'

const imageState = { isReady: false, error: null as unknown }

vi.mock('@vueuse/core', () => ({
  useImage: () => imageState,
}))

const { default: BaseAvatar } = await import('~/components/base/BaseAvatar.vue')

const INLINE_LOGO = 'data:image/svg+xml;base64,PHN2Zy8+'
const REMOTE_LOGO = 'https://images.example/v3/images/chains/8453'

const render = (props: Record<string, unknown>) =>
  renderToString(createSSRApp({ render: () => h(BaseAvatar, props) }))

describe('BaseAvatar', () => {
  it('shows an inline fallback while the remote image is still loading', async () => {
    imageState.isReady = false
    const html = await render({ src: REMOTE_LOGO, fallbackSrc: INLINE_LOGO, label: 'Base' })

    expect(html).toContain(`src="${INLINE_LOGO}"`)
    expect(html).not.toContain('data-label')
  })

  it('shows initials while loading when the fallback is not inline', async () => {
    imageState.isReady = false
    const html = await render({ src: REMOTE_LOGO, fallbackSrc: 'https://other.example/logo.png', label: 'Base' })

    expect(html).toContain('data-label="Ba"')
    expect(html).not.toContain('<img')
  })

  it('shows the remote image once it has loaded', async () => {
    imageState.isReady = true
    const html = await render({ src: REMOTE_LOGO, fallbackSrc: INLINE_LOGO, label: 'Base' })

    expect(html).toContain(`src="${REMOTE_LOGO}"`)
  })
})
