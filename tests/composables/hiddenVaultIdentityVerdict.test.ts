import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import type { PublicEulerLabelsData } from '~/utils/public-labels'
import { __setEulerLabelsDataForTest, useEulerLabels } from '~/composables/useEulerLabels'
import { useVaultAssessmentEvidence } from '~/composables/useVaultAssessmentEvidence'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { useVaults } from '~/composables/useVaults'
import { useChainConfig } from '~/composables/useChainConfig'
import {
  EUSDC_42,
  LIQUITY_HUB_ENTITY,
  LIQUITY_HUB_GOVERNOR,
  liquityHubHiddenVerdict,
  makeEusdc42,
} from '~/tests/fixtures/liquity-hub'
import { EUSDC_42_RAW_ASSESSMENT } from '~/tests/fixtures/v3-hidden-vault-assessments'

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

describe('governor identity when the labels verdict of a hidden vault changes (eUSDC-42)', () => {
  beforeEach(() => {
    useChainConfig().unresolvedChainIds = []
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('useChainConfig', () => ({ deprecatedChainIds: [], eVaultFetchChunkChainIds: [] }))
    vi.stubGlobal('useEulerLabels', useEulerLabels)
    vi.stubGlobal('useEulerSdk', () => ({ getEulerSdk: vi.fn(), getEulerSdkForChain: vi.fn() }))
    sdk.query.mockReset()
  })

  afterEach(() => {
    useVaultRegistry().clear()
    vi.unstubAllGlobals()
  })

  it('stops naming the curator at once and re-reads the assessment past the cache', async () => {
    sdk.query.mockResolvedValueOnce(EUSDC_42_RAW_ASSESSMENT).mockResolvedValueOnce(DEPRECATED_GOVERNOR_RAW)
    setVerdict(liquityHubHiddenVerdict('config-suspended'))
    const scope = effectScope()
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

  it('keeps the assessment while the verdict stays the same across a labels refresh', async () => {
    sdk.query.mockResolvedValue(EUSDC_42_RAW_ASSESSMENT)
    setVerdict(liquityHubHiddenVerdict('config-suspended'))
    const scope = effectScope()
    scope.run(() => useVaultAssessmentEvidence(EUSDC_42, 'evk'))
    await vi.waitFor(() => expect(isIdentified()).toBe(true))

    setVerdict(liquityHubHiddenVerdict('config-suspended'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(isIdentified()).toBe(true)
    expect(sdk.query).toHaveBeenCalledTimes(1)
    scope.stop()
  })
})
