import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import VaultOpeningNoticeModal from '~/components/entities/vault/VaultOpeningNoticeModal.vue'

const renderModal = (flaggedText?: string) => {
  const app = createSSRApp({ render: () => h(VaultOpeningNoticeModal, { flaggedText }) })
  app.component('BaseModalWrapper', defineComponent({
    props: { title: String },
    setup: (props, { slots }) => () => h('div', { 'data-title': props.title }, slots.default?.()),
  }))
  app.component('UiButton', defineComponent({
    inheritAttrs: false,
    setup: (_, { slots }) => () => h('button', slots.default?.()),
  }))
  return renderToString(app)
}

describe('vault opening pop-up', () => {
  it('asks the strict question for an unknown vault', async () => {
    const html = await renderModal()
    expect(html).toContain('data-title="Important!"')
    expect(html).toContain('Are you sure you want to interact with this unknown vault? It may pose security risks and could be used for phishing. Make sure you trust the source before you continue.')
    expect(html).toContain('<button>Yes</button>')
    expect(html).toContain('<button>Cancel</button>')
  })

  it('shows the lighter notice for a flagged vault', async () => {
    const html = await renderModal('Euler\'s checks flagged this vault: A required check failed. Continue only if you understand the risk.')
    expect(html).toContain('data-title="Vault flagged"')
    expect(html).toContain('Euler&#39;s checks flagged this vault: A required check failed. Continue only if you understand the risk.')
    expect(html).toContain('<button>Continue</button>')
    expect(html).toContain('<button>Go back</button>')
    expect(html).not.toContain('phishing')
  })
})
