import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { getAddress } from 'viem'
import type { AnyVault } from '~/composables/useVaultRegistry'

const labels = vi.hoisted(() => ({
  getVaultAssessmentEntry: vi.fn(() => ({ status: 'idle' })),
  ensureVaultAssessment: vi.fn(),
}))

vi.mock('~/composables/useEulerLabels', () => ({
  useEulerLabels: () => ({
    isReady: ref(true),
    source: ref('v3'),
    vaultAssessments: ref({}),
    getVaultAssessmentEntry: labels.getVaultAssessmentEntry,
    ensureVaultAssessment: labels.ensureVaultAssessment,
  }),
}))
vi.mock('~/composables/useVaultReferences', () => ({ useVaultReferences: () => ({ describe: () => ({ label: '' }) }) }))

const SECURITIZE = getAddress('0x1cFC56665c2718454e8dDf975dC37aF0bc68B5aA')

afterEach(() => vi.clearAllMocks())

describe('discovery warning details', () => {
  it('loads a Securitize vault\'s assessment on the EVK route, which serves its policy', async () => {
    const { useDiscoveryVaultWarningDetails } = await import('~/composables/useDiscoveryVaultWarningDetails')
    const securitize = { type: 'SecuritizeCollateral', chainId: 1, address: SECURITIZE } as unknown as AnyVault

    useDiscoveryVaultWarningDetails().loadWarningDetails(securitize)

    expect(labels.ensureVaultAssessment).toHaveBeenCalledWith(1, SECURITIZE, 'evk')
  })
})
