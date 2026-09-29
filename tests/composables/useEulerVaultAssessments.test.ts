import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultAssessmentUnavailableError } from '@eulerxyz/euler-v2-sdk'

const { fetchVaultAssessment, isV3EnabledForChain } = vi.hoisted(() => ({
  fetchVaultAssessment: vi.fn(),
  isV3EnabledForChain: vi.fn(() => true),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkForChain: async () => ({ vaultAssessmentService: { fetchVaultAssessment } }),
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
})
