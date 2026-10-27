import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const INTERVAL = 60_000
const VAULT = '0x00000000000000000000000000000000000000aa'

const loadVaultAssessment = vi.fn()

describe('useVaultAssessmentWarning', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    loadVaultAssessment.mockReset()
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('onMounted', (fn: () => void) => fn())
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => true }))
    vi.stubGlobal('useEulerLabels', () => ({
      isReady: ref(true),
      source: ref('v3'),
      vaultAssessments: ref({}),
      getVaultAssessmentEntry: () => ({ status: 'idle' }),
      loadVaultAssessment,
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const mount = async () => {
    const { useVaultAssessmentWarning } = await import('~/composables/useVaultAssessmentWarning')
    const scope = effectScope()
    scope.run(() => useVaultAssessmentWarning(VAULT, 'evk'))
    return scope
  }

  it('re-reads the shown vault assessment in the background on each visible tick', async () => {
    const scope = await mount()
    expect(loadVaultAssessment).toHaveBeenCalledWith(1, VAULT, 'evk')

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(loadVaultAssessment).toHaveBeenCalledTimes(2)
    expect(loadVaultAssessment).toHaveBeenLastCalledWith(1, VAULT, 'evk', { background: true })
    scope.stop()
  })

  it('stops re-reading when the page goes away', async () => {
    const scope = await mount()
    scope.stop()

    await vi.advanceTimersByTimeAsync(3 * INTERVAL)

    expect(loadVaultAssessment).toHaveBeenCalledTimes(1)
  })
})
