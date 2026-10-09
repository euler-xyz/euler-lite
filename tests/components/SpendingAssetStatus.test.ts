import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SpendingAssetStatus from '~/components/entities/asset/SpendingAssetStatus.vue'

describe('spending asset verification status', () => {
  it('shows pending verification', async () => {
    const html = await renderToString(createSSRApp(() => h(SpendingAssetStatus, { loading: true })))
    expect(html).toContain('Verifying token decimals')
    expect(html).not.toContain('<button')
  })
  it('shows an actionable error rather than falling back to list units', async () => {
    const html = await renderToString(createSSRApp(() => h(SpendingAssetStatus, { error: 'Unable to verify token decimals.' })))
    expect(html).toContain('Unable to verify token decimals.')
    expect(html).toContain('Retry')
    expect(html).toContain('<button')
  })
})
