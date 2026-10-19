import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BatchReviewModal from '~/components/BatchReviewModal.vue'
import { BatchPreviewNotReadyError, ReviewedPlanDivergenceError } from '~/features/reviewed-execution/planning/errors'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  entries: [] as Array<{ id: string, review: Record<string, unknown> }>,
  entryPlans: {} as Record<string, unknown>,
  vaults: {} as Record<string, { shares: { name: string } }>,
  verified: new Set<string>(),
  labelsSource: 'static',
  visibility: {} as Record<string, { status: string, decidedBy?: string, reason?: string | null }>,
}))

// Run the modal's mounted preparation before asserting its server-rendered output.
vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<typeof import('vue')>()
  return { ...vue, onMounted: vue.onServerPrefetch }
})

vi.mock('~/composables/useTxBatch', () => ({
  useTxBatch: () => ({
    entries: ref(mocks.entries), layers: ref([]), walletChanges: ref([]), entryPlans: ref(mocks.entryPlans), marketByEntryId: ref({}),
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
  useVaultRegistry: () => ({
    getVault: (address: string) => mocks.vaults[address.toLowerCase()],
    isVerifiedVault: (address: string) => mocks.verified.has(address.toLowerCase()),
  }),
}))
vi.mock('~/composables/useTokenList', () => ({ getAssetLogoUrl: () => '' }))
vi.mock('~/composables/useEulerLabels', () => ({
  useEulerLabels: () => ({ isReady: ref(true), source: ref(mocks.labelsSource), visibility: ref(mocks.visibility) }),
}))
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
  mocks.entries.length = 0
  mocks.entryPlans = {}
  mocks.vaults = {}
  mocks.visibility = {}
  mocks.verified = new Set()
  mocks.labelsSource = 'static'
  vi.stubGlobal('useReviewedExecution', () => ({}))
  vi.stubGlobal('useEffectiveAddress', () => ({ isSpyMode: ref(false), effectiveAddress: ref('0x1000000000000000000000000000000000000000') }))
  vi.stubGlobal('useEulerAddresses', () => ({ eulerCoreAddresses: ref({}) }))
  vi.stubGlobal('useClipboardCopy', () => ({ copied: ref(false), copyToClipboard: vi.fn() }))
  vi.stubGlobal('useSafeExecutionDetachment', () => ({ hasPendingDetachedExecution: ref(false) }))
})

describe('batch rEUL burn warnings', () => {
  it.each([
    { label: 'zero raw burn', hasBurn: false, amountToBeBurned: 0, daysUntilMaturity: 0 },
    { label: 'a positive raw burn with zero displayed days', hasBurn: true, amountToBeBurned: 1, daysUntilMaturity: 0 },
    { label: 'a positive raw burn that formats as zero', hasBurn: true, amountToBeBurned: 1e-18, daysUntilMaturity: 0 },
  ])('respects the captured burn condition for $label', async ({ hasBurn, amountToBeBurned, daysUntilMaturity }) => {
    mocks.entries.push({
      id: 'reul-unlock',
      review: {
        type: 'reul-unlock',
        reulUnlockInfo: { hasBurn, unlockableAmount: 100, amountToBeBurned, daysUntilMaturity, maturityDate: 'October 12, 2026' },
      },
    })
    mocks.prepare.mockRejectedValue(new BatchPreviewNotReadyError())
    const html = await renderModal()
    expect(html.includes('data-alert-title="rEUL burn mechanics"')).toBe(hasBurn)
  })
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

describe('batch review vault confirmation', () => {
  const LISTED = '0x00000000000000000000000000000000000000b1'
  const FLAGGED = '0x00000000000000000000000000000000000000b2'
  const UNKNOWN = '0x00000000000000000000000000000000000000b3'
  const ACCOUNT = '0x1000000000000000000000000000000000000000'
  const batchTargeting = (...targets: string[]) => {
    mocks.entries.push({ id: 'swap', review: { type: 'swap' } })
    mocks.entryPlans.swap = [{
      type: 'evcBatch',
      items: targets.map(targetContract => ({ targetContract, onBehalfOfAccount: ACCOUNT, value: 0n, data: '0x' })),
    }]
  }

  beforeEach(() => {
    mocks.labelsSource = 'v3'
    mocks.verified.add(LISTED)
    mocks.vaults[LISTED] = { shares: { name: 'Listed vault' } }
    mocks.vaults[FLAGGED] = { shares: { name: 'Flagged vault' } }
    mocks.vaults[UNKNOWN] = { shares: { name: 'Unknown vault' } }
    mocks.visibility[LISTED] = { status: 'visible', decidedBy: 'verified' }
    mocks.visibility[FLAGGED] = { status: 'hidden', decidedBy: 'config-failed', reason: 'The oracle failed' }
    mocks.visibility[UNKNOWN] = { status: 'pending_review', decidedBy: 'awaiting-verification' }
    mocks.prepare.mockRejectedValue(new BatchPreviewNotReadyError())
  })

  it('uses the flagged copy when the calldata of an operation from a listed vault targets a flagged vault', async () => {
    batchTargeting(LISTED, FLAGGED)
    const html = await renderModal()
    expect(html).toContain('data-alert-title="Vault flagged"')
    expect(html).toContain('This transaction uses a flagged vault: The oracle failed.')
    expect(html).not.toContain('not listed')
  })

  it('keeps the strict copy when the batch also targets a pending-review vault', async () => {
    batchTargeting(FLAGGED, UNKNOWN)
    const html = await renderModal()
    expect(html).toContain('data-alert-title="Unverified vault"')
    expect(html).toContain('phishing attempts')
  })

  it('shows no vault alert for listed vaults only', async () => {
    batchTargeting(LISTED)
    const html = await renderModal()
    expect(html).not.toContain('data-alert-title="Vault flagged"')
    expect(html).not.toContain('data-alert-title="Unverified vault"')
  })
})
