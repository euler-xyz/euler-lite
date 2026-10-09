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

  it('keeps a known V3 vault name when its verdict is hidden or unavailable', async () => {
    expect(await renderName('v3', true, 'hidden')).toContain('Vault A')
    const expired = await renderName('v3', false)
    expect(expired).toContain('Vault A')
    expect(expired).not.toContain('Unknown')
  })
})
