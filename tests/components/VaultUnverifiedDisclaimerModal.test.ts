import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import VaultUnverifiedDisclaimerModal from '~/components/entities/vault/VaultUnverifiedDisclaimerModal.vue'

const renderModal = (flaggedNotice?: string) => {
  const app = createSSRApp({
    render: () => h(VaultUnverifiedDisclaimerModal, { flaggedNotice }),
  })
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

describe('vault acknowledgement before a transaction', () => {
  it('asks a lighter confirmation for a flagged vault', async () => {
    const html = await renderModal('This transaction uses a flagged vault: A required check failed.')
    expect(html).toContain('data-title="Vault flagged"')
    expect(html).toContain('This transaction uses a flagged vault: A required check failed.')
    expect(html).toContain('<button>Confirm</button>')
    expect(html).toMatch(/<button>\s*Cancel\s*<\/button>/)
    expect(html).not.toContain('phishing')
    expect(html).not.toContain('not listed')
  })

  it('keeps the strict confirmation for an unknown vault', async () => {
    const html = await renderModal()
    expect(html).toContain('data-title="Important!"')
    expect(html).toContain('Unverified vault')
    expect(html).toContain('phishing attempts')
    expect(html).toContain('<button>Yes</button>')
    expect(html).toMatch(/<button>\s*Cancel\s*<\/button>/)
  })
})
