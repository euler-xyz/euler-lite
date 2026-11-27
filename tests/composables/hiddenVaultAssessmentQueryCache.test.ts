import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { VaultAssessmentService } from '@eulerxyz/euler-v2-sdk'
import type { PublicEulerLabelsData } from '~/utils/public-labels'
import {
  EUSDC_42,
  LIQUITY_HUB_ENTITY,
  LIQUITY_HUB_GOVERNOR,
  liquityHubHiddenVerdict,
  makeEusdc42,
} from '~/tests/fixtures/liquity-hub'
import {
  EUSDC_42_DEPRECATED_GOVERNOR_RAW_ASSESSMENT,
  EUSDC_42_DEPRECATED_GOVERNOR_VERDICT,
  EUSDC_42_RAW_ASSESSMENT,
} from '~/tests/fixtures/v3-hidden-vault-assessments'
import { getVaultVerdictKey } from '~/utils/vault-assessment/flagged'

const sdk = vi.hoisted(() => ({ service: undefined as unknown }))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdk: vi.fn(),
  getEulerSdkFresh: vi.fn(),
  getEulerSdkForChain: async () => ({ vaultAssessmentService: sdk.service }),
}))
vi.mock('~/composables/useV3ChainGate', () => ({
  useV3ChainGate: () => ({ isV3EnabledForChain: () => true }),
}))

const CLEAR_VERDICT = liquityHubHiddenVerdict('config-suspended')
const VISIBLE_VERDICT = { status: 'visible', decidedBy: 'verified', reason: null, explorableLend: true, explorableBorrow: true }

const upstream = vi.fn<(url: string) => Promise<Response>>()
const respond = (body: unknown) => Response.json({ data: body })
const serve = (body: unknown) => upstream.mockImplementationOnce(async () => respond(body))
const hold = () => {
  let release: ((body: unknown) => void) | undefined
  upstream.mockImplementationOnce(() => new Promise((resolve) => {
    release = body => resolve(respond(body))
  }))
  return (body: unknown) => release?.(body)
}

const scopes: EffectScope[] = []

const setup = async () => {
  vi.resetModules()
  const { sdkBuildQuery } = await import('~/utils/sdk-query-cache')
  const { __setEulerLabelsDataForTest, useEulerLabels } = await import('~/composables/useEulerLabels')
  const { __clearVaultAssessmentEntriesForTest } = await import('~/composables/useEulerVaultAssessments')
  const { useVaultAssessmentEvidence } = await import('~/composables/useVaultAssessmentEvidence')
  const { useVaults } = await import('~/composables/useVaults')
  vi.stubGlobal('useEulerLabels', useEulerLabels)
  const service = new VaultAssessmentService({ endpoint: 'https://v3.test' }, sdkBuildQuery)
  sdk.service = service
  return {
    service,
    query: vi.spyOn(service, 'queryV3VaultAssessment'),
    clearEntries: __clearVaultAssessmentEntriesForTest,
    setVerdict: (verdict: Record<string, unknown>) => __setEulerLabelsDataForTest({
      source: 'v3',
      entities: { [LIQUITY_HUB_ENTITY]: { name: 'K3 Capital', addresses: { [LIQUITY_HUB_GOVERNOR]: 'K3 governor' } } },
      managingEntityByVault: { [EUSDC_42.toLowerCase()]: LIQUITY_HUB_ENTITY },
      visibility: { [EUSDC_42.toLowerCase()]: verdict },
    } as unknown as Partial<PublicEulerLabelsData>),
    mount: () => {
      const scope = effectScope()
      scopes.push(scope)
      scope.run(() => useVaultAssessmentEvidence(EUSDC_42, 'evk'))
      return scope
    },
    entry: () => useEulerLabels().getVaultAssessmentEntry(1, EUSDC_42, 'evk'),
    isIdentified: () => useVaults().isVaultGovernorIdentified(makeEusdc42()),
  }
}

describe('hidden vault assessments behind the SDK query cache (eUSDC-42)', () => {
  beforeEach(() => {
    upstream.mockReset()
    vi.stubGlobal('fetch', upstream)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('useChainConfig', () => ({ deprecatedChainIds: [], eVaultFetchChunkChainIds: [] }))
    vi.stubGlobal('useEulerSdk', () => ({ getEulerSdk: vi.fn(), getEulerSdkForChain: vi.fn() }))
  })

  afterEach(() => {
    scopes.splice(0).forEach(scope => scope.stop())
    vi.unstubAllGlobals()
  })

  describe.each([
    ['with the stored entry kept', false],
    ['with the stored entry cleared', true],
  ])('a governance verdict that arrives while unmounted, %s', (_label, clearEntries) => {
    it('reads upstream again and never names the curator from the cached clear body', async () => {
      const t = await setup()
      serve(EUSDC_42_RAW_ASSESSMENT)
      t.setVerdict(CLEAR_VERDICT)
      const first = t.mount()
      await vi.waitFor(() => expect(t.isIdentified()).toBe(true))
      expect(upstream).toHaveBeenCalledTimes(1)
      first.stop()

      t.setVerdict(EUSDC_42_DEPRECATED_GOVERNOR_VERDICT)
      if (clearEntries) t.clearEntries()
      expect(t.isIdentified()).toBe(false)
      const release = hold()
      t.mount()
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2))
      expect(t.isIdentified()).toBe(false)

      release(EUSDC_42_DEPRECATED_GOVERNOR_RAW_ASSESSMENT)
      await vi.waitFor(() => expect(t.entry()).toMatchObject({
        status: 'available',
        verdictKey: getVaultVerdictKey(EUSDC_42_DEPRECATED_GOVERNOR_VERDICT),
        assessment: { configStatus: 'unverified' },
      }))
      expect(t.isIdentified()).toBe(false)
      expect(upstream).toHaveBeenCalledTimes(2)
    })
  })

  it('names the curator after a governance verdict clears only once the upstream read lands', async () => {
    const t = await setup()
    serve(EUSDC_42_DEPRECATED_GOVERNOR_RAW_ASSESSMENT)
    t.setVerdict(EUSDC_42_DEPRECATED_GOVERNOR_VERDICT)
    const first = t.mount()
    await vi.waitFor(() => expect(t.entry()).toMatchObject({ status: 'available', assessment: { configStatus: 'unverified' } }))
    expect(t.isIdentified()).toBe(false)
    first.stop()

    t.setVerdict(CLEAR_VERDICT)
    const release = hold()
    t.mount()
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2))
    expect(t.isIdentified()).toBe(false)

    release(EUSDC_42_RAW_ASSESSMENT)
    await vi.waitFor(() => expect(t.isIdentified()).toBe(true))
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('reads upstream again when a hidden verdict returns after a visible one', async () => {
    const t = await setup()
    serve(EUSDC_42_RAW_ASSESSMENT)
    t.setVerdict(EUSDC_42_DEPRECATED_GOVERNOR_VERDICT)
    const first = t.mount()
    await vi.waitFor(() => expect(t.entry().status).toBe('available'))
    first.stop()

    t.setVerdict(VISIBLE_VERDICT)
    const second = t.mount()
    await vi.waitFor(() => expect(t.entry().verdictKey).toBe(getVaultVerdictKey(VISIBLE_VERDICT)))
    second.stop()

    t.setVerdict(EUSDC_42_DEPRECATED_GOVERNOR_VERDICT)
    const release = hold()
    t.mount()
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2))
    expect(t.isIdentified()).toBe(false)
    release(EUSDC_42_DEPRECATED_GOVERNOR_RAW_ASSESSMENT)
    await vi.waitFor(() => expect(t.entry().verdictKey).toBe(getVaultVerdictKey(EUSDC_42_DEPRECATED_GOVERNOR_VERDICT)))
    expect(t.isIdentified()).toBe(false)
  })

  it('serves a remount under the same verdict from the query cache', async () => {
    const t = await setup()
    serve(EUSDC_42_RAW_ASSESSMENT)
    t.setVerdict(CLEAR_VERDICT)
    const first = t.mount()
    await vi.waitFor(() => expect(t.isIdentified()).toBe(true))
    first.stop()

    t.setVerdict(liquityHubHiddenVerdict('config-suspended'))
    t.mount()
    await vi.waitFor(() => expect(t.query).toHaveBeenCalledTimes(2))
    await t.query.mock.results[1]?.value

    expect(t.isIdentified()).toBe(true)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['answers a visible vault from a body already in the cache', VISIBLE_VERDICT, 1],
    ['reads a hidden vault upstream when no read under its verdict is known', CLEAR_VERDICT, 2],
  ])('%s', async (_label, verdict, upstreamReads) => {
    const t = await setup()
    serve(EUSDC_42_RAW_ASSESSMENT)
    serve(EUSDC_42_RAW_ASSESSMENT)
    await t.service.queryV3VaultAssessment(1, EUSDC_42, 'evk')

    t.setVerdict(verdict)
    t.mount()
    await vi.waitFor(() => expect(t.entry()).toMatchObject({ status: 'available', verdictKey: getVaultVerdictKey(verdict) }))
    expect(upstream).toHaveBeenCalledTimes(upstreamReads)
  })
})
