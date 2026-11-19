import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import type { PublicEulerLabelsData } from '~/utils/public-labels'
import { __setEulerLabelsDataForTest, useEulerLabels } from '~/composables/useEulerLabels'
import { useVaultAssessmentEvidence } from '~/composables/useVaultAssessmentEvidence'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { useVaults } from '~/composables/useVaults'
import { applyChainReadPolicy, useChainConfig } from '~/composables/useChainConfig'
import {
  EUSDC_42,
  LIQUITY_HUB_ENTITY,
  LIQUITY_HUB_GOVERNOR,
  liquityHubHiddenVerdict,
  makeEusdc42,
} from '~/tests/fixtures/liquity-hub'
import { EUSDC_42_RAW_ASSESSMENT } from '~/tests/fixtures/v3-hidden-vault-assessments'
import { getVaultVerdictKey } from '~/utils/vault-assessment/flagged'

const sdk = vi.hoisted(() => ({ query: vi.fn(), fetch: vi.fn() }))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdk: vi.fn(),
  getEulerSdkFresh: vi.fn(),
  getEulerSdkForChain: async () => ({
    vaultAssessmentService: { queryV3VaultAssessment: sdk.query, fetchVaultAssessment: sdk.fetch },
  }),
}))
vi.mock('~/composables/useV3ChainGate', () => ({
  useV3ChainGate: () => ({ isV3EnabledForChain: () => true }),
}))

const DEPRECATED_GOVERNOR_REASON = 'Governance runs through 0xdd84a2…8b6b, a deprecated governor contract.'
const DEPRECATED_GOVERNOR_RAW = {
  ...EUSDC_42_RAW_ASSESSMENT,
  configStatus: 'unverified',
  configReason: DEPRECATED_GOVERNOR_REASON,
  configContext: {
    ...EUSDC_42_RAW_ASSESSMENT.configContext,
    findings: EUSDC_42_RAW_ASSESSMENT.configContext.findings.map(finding => finding.key === 'governance.no-deprecated-governor'
      ? { ...finding, outcome: 'fail', cause: { code: 'deprecated-governor-contract', subject: LIQUITY_HUB_GOVERNOR.toLowerCase(), summary: DEPRECATED_GOVERNOR_REASON, remedy: 'replace-the-deprecated-governor' } }
      : finding),
  },
}

const setVerdict = (verdict: Record<string, unknown>) => __setEulerLabelsDataForTest({
  source: 'v3',
  entities: { [LIQUITY_HUB_ENTITY]: { name: 'K3 Capital', addresses: { [LIQUITY_HUB_GOVERNOR]: 'K3 governor' } } },
  managingEntityByVault: { [EUSDC_42.toLowerCase()]: LIQUITY_HUB_ENTITY },
  visibility: { [EUSDC_42.toLowerCase()]: verdict },
} as unknown as Partial<PublicEulerLabelsData>)

const isIdentified = () => useVaults().isVaultGovernorIdentified(makeEusdc42())

const scopes: EffectScope[] = []
const trackedScope = () => {
  const scope = effectScope()
  scopes.push(scope)
  return scope
}

describe('governor identity when the labels verdict of a hidden vault changes (eUSDC-42)', () => {
  beforeEach(() => {
    applyChainReadPolicy(1, { deprecated: true, onchain: true, metadataOnly: true })
    applyChainReadPolicy(1, { deprecated: false, onchain: false, metadataOnly: false })
    useChainConfig().unresolvedChainIds = []
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('useChainConfig', () => ({ deprecatedChainIds: [], eVaultFetchChunkChainIds: [] }))
    vi.stubGlobal('useEulerLabels', useEulerLabels)
    vi.stubGlobal('useEulerSdk', () => ({ getEulerSdk: vi.fn(), getEulerSdkForChain: vi.fn() }))
    sdk.query.mockReset()
  })

  afterEach(() => {
    scopes.splice(0).forEach(scope => scope.stop())
    useVaultRegistry().clear()
    vi.unstubAllGlobals()
  })

  it('stops naming the curator at once and re-reads the assessment past the cache', async () => {
    sdk.query.mockResolvedValueOnce(EUSDC_42_RAW_ASSESSMENT).mockResolvedValueOnce(DEPRECATED_GOVERNOR_RAW)
    setVerdict(liquityHubHiddenVerdict('config-suspended'))
    const scope = trackedScope()
    scope.run(() => useVaultAssessmentEvidence(EUSDC_42, 'evk'))

    await vi.waitFor(() => expect(isIdentified()).toBe(true))
    expect(sdk.query).toHaveBeenCalledTimes(1)

    setVerdict({ status: 'hidden', decidedBy: 'config-failed', reason: DEPRECATED_GOVERNOR_REASON, explorableLend: false, explorableBorrow: false })
    expect(isIdentified()).toBe(false)

    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(useEulerLabels().getVaultAssessmentEntry(1, EUSDC_42, 'evk').assessment?.configStatus).toBe('unverified'))
    expect(isIdentified()).toBe(false)
    scope.stop()
  })

  describe('a verdict change while the first read is in flight', () => {
    const deprecatedVerdict = { status: 'hidden', decidedBy: 'config-failed', reason: DEPRECATED_GOVERNOR_REASON, explorableLend: false, explorableBorrow: false }
    const held = () => {
      let release!: (value: unknown) => void
      sdk.query.mockImplementationOnce(() => new Promise((resolve) => {
        release = resolve
      }))
      return (value: unknown) => release(value)
    }

    it.each([
      ['becomes identified once the clear read for the new verdict lands', deprecatedVerdict, DEPRECATED_GOVERNOR_RAW, liquityHubHiddenVerdict('config-suspended'), EUSDC_42_RAW_ASSESSMENT, true],
      ['stays blank once the read for the governance verdict lands', liquityHubHiddenVerdict('config-suspended'), EUSDC_42_RAW_ASSESSMENT, deprecatedVerdict, DEPRECATED_GOVERNOR_RAW, false],
    ])('%s', async (_label, firstVerdict, firstRaw, nextVerdict, nextRaw, identified) => {
      const releaseFirst = held()
      sdk.query.mockResolvedValueOnce(nextRaw)
      setVerdict(firstVerdict)
      const scope = trackedScope()
      scope.run(() => useVaultAssessmentEvidence(EUSDC_42, 'evk'))
      await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))

      setVerdict(nextVerdict)
      expect(isIdentified()).toBe(false)
      releaseFirst(firstRaw)

      await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(useEulerLabels().getVaultAssessmentEntry(1, EUSDC_42, 'evk').verdictKey)
        .toBe(getVaultVerdictKey(nextVerdict)))
      expect(isIdentified()).toBe(identified)
      expect(sdk.query).toHaveBeenCalledTimes(2)
      scope.stop()
    })

    it('keeps blank identity while the joined read for the old verdict settles', async () => {
      const releaseFirst = held()
      const releaseSecond = held()
      setVerdict(deprecatedVerdict)
      const scope = trackedScope()
      scope.run(() => useVaultAssessmentEvidence(EUSDC_42, 'evk'))
      await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))

      setVerdict(liquityHubHiddenVerdict('config-suspended'))
      releaseFirst(EUSDC_42_RAW_ASSESSMENT)
      await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(2))
      expect(isIdentified()).toBe(false)

      releaseSecond(EUSDC_42_RAW_ASSESSMENT)
      await vi.waitFor(() => expect(isIdentified()).toBe(true))
      scope.stop()
    })

    it('still issues one request for concurrent loads under the same verdict', async () => {
      const releaseFirst = held()
      setVerdict(liquityHubHiddenVerdict('config-suspended'))
      const labels = useEulerLabels()
      const loads = [labels.loadVaultAssessment(1, EUSDC_42, 'evk'), labels.loadVaultAssessment(1, EUSDC_42, 'evk'), labels.ensureVaultAssessment(1, EUSDC_42, 'evk')]
      await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))
      releaseFirst(EUSDC_42_RAW_ASSESSMENT)
      await Promise.all(loads)

      expect(sdk.query).toHaveBeenCalledTimes(1)
      expect(isIdentified()).toBe(true)
    })
  })

  it('keeps the assessment while the verdict stays the same across a labels refresh', async () => {
    sdk.query.mockResolvedValue(EUSDC_42_RAW_ASSESSMENT)
    setVerdict(liquityHubHiddenVerdict('config-suspended'))
    const scope = trackedScope()
    scope.run(() => useVaultAssessmentEvidence(EUSDC_42, 'evk'))
    await vi.waitFor(() => expect(isIdentified()).toBe(true))

    setVerdict(liquityHubHiddenVerdict('config-suspended'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(isIdentified()).toBe(true)
    expect(sdk.query).toHaveBeenCalledTimes(1)
    scope.stop()
  })
})
