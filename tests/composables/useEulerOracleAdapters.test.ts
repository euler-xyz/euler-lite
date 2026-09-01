import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'

const { fetchOracleAdapterAssessment, fetchOracleAdapterAssessments } = vi.hoisted(() => ({
  fetchOracleAdapterAssessment: vi.fn(),
  fetchOracleAdapterAssessments: vi.fn(),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdk: async () => ({
    oracleAdapterService: {
      fetchOracleAdapterAssessment,
      fetchOracleAdapterAssessments,
    },
  }),
}))

const KNOWN_ADAPTER = '0x0000000000000000000000000000000000000001'
const UNLISTED_ADAPTER = '0x0000000000000000000000000000000000000002'

const assessment = (address = KNOWN_ADAPTER) => ({
  chainId: 1,
  address,
  recognized: true,
  checksStatus: 'warning',
  reason: null,
  inActiveRoute: true,
  adapterClass: 'ChainlinkOracle',
  label: 'Known',
  provider: 'Chainlink',
  methodology: 'Market Price',
  model: 'Push',
  config: { base: KNOWN_ADAPTER, quote: UNLISTED_ADAPTER },
  findings: [{
    key: 'quote-liveness',
    outcome: 'unknown',
    severity: 'medium',
    description: 'Quote result is inconclusive',
  }],
  summary: { passed: 0, failed: 0, unknown: 1, notApplicable: 0 },
  policyId: 'oracle-adapter-policy',
  policyVersion: 3,
  blockNumber: '123',
  evaluatedAt: '2026-09-01T12:00:00.000Z',
  lastCheckedAt: '2026-09-01T12:01:00.000Z',
})

describe('useEulerOracleAdapters', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('loads single V3 assessments lazily and caches missing addresses', async () => {
    fetchOracleAdapterAssessment
      .mockResolvedValueOnce(assessment())
      .mockResolvedValueOnce(undefined)
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapter } = useEulerOracleAdapters()

    const known = await loadOracleAdapter(1, KNOWN_ADAPTER)
    expect(known).toMatchObject({
      name: 'ChainlinkOracle',
      recognized: true,
      checksStatus: 'warning',
      policyVersion: 3,
    })
    expect(known?.checks[0]?.outcome).toBe('unknown')

    expect(await loadOracleAdapter(1, UNLISTED_ADAPTER)).toBeUndefined()
    expect(await loadOracleAdapter(1, UNLISTED_ADAPTER)).toBeUndefined()
    expect(fetchOracleAdapterAssessment).toHaveBeenCalledTimes(2)
  })

  it('loads the paginated assessment catalogue once per chain', async () => {
    fetchOracleAdapterAssessments.mockResolvedValue([assessment()])
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadAllOracleAdapters, oracleAdapters } = useEulerOracleAdapters()

    await loadAllOracleAdapters(1)
    await loadAllOracleAdapters(1)

    expect(fetchOracleAdapterAssessments).toHaveBeenCalledTimes(1)
    expect(oracleAdapters[KNOWN_ADAPTER]?.provider).toBe('Chainlink')
  })

  it('reloads when the chain changes', async () => {
    fetchOracleAdapterAssessments.mockResolvedValue([])
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadAllOracleAdapters } = useEulerOracleAdapters()

    await loadAllOracleAdapters(1)
    await loadAllOracleAdapters(2)
    expect(fetchOracleAdapterAssessments).toHaveBeenCalledTimes(2)
  })

  it('does not subscribe the calling effect to assessment loads', async () => {
    fetchOracleAdapterAssessments.mockResolvedValue([assessment()])
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')

    let evaluations = 0
    const bystander = computed(() => {
      useEulerOracleAdapters()
      return ++evaluations
    })
    expect(bystander.value).toBe(1)

    await useEulerOracleAdapters().loadAllOracleAdapters(1)
    expect(bystander.value).toBe(1)

    const { oracleAdapters } = useEulerOracleAdapters()
    expect(oracleAdapters[KNOWN_ADAPTER]?.name).toBe('ChainlinkOracle')
  })
})
