import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { OracleAdapterUnavailableError } from '@eulerxyz/euler-v2-sdk'

const { fetchOracleAdapterAssessment, fetchOracleAdapterAssessments, isV3EnabledForChain } = vi.hoisted(() => ({
  fetchOracleAdapterAssessment: vi.fn(),
  fetchOracleAdapterAssessments: vi.fn(),
  isV3EnabledForChain: vi.fn(() => true),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkForChain: async () => ({
    oracleAdapterService: {
      fetchOracleAdapterAssessment,
      fetchOracleAdapterAssessments,
    },
  }),
}))

vi.mock('~/composables/useV3ChainGate', () => ({
  useV3ChainGate: () => ({ isV3EnabledForChain }),
}))

const KNOWN_ADAPTER = '0x0000000000000000000000000000000000000001'
const UNLISTED_ADAPTER = '0x0000000000000000000000000000000000000002'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

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
    isV3EnabledForChain.mockReturnValue(true)
  })

  it('loads single V3 assessments lazily and re-enters the SDK on later loads', async () => {
    fetchOracleAdapterAssessment
      .mockResolvedValueOnce(assessment())
      .mockResolvedValueOnce({
        ...assessment(),
        checksStatus: 'negative',
        policyVersion: 4,
      })
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

    const refreshed = await loadOracleAdapter(1, KNOWN_ADAPTER)
    expect(refreshed).toMatchObject({ checksStatus: 'negative', policyVersion: 4 })
    expect(fetchOracleAdapterAssessment).toHaveBeenCalledTimes(2)
  })

  it('does not permanently cache a missing assessment', async () => {
    fetchOracleAdapterAssessment.mockResolvedValue(undefined)
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapter } = useEulerOracleAdapters()

    expect(await loadOracleAdapter(1, UNLISTED_ADAPTER)).toBeUndefined()
    expect(await loadOracleAdapter(1, UNLISTED_ADAPTER)).toBeUndefined()
    expect(fetchOracleAdapterAssessment).toHaveBeenCalledTimes(2)
  })

  it('marks V3-gated chains unavailable without calling the SDK', async () => {
    isV3EnabledForChain.mockReturnValue(false)
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapter, oracleAssessmentsAvailable } = useEulerOracleAdapters()

    await expect(loadOracleAdapter(80094, UNLISTED_ADAPTER)).resolves.toBeUndefined()
    expect(oracleAssessmentsAvailable.value).toBe(false)
    expect(fetchOracleAdapterAssessment).not.toHaveBeenCalled()
  })

  it('keeps the section available when the backend reports a missing adapter', async () => {
    fetchOracleAdapterAssessment.mockResolvedValue(undefined)
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapter, oracleAssessmentsAvailable } = useEulerOracleAdapters()

    await loadOracleAdapter(1, UNLISTED_ADAPTER)
    expect(oracleAssessmentsAvailable.value).toBe(true)
  })

  it.each(['chain-not-supported', 'v3-disabled'] as const)(
    'marks SDK %s responses unavailable',
    async (reason) => {
      fetchOracleAdapterAssessment.mockRejectedValue(
        new OracleAdapterUnavailableError(reason),
      )
      const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
      const { loadOracleAdapter, oracleAssessmentsAvailable } = useEulerOracleAdapters()

      await loadOracleAdapter(80094, UNLISTED_ADAPTER)
      expect(oracleAssessmentsAvailable.value).toBe(false)
    },
  )

  it('marks malformed assessment responses unavailable', async () => {
    fetchOracleAdapterAssessment.mockRejectedValue(new Error('Malformed assessment'))
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapter, oracleAssessmentsAvailable } = useEulerOracleAdapters()

    await loadOracleAdapter(1, UNLISTED_ADAPTER)
    expect(oracleAssessmentsAvailable.value).toBe(false)
  })

  it('removes displayed metadata when a later assessment lookup returns missing', async () => {
    fetchOracleAdapterAssessment
      .mockResolvedValueOnce(assessment())
      .mockResolvedValueOnce(undefined)
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapter, oracleAdapters } = useEulerOracleAdapters()

    await loadOracleAdapter(1, KNOWN_ADAPTER)
    expect(oracleAdapters[KNOWN_ADAPTER]).toBeDefined()

    expect(await loadOracleAdapter(1, KNOWN_ADAPTER)).toBeUndefined()
    expect(oracleAdapters[KNOWN_ADAPTER]).toBeUndefined()
  })

  it('deduplicates concurrent single-assessment loads', async () => {
    const request = deferred<ReturnType<typeof assessment>>()
    fetchOracleAdapterAssessment.mockReturnValue(request.promise)
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapter } = useEulerOracleAdapters()

    const first = loadOracleAdapter(1, KNOWN_ADAPTER)
    const second = loadOracleAdapter(1, KNOWN_ADAPTER)

    await vi.waitFor(() => expect(fetchOracleAdapterAssessment).toHaveBeenCalledTimes(1))
    request.resolve(assessment())
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toBe(secondResult)
  })

  it('re-enters the SDK when the assessment catalogue is loaded again', async () => {
    fetchOracleAdapterAssessments
      .mockResolvedValueOnce([assessment()])
      .mockResolvedValueOnce([{ ...assessment(), provider: 'Pyth' }])
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadAllOracleAdapters, oracleAdapters } = useEulerOracleAdapters()

    await loadAllOracleAdapters(1)
    await loadAllOracleAdapters(1)

    expect(fetchOracleAdapterAssessments).toHaveBeenCalledTimes(2)
    expect(fetchOracleAdapterAssessments).toHaveBeenCalledWith(1, { active: true })
    expect(oracleAdapters[KNOWN_ADAPTER]?.provider).toBe('Pyth')
  })

  it('hides preserved catalogue metadata when a refresh fails', async () => {
    fetchOracleAdapterAssessments
      .mockResolvedValueOnce([assessment()])
      .mockRejectedValueOnce(new Error('Malformed assessment'))
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const {
      loadAllOracleAdapters,
      oracleAdapters,
      oracleAssessmentsAvailable,
    } = useEulerOracleAdapters()

    await loadAllOracleAdapters(1)
    expect(oracleAdapters[KNOWN_ADAPTER]).toBeDefined()

    await loadAllOracleAdapters(1)
    expect(oracleAdapters[KNOWN_ADAPTER]).toBeDefined()
    expect(oracleAssessmentsAvailable.value).toBe(false)
  })

  it('serves single lookups from a fresh catalogue without re-entering the SDK', async () => {
    fetchOracleAdapterAssessments.mockResolvedValueOnce([assessment()])
    fetchOracleAdapterAssessment.mockResolvedValueOnce(assessment(UNLISTED_ADAPTER))
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadAllOracleAdapters, loadOracleAdapter } = useEulerOracleAdapters()

    await loadAllOracleAdapters(1)
    expect(await loadOracleAdapter(1, KNOWN_ADAPTER)).toMatchObject({ provider: 'Chainlink' })
    expect(fetchOracleAdapterAssessment).not.toHaveBeenCalled()

    // The catalogue is filtered to active-route adapters, so a miss still asks the SDK.
    expect(await loadOracleAdapter(1, UNLISTED_ADAPTER)).toMatchObject({ oracle: UNLISTED_ADAPTER })
    expect(fetchOracleAdapterAssessment).toHaveBeenCalledTimes(1)
  })

  it('keeps per-address extras when a later catalogue load replaces the active set', async () => {
    fetchOracleAdapterAssessments
      .mockResolvedValueOnce([assessment()])
      .mockResolvedValueOnce([assessment()])
    fetchOracleAdapterAssessment.mockResolvedValueOnce(assessment(UNLISTED_ADAPTER))
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadAllOracleAdapters, loadOracleAdapter, oracleAdapters } = useEulerOracleAdapters()

    await loadAllOracleAdapters(1)
    expect(await loadOracleAdapter(1, UNLISTED_ADAPTER)).toMatchObject({ oracle: UNLISTED_ADAPTER })

    await loadAllOracleAdapters(1)

    expect(oracleAdapters[KNOWN_ADAPTER]?.provider).toBe('Chainlink')
    expect(oracleAdapters[UNLISTED_ADAPTER]?.oracle).toBe(UNLISTED_ADAPTER)
    expect(fetchOracleAdapterAssessment).toHaveBeenCalledTimes(1)
  })

  it('still re-enters the SDK for a catalogue miss after extras are preserved', async () => {
    fetchOracleAdapterAssessments
      .mockResolvedValueOnce([assessment()])
      .mockResolvedValueOnce([assessment()])
    fetchOracleAdapterAssessment
      .mockResolvedValueOnce(assessment(UNLISTED_ADAPTER))
      .mockResolvedValueOnce({ ...assessment(UNLISTED_ADAPTER), checksStatus: 'negative' })
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadAllOracleAdapters, loadOracleAdapter } = useEulerOracleAdapters()

    await loadAllOracleAdapters(1)
    await loadOracleAdapter(1, UNLISTED_ADAPTER)
    await loadAllOracleAdapters(1)

    expect(await loadOracleAdapter(1, UNLISTED_ADAPTER)).toMatchObject({ checksStatus: 'negative' })
    expect(fetchOracleAdapterAssessment).toHaveBeenCalledTimes(2)
  })

  it('does not apply an assessment for a different chain or adapter', async () => {
    fetchOracleAdapterAssessment
      .mockResolvedValueOnce({ ...assessment(), chainId: 10 })
      .mockResolvedValueOnce({ ...assessment(), address: UNLISTED_ADAPTER })
    fetchOracleAdapterAssessments.mockResolvedValueOnce([{ ...assessment(), chainId: 10 }])
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapter, loadAllOracleAdapters, oracleAdapters } = useEulerOracleAdapters()

    expect(await loadOracleAdapter(1, KNOWN_ADAPTER)).toBeUndefined()
    expect(await loadOracleAdapter(1, KNOWN_ADAPTER)).toBeUndefined()
    await loadAllOracleAdapters(1)

    expect(oracleAdapters[KNOWN_ADAPTER]).toBeUndefined()
    expect(oracleAdapters[UNLISTED_ADAPTER]).toBeUndefined()
  })

  it('resolves concurrent loads to undefined when the SDK request fails', async () => {
    const request = deferred<ReturnType<typeof assessment>>()
    fetchOracleAdapterAssessment.mockReturnValue(request.promise)
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapter } = useEulerOracleAdapters()

    const first = loadOracleAdapter(1, KNOWN_ADAPTER)
    const second = loadOracleAdapter(1, KNOWN_ADAPTER)
    await vi.waitFor(() => expect(fetchOracleAdapterAssessment).toHaveBeenCalledTimes(1))
    request.reject(new Error('upstream failed'))

    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })

  it('keeps the whole section unavailable when any batched adapter request fails', async () => {
    fetchOracleAdapterAssessment
      .mockResolvedValueOnce(assessment())
      .mockRejectedValueOnce(new Error('upstream failed'))
    const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
    const { loadOracleAdapters, oracleAssessmentsAvailable } = useEulerOracleAdapters()

    await loadOracleAdapters(1, [KNOWN_ADAPTER, UNLISTED_ADAPTER])

    expect(oracleAssessmentsAvailable.value).toBe(false)
  })

  it('goes back to the SDK once the catalogue is older than its freshness window', async () => {
    vi.useFakeTimers()
    try {
      fetchOracleAdapterAssessments.mockResolvedValueOnce([assessment()])
      fetchOracleAdapterAssessment.mockResolvedValueOnce({ ...assessment(), checksStatus: 'negative' })
      const { useEulerOracleAdapters } = await import('~/composables/useEulerOracleAdapters')
      const { loadAllOracleAdapters, loadOracleAdapter } = useEulerOracleAdapters()

      await loadAllOracleAdapters(1)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
      expect(await loadOracleAdapter(1, KNOWN_ADAPTER)).toMatchObject({ checksStatus: 'negative' })
      expect(fetchOracleAdapterAssessment).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.useRealTimers()
    }
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
