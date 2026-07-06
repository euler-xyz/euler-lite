import { beforeEach, describe, expect, it, vi } from 'vitest'

const setupGate = ({
  enableV3Backend,
  onchainSdkChainIds,
}: {
  enableV3Backend: boolean
  onchainSdkChainIds: number[]
}) => {
  vi.stubGlobal('useEnvConfig', () => ({ enableV3Backend }))
  vi.stubGlobal('useChainConfig', () => ({ onchainSdkChainIds }))
}

describe('useV3ChainGate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('disables every chain when no v3 backend is configured', async () => {
    setupGate({ enableV3Backend: false, onchainSdkChainIds: [] })

    const { useV3ChainGate } = await import('~/composables/useV3ChainGate')
    const { isV3EnabledForChain } = useV3ChainGate()

    expect(isV3EnabledForChain(1)).toBe(false)
    expect(isV3EnabledForChain(143)).toBe(false)
  })

  it('disables chains pinned to onchain reads while keeping others on v3', async () => {
    setupGate({ enableV3Backend: true, onchainSdkChainIds: [143] })

    const { useV3ChainGate } = await import('~/composables/useV3ChainGate')
    const { isV3EnabledForChain } = useV3ChainGate()

    expect(isV3EnabledForChain(1)).toBe(true)
    expect(isV3EnabledForChain(143)).toBe(false)
    expect(isV3EnabledForChain('143')).toBe(false)
    expect(isV3EnabledForChain('1')).toBe(true)
  })

  it('rejects missing or malformed chain ids', async () => {
    setupGate({ enableV3Backend: true, onchainSdkChainIds: [] })

    const { useV3ChainGate } = await import('~/composables/useV3ChainGate')
    const { isV3EnabledForChain } = useV3ChainGate()

    expect(isV3EnabledForChain(null)).toBe(false)
    expect(isV3EnabledForChain(undefined)).toBe(false)
    expect(isV3EnabledForChain('')).toBe(false)
    expect(isV3EnabledForChain('not-a-chain')).toBe(false)
    expect(isV3EnabledForChain(0)).toBe(false)
  })
})
