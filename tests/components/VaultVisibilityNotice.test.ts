import { createSSRApp, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VaultVisibilityNotice from '~/components/entities/vault/VaultVisibilityNotice.vue'

const ADDRESS = '0x00000000000000000000000000000000000000a1'

const renderNotice = (verdict?: { status: string, decidedBy?: string, reason?: string | null }, source = 'v3') => {
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(true),
    source: ref(source),
    visibility: ref(verdict ? { [ADDRESS]: verdict } : {}),
  }))
  return renderToString(createSSRApp({ render: () => h(VaultVisibilityNotice, { address: ADDRESS }) }))
}

afterEach(() => vi.unstubAllGlobals())

describe('vault status line under the name', () => {
  it('words a hidden vault as flagged, with the V3 reason', async () => {
    const html = await renderNotice({ status: 'hidden', decidedBy: 'config-failed', reason: 'A required check failed' })
    expect(html).toContain('Euler&#39;s checks flagged this vault: A required check failed.')
    expect(html).not.toContain('not listed')
  })

  it('falls back to the flagged sentence without a reason', async () => {
    expect(await renderNotice({ status: 'hidden', decidedBy: 'config-failed', reason: null })).toContain('Euler&#39;s checks flagged this vault.')
  })

  it('shows no line for a pending-review, visible or unlabelled vault', async () => {
    expect(await renderNotice({ status: 'pending_review', decidedBy: 'awaiting-verification' })).not.toContain('<p')
    expect(await renderNotice({ status: 'pending_review', decidedBy: 'unclaimed' })).not.toContain('<p')
    expect(await renderNotice({ status: 'visible', decidedBy: 'verified' })).not.toContain('<p')
    expect(await renderNotice()).not.toContain('<p')
  })
})
