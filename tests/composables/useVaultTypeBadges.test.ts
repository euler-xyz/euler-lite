import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { zeroAddress } from 'viem'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'
import type { Vault } from '~/entities/vault'
import { useVaultTypeBadges } from '~/composables/useVaultTypeBadges'

const state = vi.hoisted(() => ({
  accessControlVaults: new Set<string>(),
  earnOwners: new Set<string>(),
  entityGovernors: new Set<string>(),
  governanceLimitedVaults: new Set<string>(),
  keyringVaults: new Set<string>(),
  verifiedEarnVaults: new Set<string>(),
  verifiedVaults: new Set<string>(),
}))

vi.mock('~/composables/useEulerLabels', () => ({
  useEulerProductOfVault: (addressRef: { value?: string } | string) => ({
    get isGovernanceLimited() {
      const address = typeof addressRef === 'string' ? addressRef : addressRef.value
      return !!address && state.governanceLimitedVaults.has(address.toLowerCase())
    },
  }),
}))

vi.mock('~/utils/eulerLabelsUtils', () => ({
  getEntitiesByEarnVault: (vault: { owner?: string }) =>
    vault.owner && state.earnOwners.has(vault.owner.toLowerCase()) ? [{}] : [],
  getEntitiesByVault: (vault: { governorAdmin?: string }) =>
    vault.governorAdmin && state.entityGovernors.has(vault.governorAdmin.toLowerCase()) ? [{}] : [],
  isVaultKeyring: (address: string) => state.keyringVaults.has(address.toLowerCase()),
  isVaultAccessControlled: (address: string) => state.accessControlVaults.has(address.toLowerCase()),
}))

const verifiedGovernor = '0x1000000000000000000000000000000000000001'

const makeVault = (overrides: Partial<Vault> = {}): Vault => ({
  address: '0x2000000000000000000000000000000000000002',
  asset: {
    address: '0x3000000000000000000000000000000000000003',
    decimals: 18n,
    name: 'Wrapped Ether',
    symbol: 'WETH',
  },
  governorAdmin: verifiedGovernor,
  irmInfo: {
    interestRateModelInfo: {
      interestRateModelType: INTEREST_RATE_MODEL_TYPE.KINK,
    },
  },
  verified: true,
  ...overrides,
} as Vault)

const setupVaultsMock = () => {
  ;(globalThis as unknown as { useVaults: unknown }).useVaults = () => ({
    isEarnVaultOwnerVerified: (vault: { address: string }) =>
      state.verifiedEarnVaults.has(vault.address.toLowerCase()),
    isVaultGovernorVerified: (vault: { address: string }) =>
      state.verifiedVaults.has(vault.address.toLowerCase()),
  })
}

const verify = (vault: Vault) => {
  state.verifiedVaults.add(vault.address.toLowerCase())
  if (vault.governorAdmin) state.entityGovernors.add(vault.governorAdmin.toLowerCase())
}

describe('useVaultTypeBadges', () => {
  beforeEach(() => {
    state.accessControlVaults.clear()
    state.earnOwners.clear()
    state.entityGovernors.clear()
    state.governanceLimitedVaults.clear()
    state.keyringVaults.clear()
    state.verifiedEarnVaults.clear()
    state.verifiedVaults.clear()
    setupVaultsMock()
  })

  it('does not include ordinary governance badges in the summary', () => {
    const vault = makeVault()
    verify(vault)

    const { badges, governanceType, hasSummaryBadges, summaryBadges } = useVaultTypeBadges(ref(vault))

    expect(governanceType.value).toBe('governed')
    expect(badges.value).toEqual(['governed'])
    expect(summaryBadges.value).toEqual([])
    expect(hasSummaryBadges.value).toBe(false)
  })

  it('summarizes verified keyring vaults as private', () => {
    const vault = makeVault()
    verify(vault)
    state.keyringVaults.add(vault.address.toLowerCase())

    const { badges, hasSummaryBadges, summaryBadges } = useVaultTypeBadges(ref(vault))

    expect(badges.value).toEqual(['governed', 'private'])
    expect(summaryBadges.value).toEqual(['private'])
    expect(hasSummaryBadges.value).toBe(true)
  })

  it('summarizes verified access-controlled vaults as accessControl', () => {
    const vault = makeVault()
    verify(vault)
    state.accessControlVaults.add(vault.address.toLowerCase())

    const { badges, hasSummaryBadges, summaryBadges } = useVaultTypeBadges(ref(vault))

    expect(badges.value).toEqual(['governed', 'accessControl'])
    expect(summaryBadges.value).toEqual(['accessControl'])
    expect(hasSummaryBadges.value).toBe(true)
  })

  it.each([
    INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY,
    INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY_MONTHLY,
  ])('summarizes verified cyclical IRM type %s as cyclical note', (interestRateModelType) => {
    const vault = makeVault({
      irmInfo: {
        interestRateModelInfo: { interestRateModelType },
      },
    })
    verify(vault)

    const { badges, summaryBadges } = useVaultTypeBadges(ref(vault))

    expect(badges.value).toEqual(['governed', 'cyclicalNote'])
    expect(summaryBadges.value).toEqual(['cyclicalNote'])
  })

  it('does not treat KINKY IRM as cyclical note', () => {
    const vault = makeVault({
      irmInfo: {
        interestRateModelInfo: { interestRateModelType: INTEREST_RATE_MODEL_TYPE.KINKY },
      },
    })
    verify(vault)

    const { badges, summaryBadges } = useVaultTypeBadges(ref(vault))

    expect(badges.value).toEqual(['governed'])
    expect(summaryBadges.value).toEqual([])
  })

  it('summarizes unverified or unrecognized vaults as unknown only', () => {
    const vault = makeVault({
      irmInfo: {
        interestRateModelInfo: {
          interestRateModelType: INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY,
        },
      },
      verified: false,
    })

    const { badges, governanceType, summaryBadges } = useVaultTypeBadges(ref(vault))

    expect(governanceType.value).toBe('unknown')
    expect(badges.value).toEqual(['unknown'])
    expect(summaryBadges.value).toEqual(['unknown'])
  })

  it('renders failed verification as unknown even when the governor has a label entity', () => {
    const vault = makeVault({
      irmInfo: {
        interestRateModelInfo: {
          interestRateModelType: INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY,
        },
      },
      verified: false,
    })
    state.entityGovernors.add(vault.governorAdmin.toLowerCase())

    const { badges, governanceType, summaryBadges, summaryGovernanceType } = useVaultTypeBadges(ref(vault))

    expect(governanceType.value).toBe('governed')
    expect(badges.value).toEqual(['governed'])
    expect(summaryBadges.value).toEqual(['unknown'])
    expect(summaryGovernanceType.value).toBe('unknown')
  })

  it('keeps ungoverned and governance-limited badges out of the pair summary', () => {
    const vault = makeVault({
      address: '0x4000000000000000000000000000000000000004',
      governorAdmin: zeroAddress,
    })
    state.verifiedVaults.add(vault.address.toLowerCase())
    state.governanceLimitedVaults.add(vault.address.toLowerCase())

    const { badges, governanceType, hasSummaryBadges, summaryBadges } = useVaultTypeBadges(ref(vault))

    expect(governanceType.value).toBe('ungoverned')
    expect(badges.value).toEqual(['ungoverned', 'governanceLimited'])
    expect(summaryBadges.value).toEqual([])
    expect(hasSummaryBadges.value).toBe(false)
  })
})
