import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OperationStepsList from '~/components/entities/operation/OperationStepsList.vue'

const TOKEN = '0x0000000000000000000000000000000000000041'

describe('OperationStepsList', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders a raw base-unit approval amount without numeric coercion', async () => {
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    const app = createSSRApp(OperationStepsList, {
      steps: [{
        index: 1,
        label: 'Approve',
        labelSuffix: `for spender ${TOKEN}`,
        isSeparateTx: true,
        assetInfo: {
          symbol: TOKEN,
          address: TOKEN,
          amount: '123 base units',
          rawAmount: true,
        },
      }],
    })
    app.component('AssetAvatar', defineComponent({ render: () => h('span') }))
    app.component('UiExactAmount', defineComponent({
      setup: (_props, { slots }) => () => h('span', slots.default?.()),
    }))

    const html = await renderToString(app)
    const text = html.replace(/<[^>]+>/g, ' ').replaceAll('&nbsp;', ' ').replace(/\s+/g, ' ')
    expect(text).toContain(`123 base units ${TOKEN}`)
    expect(text).not.toContain(`- ${TOKEN}`)
  })
})
