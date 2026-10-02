import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import VaultUnverifiedDisclaimerModal from '~/components/entities/vault/VaultUnverifiedDisclaimerModal.vue'

const renderModal = (unlistedNotice?: string) => {
  const app = createSSRApp({
    render: () => h(VaultUnverifiedDisclaimerModal, { unlistedNotice }),
  })
  app.component('BaseModalWrapper', defineComponent({
    setup: (_, { slots }) => () => h('div', slots.default?.()),
  }))
  app.component('UiButton', defineComponent({
    setup: (_, { slots }) => () => h('button', slots.default?.()),
  }))
  return renderToString(app)
}

describe('unverified vault acknowledgement copy', () => {
  it('uses the V3 status without phishing copy for a known unlisted vault', async () => {
    const html = await renderModal('This vault is not listed in the published vault labels.')
    expect(html).toContain('Vault not listed')
    expect(html).toContain('published vault labels')
    expect(html).not.toContain('not been checked yet')
    expect(html).not.toContain('phishing')
  })

  it('keeps the caution for an unknown vault', async () => {
    const html = await renderModal()
    expect(html).toContain('Unverified vault')
    expect(html).toContain('phishing attempts')
  })
})
