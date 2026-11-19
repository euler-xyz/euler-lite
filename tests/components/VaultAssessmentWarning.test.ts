import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseVaultAssessment } from '@eulerxyz/euler-v2-sdk'
import { getVaultVerdictKey } from '~/utils/vault-assessment/flagged'
import VaultAssessmentWarning from '~/components/entities/vault/VaultAssessmentWarning.vue'
import { NO_OPERATIONS_HOOKED, makeEusdc42 } from '~/tests/fixtures/liquity-hub'
import { EUSDC_95, EUSDC_95_RAW_ASSESSMENT } from '~/tests/fixtures/v3-hidden-vault-assessments'

const address = '0x00000000000000000000000000000000000000aa'
const registry = vi.hoisted(() => ({ vault: undefined as unknown }))

vi.mock('~/composables/useVaultRegistry', () => ({
  useVaultRegistry: () => ({ get: () => registry.vault ? { vault: registry.vault } : undefined }),
}))

type RenderOptions = {
  loadError?: string
  status?: string
  decidedBy?: string
  reason?: string | null
  hideChecks?: boolean
  pairSide?: 'collateral' | 'borrow'
  findings?: Array<{ key: string, description: string, outcome: string, required: boolean, exempted?: boolean }>
  family?: 'evk' | 'earn' | null
  vault?: unknown
  entry?: unknown
  ensure?: ReturnType<typeof vi.fn>
}

const renderWarning = (ready: boolean, options: RenderOptions = {}) => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  registry.vault = options.vault
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(ready),
    loadError: ref(options.loadError === undefined ? 'Unable to load vault verification. Please retry.' : options.loadError),
    source: ref('v3'),
    vaultAssessments: ref({}),
    ensureVaultAssessment: options.ensure ?? vi.fn(),
    getVaultAssessmentEntry: () => options.entry ?? (options.findings
      ? { status: 'available', assessment: { assessed: true, configStatus: 'verified', checksStatus: 'warning', configContext: { outcome: 'pass', findings: options.findings }, consistencyContext: null } }
      : { status: 'idle' }),
    loadVaultAssessment: vi.fn(),
    visibility: ref({
      [address]: { status: options.status || 'warning', decidedBy: options.decidedBy || 'assessment', reason: options.reason === undefined ? 'Review the oracle.' : options.reason },
    }),
  }))
  const app = createSSRApp({ render: () => h(VaultAssessmentWarning, {
    address,
    hideChecks: options.hideChecks,
    pairSide: options.pairSide,
    ...('family' in options ? { family: options.family } : {}),
  }) })
  app.component('UiHoverPreviewTooltip', defineComponent({
    props: { title: String, text: String },
    setup: (props, { slots }) => () => h('div', { 'data-title': props.title, 'data-text': props.text }, slots.default?.()),
  }))
  app.component('SvgIcon', { render: () => h('span') })
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('vault verdict warning during a labels outage', () => {
  it('keeps the last-good warning until verification expires', async () => {
    expect(await renderWarning(true)).toMatch(/\sWarning<\/span>/)
    expect(await renderWarning(false)).not.toContain('vault-assessment-warning')
  })

  it('hides advisory warnings only when every failed finding is exempted', async () => {
    const accepted = { key: 'liquidation.max-discount', description: 'The maximum liquidation discount is between 5% and 20%', outcome: 'fail', required: false, exempted: true }
    const active = { key: 'oracle.liability-quote', description: 'The liability price quote executes on the oracle router', outcome: 'fail', required: false }
    expect(await renderWarning(true, { loadError: '', decidedBy: 'advisories', findings: [accepted] })).not.toContain('vault-assessment-warning')
    expect(await renderWarning(true, { loadError: '', decidedBy: 'advisories', findings: [accepted, active] })).toContain('vault-assessment-warning')
    expect(await renderWarning(true, { loadError: '', decidedBy: 'assessment', findings: [accepted] })).toContain('vault-assessment-warning')
  })

  it('keeps a flagged badge on a card without vault-check warnings', async () => {
    expect(await renderWarning(true, { hideChecks: true })).not.toContain('vault-assessment-warning')
    expect(await renderWarning(true, { hideChecks: true, status: 'hidden' })).toMatch(/\sFlagged<\/span>/)
  })
})

describe('flagged vault badge', () => {
  it('calls a hidden vault flagged and explains it with the V3 reason', async () => {
    const html = await renderWarning(true, { status: 'hidden', decidedBy: 'config-failed', reason: 'A required check failed.' })
    expect(html).toMatch(/\sFlagged<\/span>/)
    expect(html).toContain('data-title="Vault flagged"')
    expect(html).toContain('data-text="A required check failed."')
    expect(html).not.toContain('Not listed')
    expect(html).not.toContain('not listed')
  })

  it('falls back to the flagged sentence when V3 gives no reason', async () => {
    const html = await renderWarning(true, { status: 'hidden', decidedBy: 'config-failed', reason: null })
    expect(html).toContain('data-text="Euler&#39;s checks flagged this vault."')
  })

  it('shows no badge for a pending-review or visible vault', async () => {
    expect(await renderWarning(true, { status: 'pending_review', decidedBy: 'awaiting-verification' })).not.toContain('vault-assessment-warning')
    expect(await renderWarning(true, { status: 'visible', decidedBy: 'verified' })).not.toContain('vault-assessment-warning')
  })

  it('keeps the deprecated badge for a deprecated verdict', async () => {
    const html = await renderWarning(true, { status: 'warning', decidedBy: 'deprecated', reason: 'Deprecated.' })
    expect(html).toMatch(/\sDeprecated<\/span>/)
    expect(html).not.toContain('Flagged')
  })
})

describe('borrow pair badge', () => {
  it.each([
    ['collateral', 'Collateral'],
    ['borrow', 'Borrow'],
  ] as const)('names a flagged %s side flagged and keeps warning for a real warning', async (pairSide, label) => {
    const flagged = await renderWarning(true, { status: 'hidden', decidedBy: 'config-failed', reason: 'A required check failed.', pairSide })
    expect(flagged).toMatch(new RegExp(`\\s${label} flagged</span>`))
    expect(flagged).toContain('data-title="Vault flagged"')
    expect(flagged).not.toContain(`${label} warning`)
    const warning = await renderWarning(true, { status: 'warning', decidedBy: 'assessment', pairSide })
    expect(warning).toMatch(new RegExp(`\\s${label} warning</span>`))
    expect(warning).not.toContain('flagged')
  })
})

describe('paused vault badge', () => {
  const pausedReason = 'The vault is paused: withdraw, redeem, transfer and 4 more are off, so depositors cannot get out until its governor turns them back on.'
  const loadedUnder = (decidedBy: string) => getVaultVerdictKey({ status: 'hidden', decidedBy, reason: 'Review the oracle.' })
  const exitPausedCause = { status: 'available', assessment: parseVaultAssessment(EUSDC_95_RAW_ASSESSMENT, 1, EUSDC_95, 'evk'), verdictKey: loadedUnder('config-failed') }
  const securitizePausedCause = {
    status: 'available',
    verdictKey: loadedUnder('config-suspended'),
    assessment: { configContext: { findings: [{ key: 'operations.not-paused', outcome: 'fail', required: true, description: 'The vault is not paused', cause: { code: 'vault-paused', subject: null, summary: 'The vault is paused.', remedy: null } }] } },
  }
  const untrustedHook = makeEusdc42({
    hookedOperations: { ...NO_OPERATIONS_HOOKED, withdraw: true, redeem: true },
    hookTarget: '0x00000000000000000000000000000000000000bb',
  })

  it('calls a config-suspended vault with every operation hooked paused and keeps the V3 reason', async () => {
    const html = await renderWarning(true, { status: 'hidden', decidedBy: 'config-suspended', reason: pausedReason, vault: makeEusdc42() })
    expect(html).toMatch(/\sPaused<\/span>/)
    expect(html).toContain('data-title="Vault paused"')
    expect(html).toContain(`data-text="${pausedReason}"`)
    expect(html).not.toContain('Flagged')
  })

  it('calls a config-failed vault paused when its exits are hooked with a zero target', async () => {
    const exitsOff = makeEusdc42({ hookedOperations: { ...NO_OPERATIONS_HOOKED, deposit: true, withdraw: true, redeem: true, liquidate: true } })
    expect(await renderWarning(true, { status: 'hidden', decidedBy: 'config-failed', vault: exitsOff })).toMatch(/\sPaused<\/span>/)
  })

  it('keeps an ungoverned vault with its exits hooked flagged, since nobody can lift the pause', async () => {
    const ungoverned = Object.assign(
      makeEusdc42({ hookedOperations: { ...NO_OPERATIONS_HOOKED, withdraw: true, redeem: true } }),
      { governorAdmin: '0x0000000000000000000000000000000000000000' },
    )
    const html = await renderWarning(true, { status: 'hidden', decidedBy: 'config-failed', vault: ungoverned })
    expect(html).toMatch(/\sFlagged<\/span>/)
    expect(html).not.toContain('Paused')
  })

  it('keeps the exit-operations-disabled cause of an ungoverned vault flagged', async () => {
    const raw = structuredClone(EUSDC_95_RAW_ASSESSMENT)
    const hooks = raw.configContext.findings.find(finding => finding.key === 'hooks.zero-or-trusted') as { observed?: { governorAdmin?: string } }
    hooks.observed = { ...hooks.observed, governorAdmin: '0x0000000000000000000000000000000000000000' }
    const entry = { status: 'available', assessment: parseVaultAssessment(raw, 1, EUSDC_95, 'evk'), verdictKey: loadedUnder('config-failed') }
    expect(await renderWarning(true, { status: 'hidden', decidedBy: 'config-failed', entry })).toMatch(/\sFlagged<\/span>/)
  })

  it('accepts the exit-operations-disabled cause when the vault object is not loaded', async () => {
    expect(await renderWarning(true, { status: 'hidden', decidedBy: 'config-failed', entry: exitPausedCause })).toMatch(/\sPaused<\/span>/)
  })

  it('distrusts a pause cause loaded under another verdict and re-reads it', async () => {
    const ensure = vi.fn()
    const staleCause = { ...exitPausedCause, verdictKey: loadedUnder('config-suspended') }
    const html = await renderWarning(true, { status: 'hidden', decidedBy: 'config-failed', entry: staleCause, ensure })
    expect(html).toMatch(/\sFlagged<\/span>/)
    expect(ensure).toHaveBeenCalledWith(1, address, 'evk')
  })

  it('accepts the Securitize vault-paused cause', async () => {
    expect(await renderWarning(true, { status: 'hidden', decidedBy: 'config-suspended', family: null, entry: securitizePausedCause })).toMatch(/\sPaused<\/span>/)
  })

  it.each([
    ['an untrusted hook target gating withdrawals', { vault: untrustedHook }],
    ['only entry operations hooked', { vault: makeEusdc42({ hookedOperations: { ...NO_OPERATIONS_HOOKED, deposit: true, mint: true } }) }],
    ['no vault object and no assessment', {}],
    ['an Earn vault, which has no pause rule', { family: 'earn' as const, entry: exitPausedCause }],
  ])('keeps a config-suspended vault flagged with %s', async (_label, extra) => {
    const html = await renderWarning(true, { status: 'hidden', decidedBy: 'config-suspended', reason: 'A required check failed.', ...extra })
    expect(html).toMatch(/\sFlagged<\/span>/)
    expect(html).not.toContain('Paused')
  })

  it.each(['consistency-suspended', 'consistency-revoked', 'not-explorable'])('keeps a paused vault hidden as %s flagged', async (decidedBy) => {
    const html = await renderWarning(true, { status: 'hidden', decidedBy, reason: 'A required check failed.', vault: makeEusdc42() })
    expect(html).toMatch(/\sFlagged<\/span>/)
    expect(html).not.toContain('Paused')
  })

  it.each([
    ['collateral', 'Collateral'],
    ['borrow', 'Borrow'],
  ] as const)('names a paused %s side paused', async (pairSide, label) => {
    const html = await renderWarning(true, { status: 'hidden', decidedBy: 'config-suspended', reason: pausedReason, pairSide, vault: makeEusdc42() })
    expect(html).toMatch(new RegExp(`\\s${label} paused</span>`))
    expect(html).toContain('data-title="Vault paused"')
  })
})
