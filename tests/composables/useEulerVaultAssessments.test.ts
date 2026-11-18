import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultAssessmentUnavailableError } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'

const { fetchVaultAssessment, isV3EnabledForChain, service } = vi.hoisted(() => ({
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

  it('keeps the consistency status that the parsed assessment drops', async () => {
    fetchVaultAssessment.mockResolvedValue({ assessed: true })
    const query = vi.fn().mockResolvedValue({ consistencyStatus: 'verified', configStatus: 'suspended' })
    service.queryV3VaultAssessment = query
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    const assessments = useEulerVaultAssessments()
    await assessments.loadVaultAssessment(1, ADDRESS, 'evk')
    expect(query).toHaveBeenCalledWith(1, getAddress(ADDRESS), 'evk')
    expect(assessments.getEntry(1, ADDRESS, 'evk')).toMatchObject({ status: 'available', consistencyStatus: 'verified' })
  })

  it('leaves the consistency status unknown when the raw read is missing or fails', async () => {
    fetchVaultAssessment.mockResolvedValue({ assessed: true })
    const { useEulerVaultAssessments } = await import('~/composables/useEulerVaultAssessments')
    await useEulerVaultAssessments().loadVaultAssessment(1, ADDRESS, 'evk')
    expect(useEulerVaultAssessments().getEntry(1, ADDRESS, 'evk')).toMatchObject({ status: 'available', consistencyStatus: null })

    vi.resetModules()
    service.queryV3VaultAssessment = vi.fn().mockRejectedValue(new Error('503'))
    const reloaded = await import('~/composables/useEulerVaultAssessments')
    await reloaded.useEulerVaultAssessments().loadVaultAssessment(1, ADDRESS, 'evk')
    expect(reloaded.useEulerVaultAssessments().getEntry(1, ADDRESS, 'evk')).toMatchObject({ status: 'available', consistencyStatus: null })
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
