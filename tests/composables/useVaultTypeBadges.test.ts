import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import { zeroAddress } from 'viem'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { useVaultTypeBadges } from '~/composables/useVaultTypeBadges'

const state = vi.hoisted(() => ({
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
}))

vi.mock('~/composables/useVaultRegistry', () => ({
  useVaultRegistry: () => ({
    getVaultCategory: () => 'evk',
    isVerifiedVault: (address: string) => state.verifiedVaults.has(address.toLowerCase()),
  }),
}))

const verifiedGovernor = '0x1000000000000000000000000000000000000001'

const makeInterestRateModel = (type: typeof INTEREST_RATE_MODEL_TYPE[keyof typeof INTEREST_RATE_MODEL_TYPE]): EVault['interestRateModel'] => ({
  address: '0x9000000000000000000000000000000000000009',
  type,
  data: null,
  params: null,
} as unknown as EVault['interestRateModel'])

const makeVault = (overrides: Partial<EVault> & { verified?: boolean } = {}): EVault => ({
  type: 'EVault',
  address: '0x2000000000000000000000000000000000000002',
  asset: {
    address: '0x3000000000000000000000000000000000000003',
    decimals: 18n,
    name: 'Wrapped Ether',
    symbol: 'WETH',
  },
  governorAdmin: verifiedGovernor,
  interestRateModel: makeInterestRateModel(INTEREST_RATE_MODEL_TYPE.KINK),
  verified: true,
  ...overrides,
} as unknown as EVault)

const setupVaultsMock = () => {
  ;(globalThis as unknown as { useVaults: unknown }).useVaults = () => ({
    isEarnVaultOwnerVerified: (vault: { address: string }) =>
      state.verifiedEarnVaults.has(vault.address.toLowerCase()),
    isVaultGovernorVerified: (vault: { address: string }) =>
      state.verifiedVaults.has(vault.address.toLowerCase()),
  })
}

const verify = (vault: EVault) => {
  state.verifiedVaults.add(vault.address.toLowerCase())
  if (vault.governorAdmin) state.entityGovernors.add(vault.governorAdmin.toLowerCase())
}

describe('useVaultTypeBadges', () => {
  beforeEach(() => {
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

    const { badges, governanceType, hasSummaryBadges, summaryBadges } = useVaultTypeBadges(shallowRef(vault))

    expect(governanceType.value).toBe('governed')
    expect(badges.value).toEqual(['governed'])
    expect(summaryBadges.value).toEqual([])
    expect(hasSummaryBadges.value).toBe(false)
  })

  it('summarizes verified keyring vaults as private', () => {
    const vault = makeVault()
    verify(vault)
    state.keyringVaults.add(vault.address.toLowerCase())

    const { badges, hasSummaryBadges, summaryBadges } = useVaultTypeBadges(shallowRef(vault))

    expect(badges.value).toEqual(['governed', 'private'])
    expect(summaryBadges.value).toEqual(['private'])
    expect(hasSummaryBadges.value).toBe(true)
  })

  it.each([
    INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY,
    INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY_MONTHLY,
  ])('summarizes verified cyclical IRM type %s as cyclical note', (interestRateModelType) => {
    const vault = makeVault({
      interestRateModel: makeInterestRateModel(interestRateModelType),
    })
    verify(vault)

    const { badges, summaryBadges } = useVaultTypeBadges(shallowRef(vault))

    expect(badges.value).toEqual(['governed', 'cyclicalNote'])
    expect(summaryBadges.value).toEqual(['cyclicalNote'])
  })

  it('does not treat KINKY IRM as cyclical note', () => {
    const vault = makeVault({
      interestRateModel: makeInterestRateModel(INTEREST_RATE_MODEL_TYPE.KINKY),
    })
    verify(vault)

    const { badges, summaryBadges } = useVaultTypeBadges(shallowRef(vault))

    expect(badges.value).toEqual(['governed'])
    expect(summaryBadges.value).toEqual([])
  })

  it('summarizes unverified or unrecognized vaults as unknown only', () => {
    const vault = makeVault({
      interestRateModel: makeInterestRateModel(INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY),
      verified: false,
    })

    const { badges, governanceType, summaryBadges } = useVaultTypeBadges(shallowRef(vault))

    expect(governanceType.value).toBe('unknown')
    expect(badges.value).toEqual(['unknown'])
    expect(summaryBadges.value).toEqual(['unknown'])
  })

  it('renders failed verification as unknown even when the governor has a label entity', () => {
    const vault = makeVault({
      interestRateModel: makeInterestRateModel(INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY),
      verified: false,
    })
    state.entityGovernors.add(vault.governorAdmin.toLowerCase())

    const { badges, governanceType, summaryBadges, summaryGovernanceType } = useVaultTypeBadges(shallowRef(vault))

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

    const { badges, governanceType, hasSummaryBadges, summaryBadges } = useVaultTypeBadges(shallowRef(vault))

    expect(governanceType.value).toBe('ungoverned')
    expect(badges.value).toEqual(['ungoverned', 'governanceLimited'])
    expect(summaryBadges.value).toEqual([])
    expect(hasSummaryBadges.value).toBe(false)
  })
})
