import { createSSRApp, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VaultDisplayName from '~/components/entities/vault/VaultDisplayName.vue'

const ADDRESS = '0x00000000000000000000000000000000000000a1'

const renderName = async (source: string, ready: boolean, status?: string) => {
  vi.stubGlobal('useEulerLabels', () => ({
    source: ref(source),
    isReady: ref(ready),
    visibility: ref(status ? { [ADDRESS.toLowerCase()]: { status } } : {}),
  }))
  vi.stubGlobal('useVaultRegistry', () => ({ isVerifiedVault: () => false }))
  const app = createSSRApp({ render: () => h(VaultDisplayName, { name: 'Vault A', isUnverified: true, addresses: [ADDRESS] }) })
  app.component('SvgIcon', { render: () => h('i') })
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('vault identity marker', () => {
  it('keeps Unknown for an unrecognized vault', async () => {
    expect(await renderName('static', true)).toContain('Unknown')
  })

  it('keeps a flagged V3 vault name, and the name while verification is unavailable', async () => {
    const flagged = await renderName('v3', true, 'hidden')
    expect(flagged).toContain('Vault A')
    expect(flagged).not.toContain('Unknown')
    const expired = await renderName('v3', false)
    expect(expired).toContain('Vault A')
    expect(expired).not.toContain('Unknown')
  })

  it('calls a V3 vault with no verdict or a pending verdict Unknown', async () => {
    const missing = await renderName('v3', true)
    expect(missing).toContain('Unknown')
    expect(missing).not.toContain('Vault A')
    const pending = await renderName('v3', true, 'pending_review')
    expect(pending).toContain('Unknown')
    expect(pending).not.toContain('Vault A')
  })
})
