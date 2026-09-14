import { createSSRApp, defineComponent, h, nextTick, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VaultFormSubmit from '~/components/entities/vault/form/VaultFormSubmit.vue'
import type { UnverifiedVaultGuardState } from '~/composables/guards/useUnverifiedVaultGuard'

vi.mock('#components', () => ({ AcknowledgeTermsModal: {}, VaultUnverifiedDisclaimerModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: vi.fn() }) }))
vi.mock('~/composables/useStateOverrideOptions', () => ({
  useStateOverrideResolution: () => ({ isResolvingStateOverrideHints: ref(false) }),
}))
vi.mock('@floating-ui/vue', () => ({
  useFloating: () => ({ floatingStyles: {}, update: vi.fn() }),
  flip: vi.fn(), offset: vi.fn(), shift: vi.fn(),
}))

const connected = ref(false)
const walletChain = ref(1)
const renderSubmit = (guard: Partial<UnverifiedVaultGuardState>) => {
  const app = createSSRApp({
    render: () => h(VaultFormSubmit, { disabled: true }, { default: () => 'Deposit' }),
  })
  app.provide('unverified-vault-guard', guard)
  app.component('UiButton', defineComponent({
    inheritAttrs: false,
    setup: (_, { attrs, slots }) => () => h('button', attrs, slots.default?.()),
  }))
  for (const name of ['SvgIcon', 'KeyringAlert', 'KeyringVerificationFlow']) {
    app.component(name, { render: () => h('span') })
  }
  return renderToString(app)
}

describe('vault form verification prerequisites', () => {
  beforeEach(() => {
    connected.value = false
    walletChain.value = 1
    vi.stubGlobal('nextTick', nextTick)
    vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableAdvancedMode: false }) }))
    vi.stubGlobal('useWagmi', () => ({
      isConnected: connected, chainId: walletChain, switchChain: vi.fn(), connect: vi.fn(),
    }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(143) }))
    vi.stubGlobal('useTxBatch', () => ({ entryCount: ref(0), clearBatch: vi.fn() }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('offers an enabled Connect wallet action before an unverified acknowledgement', async () => {
    const html = await renderSubmit({ isAcknowledgmentRequired: true })
    expect(html).toContain('Connect wallet')
    expect(html).not.toContain('Acknowledge Unverified Vault Risk')
    expect(html).not.toMatch(/<button[^>]*disabled/)
  })

  it('offers an enabled Switch chain action while verification is unavailable', async () => {
    connected.value = true
    const html = await renderSubmit({ verificationError: 'Temporary failure' })
    expect(html).toContain('Switch chain')
    expect(html).not.toContain('Retry verification')
    expect(html).not.toMatch(/<button[^>]*disabled/)
  })

  it('shows loading and retry states once wallet prerequisites are met', async () => {
    connected.value = true
    walletChain.value = 143
    expect(await renderSubmit({ isVerificationLoading: true })).toContain('Checking vault verification')
    const html = await renderSubmit({ verificationError: 'Temporary failure' })
    expect(html).toContain('Retry verification')
    expect(html).not.toContain('Acknowledge Unverified Vault Risk')
  })
})
