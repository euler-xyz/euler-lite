import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultAssessment, VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import VaultAssessmentChecksModal from '~/components/entities/vault/overview/VaultAssessmentChecksModal.vue'
import VaultAssessmentCheckRow from '~/components/entities/vault/overview/VaultAssessmentCheckRow.vue'

const STRATEGY = '0x6fe7fa90756434645f0b0428fdff78e99dda0fbc'
const PRIME = '0x797dd80692c3b2dadabce8e30c07fde5307d48a9'
const SHARES: Record<string, number> = { [STRATEGY]: 0.06, [PRIME]: 0.94 }

const finding = (key: string, overrides: Partial<VaultAssessmentFinding> = {}): VaultAssessmentFinding => ({
  key,
  outcome: 'pass',
  required: true,
  description: `Rule documentation for ${key}`,
  cause: null,
  ...overrides,
})

const assessment = (findings: VaultAssessmentFinding[]): VaultAssessment => ({
  chainId: 1,
  vaultAddress: '0x3B4802FDb0E5d74aA37d58FD77d63e93d4f9A4AF',
  family: 'earn',
  configStatus: 'verified',
  checksStatus: 'positive',
  configReason: null,
  consistencyReason: null,
  configContext: { findings, outcome: 'pass' },
  consistencyContext: null,
  configLastCheckedAt: null,
  nextCheckAt: null,
  createdAt: '2026-09-28T12:00:00.000Z',
  assessed: true,
} as VaultAssessment)

const render = (findings: VaultAssessmentFinding[]) => {
  const ensureResolved = vi.fn()
  vi.stubGlobal('useVaultReferences', () => ({ ensureResolved }))
  const weighAll = vi.fn((subjects: { address: string }[]) => subjects.map(({ address }) => {
    const share = SHARES[address.toLowerCase()]
    return share === undefined ? null : { value: share, label: `Holds ${share * 100}% of deposits` }
  }))
  vi.stubGlobal('useVaultCheckWeights', () => ({ weighAll }))
  const app = createSSRApp({ render: () => h(VaultAssessmentChecksModal, { assessment: assessment(findings) }) })
  app.component('BaseModalWrapper', defineComponent({ setup: (_props, { slots }) => () => h('div', slots.default?.()) }))
  app.component('VaultAssessmentCheckRow', VaultAssessmentCheckRow)
  app.component('SvgIcon', { render: () => h('span') })
  app.component('VaultReference', defineComponent({
    props: { address: String, fallback: String },
    setup: props => () => h('span', { 'data-reference': props.address?.toLowerCase() }, props.address?.toLowerCase() === STRATEGY ? 'AlphaGrowth Cap USDC' : props.fallback),
  }))
  return { html: renderToString(app), ensureResolved, weighAll }
}

afterEach(() => vi.unstubAllGlobals())

describe('vault checks pop-up', () => {
  const findings = [
    finding('governance.timelock'),
    finding('evidence.multisig', { outcome: 'not_applicable', required: false }),
    finding(`collateral.${STRATEGY}.ramp`, { outcome: 'not_applicable', required: false }),
    finding(`strategy.${STRATEGY}.visible`, {
      outcome: 'fail',
      required: false,
      cause: { code: 'dependency-deprecated', subject: STRATEGY, summary: 'Strategy 0x6fe7fa…0fbc is deprecated: Deprecated due to low activity.', remedy: 'remove-the-dependency' },
    }),
    finding('governance.curator-registered', {
      outcome: 'not_applicable',
      cause: { code: 'curator-unset', subject: null, summary: 'The vault has no curator; its owner holds the curator role.', remedy: null },
    }),
  ]

  it('states that checks are not a recommendation', async () => {
    expect((await render(findings).html)).toContain('They are not a risk rating or a recommendation by Euler.')
  })

  it('groups checks by category, the group with a failure first, and leaves out data-only evidence', async () => {
    const html = await render(findings).html
    const groups = [...html.matchAll(/data-group="([^"]+)"/g)].map(match => match[1])
    expect(groups).toEqual(['strategy', 'governance'])
    expect(html).toContain('Strategies')
    expect(html).not.toContain('evidence.multisig')
    expect(html).not.toContain(`collateral.${STRATEGY}.ramp`)
    expect(html.match(/>N\/A</g)).toHaveLength(1)
  })

  it('names the subject, says the failure does not affect listing, and shows the cause rather than the rule documentation', async () => {
    const html = await render(findings).html
    const row = html.slice(html.indexOf(`data-key="strategy.${STRATEGY}"`))
    expect(row.match(/data-reference="([^"]+)"[^>]*>([^<]*)</)?.slice(1)).toEqual([STRATEGY, 'AlphaGrowth Cap USDC'])
    expect(html).toContain('Doesn&#39;t affect listing')
    expect(html).toContain('is deprecated: Deprecated due to low activity.')
    expect(html).not.toContain('0x6fe7fa…0fbc')
    expect(html).not.toContain('Rule documentation for governance.timelock')
    expect(html).toContain('The vault has no curator; its owner holds the curator role.')
  })

  it('asks for the names of the vaults its checks are about', async () => {
    const { html, ensureResolved } = render(findings)
    await html
    expect(ensureResolved).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ key: `strategy.${STRATEGY}.visible` }),
    ]))
  })

  it('shows one row per strategy with its checks inline, the failing one first, then by share of deposits', async () => {
    const html = await render([
      finding(`strategy.${STRATEGY}.recognized`),
      finding(`strategy.${PRIME}.recognized`),
      finding(`strategy.${PRIME}.visible`),
      finding(`strategy.${STRATEGY}.visible`, {
        outcome: 'fail',
        required: false,
        cause: { code: 'dependency-deprecated', subject: STRATEGY, summary: 'Strategy 0x6fe7fa…0fbc is deprecated.', remedy: 'remove-the-dependency' },
      }),
    ]).html
    const rows = [...html.matchAll(/data-id="vault-check-row" data-key="([^"]+)"/g)].map(match => match[1])
    expect(rows).toEqual([`strategy.${STRATEGY}`, `strategy.${PRIME}`])
    const checks = [...html.matchAll(/data-id="vault-check-finding" data-key="([^"]+)" data-tone="([^"]+)"/g)]
      .map(match => `${match[2]}:${match[1]!.split('.').at(-1)}`)
    expect(checks).toEqual(['warning:visible', 'pass:recognized', 'pass:recognized', 'pass:visible'])
    expect(html).toContain('Holds 6% of deposits')
    expect(html).toContain('Holds 94% of deposits')
  })

  it('puts the strategy holding more of the deposits first when both pass, weighing each strategy once', async () => {
    const { html: pending, weighAll } = render([
      finding(`strategy.${STRATEGY}.recognized`),
      finding(`strategy.${PRIME}.recognized`),
      finding(`strategy.${STRATEGY}.visible`),
    ])
    const html = await pending
    const rows = [...html.matchAll(/data-id="vault-check-row" data-key="([^"]+)"/g)].map(match => match[1])
    expect(rows).toEqual([`strategy.${PRIME}`, `strategy.${STRATEGY}`])
    expect(weighAll).toHaveBeenCalledTimes(1)
    expect(weighAll.mock.calls[0]![0]).toHaveLength(2)
  })

  it('colours a row by its most severe check, and tells a screen reader each check\'s outcome', async () => {
    const html = await render([
      finding(`strategy.${STRATEGY}.visible`, { outcome: 'fail', required: false }),
      finding(`strategy.${STRATEGY}.recognized`, { outcome: 'unknown', required: true }),
    ]).html
    expect(html).toMatch(/data-id="vault-check-row"[^>]*>\s*<span[^>]*data-tone="error"/)
    expect(html).toContain('<span class="sr-only">: failed</span>')
    expect(html).toContain('<span class="sr-only">: not checked yet</span>')
  })
})
