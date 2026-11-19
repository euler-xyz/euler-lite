import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultAssessmentUnavailableError } from '@eulerxyz/euler-v2-sdk'
import { EUSDC_42 } from '~/tests/fixtures/liquity-hub'
import { EUSDC_42_RAW_ASSESSMENT } from '~/tests/fixtures/v3-hidden-vault-assessments'

const { advanceSdkQueryGeneration, fetchVaultAssessment, isV3EnabledForChain, service } = vi.hoisted(() => ({
  advanceSdkQueryGeneration: vi.fn(),
  fetchVaultAssessment: vi.fn(),
  isV3EnabledForChain: vi.fn(() => true),
  service: { queryV3VaultAssessment: undefined as undefined | ((...args: unknown[]) => Promise<unknown>) },
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkForChain: async () => ({
    vaultAssessmentService: service.queryV3VaultAssessment
      ? { fetchVaultAssessment, queryV3VaultAssessment: service.queryV3VaultAssessment }
      : { fetchVaultAssessment },
  }),
}))
vi.mock('~/utils/sdk-query-cache', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/sdk-query-cache')>()),
  advanceSdkQueryGeneration,
}))
vi.mock('~/composables/useV3ChainGate', () => ({
  useV3ChainGate: () => ({ isV3EnabledForChain }),
}))

const ADDRESS = '0x00000000000000000000000000000000000000aa'

describe('useEulerVaultAssessments', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    isV3EnabledForChain.mockReturnValue(true)
    service.queryV3VaultAssessment = undefined
  })

  it('parses the assessment and its consistency status from one raw read', async () => {
    const query = vi.fn().mockResolvedValue(EUSDC_42_RAW_ASSESSMENT)
    service.queryV3VaultAssessment = query
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    const assessments = useEulerVaultAssessments()
    await assessments.loadVaultAssessment(1, EUSDC_42, 'evk')
    expect(query).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledWith(1, EUSDC_42, 'evk')
    expect(fetchVaultAssessment).not.toHaveBeenCalled()
    expect(advanceSdkQueryGeneration).not.toHaveBeenCalled()
    expect(assessments.getEntry(1, EUSDC_42, 'evk')).toMatchObject({
      status: 'available',
      consistencyStatus: 'verified',
      assessment: { configStatus: 'suspended', vaultAddress: EUSDC_42 },
    })
  })

  it('reads a fresh raw body after the user\'s own transaction, still in one read', async () => {
    const before = { ...EUSDC_42_RAW_ASSESSMENT, configStatus: 'verified', consistencyStatus: 'verified' }
    const after = { ...EUSDC_42_RAW_ASSESSMENT, configStatus: 'suspended', consistencyStatus: 'suspended' }
    const query = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    service.queryV3VaultAssessment = query
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    const assessments = useEulerVaultAssessments()
    await assessments.loadVaultAssessment(1, EUSDC_42, 'evk')
    await assessments.loadVaultAssessment(1, EUSDC_42, 'evk', { fresh: true })
    expect(advanceSdkQueryGeneration).toHaveBeenCalledWith(['queryV3VaultAssessment'])
    expect(query).toHaveBeenCalledTimes(2)
    expect(fetchVaultAssessment).not.toHaveBeenCalled()
    expect(assessments.getEntry(1, EUSDC_42, 'evk')).toMatchObject({
      consistencyStatus: 'suspended',
      assessment: { configStatus: 'suspended' },
    })
  })

  it('reads again after joining a request made under another verdict, unless that verdict is back', async () => {
    let release!: (value: unknown) => void
    const query = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        release = resolve
      }))
      .mockResolvedValue(EUSDC_42_RAW_ASSESSMENT)
    service.queryV3VaultAssessment = query
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    const assessments = useEulerVaultAssessments()
    let verdict = 'paused'
    const getVerdictKey = () => verdict

    const first = assessments.loadVaultAssessment(1, EUSDC_42, 'evk', { getVerdictKey })
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce())
    const sameVerdict = assessments.loadVaultAssessment(1, EUSDC_42, 'evk', { getVerdictKey })
    verdict = 'deprecated-governor'
    const joined = assessments.loadVaultAssessment(1, EUSDC_42, 'evk', { getVerdictKey })
    release(EUSDC_42_RAW_ASSESSMENT)
    await Promise.all([first, sameVerdict, joined])

    expect(query).toHaveBeenCalledTimes(2)
    expect(advanceSdkQueryGeneration).toHaveBeenCalledWith(['queryV3VaultAssessment'])
    expect(assessments.getEntry(1, EUSDC_42, 'evk').verdictKey).toBe('deprecated-governor')
  })

  it('does not read again when the verdict returns before the joined request settles', async () => {
    let release!: (value: unknown) => void
    const query = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
    }))
    service.queryV3VaultAssessment = query
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    const assessments = useEulerVaultAssessments()
    let verdict = 'paused'
    const getVerdictKey = () => verdict

    const first = assessments.loadVaultAssessment(1, EUSDC_42, 'evk', { getVerdictKey })
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce())
    verdict = 'deprecated-governor'
    const joined = assessments.loadVaultAssessment(1, EUSDC_42, 'evk', { getVerdictKey })
    verdict = 'paused'
    release(EUSDC_42_RAW_ASSESSMENT)
    await Promise.all([first, joined])

    expect(query).toHaveBeenCalledOnce()
    expect(assessments.getEntry(1, EUSDC_42, 'evk').verdictKey).toBe('paused')
  })

  it('leaves the consistency status unknown when the service has no raw read', async () => {
    fetchVaultAssessment.mockResolvedValue({ assessed: true })
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    await useEulerVaultAssessments().loadVaultAssessment(1, ADDRESS, 'evk')
    expect(useEulerVaultAssessments().getEntry(1, ADDRESS, 'evk')).toMatchObject({ status: 'available', consistencyStatus: null })
  })

  it('marks the entry unavailable when the raw body does not parse', async () => {
    service.queryV3VaultAssessment = vi.fn().mockResolvedValue({ ...EUSDC_42_RAW_ASSESSMENT, configStatus: 'nonsense' })
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    await useEulerVaultAssessments().loadVaultAssessment(1, EUSDC_42, 'evk')
    expect(useEulerVaultAssessments().getEntry(1, EUSDC_42, 'evk').status).toBe('unavailable')
  })

  it('drops pending assessments and unsupported-chain caches across policy changes', async () => {
    const { useChainConfig, applyChainReadPolicy } = await import('~/composables/useChainConfig')
    useChainConfig().enabledChainIds.push(1)
    let finish!: (value: unknown) => void
    fetchVaultAssessment.mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    const assessments = useEulerVaultAssessments()
    const pending = assessments.loadVaultAssessment(1, ADDRESS, 'evk')
    await vi.waitFor(() => expect(fetchVaultAssessment).toHaveBeenCalledOnce())
    applyChainReadPolicy(1, { deprecated: true, onchain: true, metadataOnly: true })
    applyChainReadPolicy(1, { deprecated: false, onchain: false, metadataOnly: false })
    finish({ assessed: true })
    await pending
    expect(assessments.getEntry(1, ADDRESS, 'evk').status).toBe('idle')
    fetchVaultAssessment.mockRejectedValue(new VaultAssessmentUnavailableError('chain-not-supported'))
    await assessments.loadVaultAssessment(1, ADDRESS, 'evk')
    expect(assessments.isAvailableForChain(1)).toBe(false)
    applyChainReadPolicy(1, { deprecated: true, onchain: true, metadataOnly: true })
    applyChainReadPolicy(1, { deprecated: false, onchain: false, metadataOnly: false })
    expect(assessments.isAvailableForChain(1)).toBe(true)
  })

  it('deduplicates requests and keeps entries by chain, family and lowercase address', async () => {
    fetchVaultAssessment.mockResolvedValue({ assessed: true })
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    const service = useEulerVaultAssessments()
    const [first, second] = await Promise.all([
      service.loadVaultAssessment(1, ADDRESS, 'evk'),
      service.loadVaultAssessment(1, ADDRESS.toUpperCase().replace('0X', '0x'), 'evk'),
    ])
    expect(first).toEqual(second)
    expect(fetchVaultAssessment).toHaveBeenCalledTimes(1)
    expect(service.getEntry(1, ADDRESS, 'evk').status).toBe('available')
    expect(service.getEntry(1, ADDRESS, 'earn').status).toBe('idle')
    expect(service.getEntry(2, ADDRESS, 'evk').status).toBe('idle')
  })

  it('hides chains that V3 does not serve', async () => {
    fetchVaultAssessment.mockRejectedValue(new VaultAssessmentUnavailableError('chain-not-supported'))
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    const service = useEulerVaultAssessments()
    expect(service.isAvailableForChain(1)).toBe(true)
    await service.loadVaultAssessment(1, ADDRESS, 'evk')
    expect(service.isAvailableForChain(1)).toBe(false)
    await service.loadVaultAssessment(1, ADDRESS, 'earn')
    expect(fetchVaultAssessment).toHaveBeenCalledTimes(1)
  })

  it('does not load a locally gated chain', async () => {
    isV3EnabledForChain.mockReturnValue(false)
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    const service = useEulerVaultAssessments()
    expect(await service.loadVaultAssessment(1, ADDRESS, 'evk')).toEqual({ status: 'idle' })
    expect(fetchVaultAssessment).not.toHaveBeenCalled()
  })

  it('keeps the selected chain reactive while an old-chain transaction poll runs', async () => {
    vi.useFakeTimers()
    try {
      let resolveB!: (assessment: { assessed: boolean }) => void
      fetchVaultAssessment.mockImplementation((chainId: number) => chainId === 2
        ? new Promise((resolve) => { resolveB = resolve })
        : Promise.resolve({ assessed: true }))
      const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
      const service = useEulerVaultAssessments()
      await service.loadVaultAssessment(1, ADDRESS, 'evk')
      const loadingB = service.loadVaultAssessment(2, ADDRESS, 'evk')
      expect(service.activeChainId.value).toBe(2)
      expect(Object.values(service.entries.value)[0]?.status).toBe('loading')

      service.refreshAfterOwnTransaction(1, ADDRESS, 'evk')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(service.activeChainId.value).toBe(2)

      resolveB({ assessed: true })
      await loadingB
      expect(Object.values(service.entries.value)[0]?.status).toBe('available')
      await vi.advanceTimersByTimeAsync(120_000)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
