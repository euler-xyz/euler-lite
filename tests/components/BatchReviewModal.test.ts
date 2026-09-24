import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BatchReviewModal from '~/components/BatchReviewModal.vue'
import { BatchPreviewNotReadyError, ReviewedPlanDivergenceError } from '~/features/reviewed-execution/planning/errors'

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }))

// Run the modal's mounted preparation before asserting its server-rendered output.
vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<typeof import('vue')>()
  return { ...vue, onMounted: vue.onServerPrefetch }
})

vi.mock('~/composables/useTxBatch', () => ({
  useTxBatch: () => ({
    entries: ref([]), layers: ref([]), walletChanges: ref([]), entryPlans: ref({}), marketByEntryId: ref({}),
    simError: ref(), execError: ref(), insufficientBalanceMessage: ref(),
    isSimulating: ref(false), canExecuteBatch: ref(true), hasFailedOps: ref(false), hasInsufficientBalance: ref(false),
    tenderlyEnabled: ref(false), isTenderlySimulating: ref(false), tenderlyUrl: ref(), tenderlyError: ref(),
    prepareBatchExecutionReview: mocks.prepare, fetchTenderlyEnabled: vi.fn(), dismissExecutionError: vi.fn(),
  }),
  buildModifiedPositionKeySets: () => ({ any: new Set() }),
  buildRemovedPositionKeySets: () => new Set(),
  filterPositionKeysByOwner: () => new Set(),
}))
vi.mock('~/composables/useTokenSymbolResolver', () => ({
  useTokenSymbolResolver: () => ({ buildKnownSymbols: () => ({}), resolveSymbol: () => '' }),
}))
vi.mock('~/composables/useVaultRegistry', () => ({
  useVaultRegistry: () => ({ getVault: vi.fn(), isVerifiedVault: () => true }),
}))
vi.mock('~/composables/useTokenList', () => ({ getAssetLogoUrl: () => '' }))
vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({}) }))
vi.mock('~/utils/errorHandling', () => ({ logWarn: vi.fn() }))

const renderModal = () => {
  const app = createSSRApp(BatchReviewModal)
  app.component('BaseModalWrapper', defineComponent({
    setup: (_, { slots }) => () => h('div', slots.default?.()),
  }))
  app.component('UiButton', defineComponent({
    inheritAttrs: false,
    setup: (_, { attrs, slots }) => () => h('button', attrs, slots.default?.()),
  }))
  app.component('UiAlert', defineComponent({
    props: ['title', 'description'],
    setup: props => () => h('p', { 'data-alert-title': props.title }, props.description),
  }))
  for (const name of ['SvgIcon', 'BatchStepCircle', 'BatchOperationLabel', 'BatchMarketLabel', 'OperationStepsList', 'BatchAlert']) {
    app.component(name, { render: () => h('span') })
  }
  return renderToString(app)
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.prepare.mockReset()
  vi.stubGlobal('useReviewedExecution', () => ({}))
  vi.stubGlobal('useEffectiveAddress', () => ({ isSpyMode: ref(false), effectiveAddress: ref('0x1000000000000000000000000000000000000000') }))
  vi.stubGlobal('useEulerAddresses', () => ({ eulerCoreAddresses: ref({}) }))
  vi.stubGlobal('useClipboardCopy', () => ({ copied: ref(false), copyToClipboard: vi.fn() }))
  vi.stubGlobal('useSafeExecutionDetachment', () => ({ hasPendingDetachedExecution: ref(false) }))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('batch review preparation failures', () => {
  it.each([
    { label: 'changed plans', error: new ReviewedPlanDivergenceError(['row-1']), message: 'Remove and re-add the affected operations', synchronous: false },
    { label: 'unfinished previews', error: new BatchPreviewNotReadyError(), message: 'Wait for every operation to finish preparing', synchronous: true },
    { label: 'unexpected failures', error: new Error('private diagnostic details'), message: 'Unable to prepare this batch', synchronous: false },
  ])('shows guidance for $label and blocks execution and calldata copying', async ({ error, message, synchronous }) => {
    if (synchronous) {
      mocks.prepare.mockImplementation(() => {
        throw error
      })
    }
    else {
      mocks.prepare.mockRejectedValue(error)
    }
    const html = await renderModal()
    expect(html).toContain(message)
    expect(html).not.toContain('private diagnostic details')
    for (const action of ['batch-copy-calldata', 'batch-review-execute']) {
      expect(html).toMatch(new RegExp(`<button(?=[^>]*data-testid="${action}")(?=[^>]*disabled)[^>]*>`))
    }
  })
})
