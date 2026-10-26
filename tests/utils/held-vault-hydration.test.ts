import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Portfolio, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { hydrateHeldVaults } from '~/utils/portfolioPositionFilter'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { __setEulerLabelsDataForTest, useEulerLabels } from '~/composables/useEulerLabels'
import { getVaultGeoBlockReason, isVaultBlockedByCountry, useGeoBlock } from '~/composables/useGeoBlock'
import { cozy, staticGeoLabels } from '~/tests/fixtures/static-geo-labels'

const mocks = vi.hoisted(() => ({ fetchVault: vi.fn(), category: vi.fn() }))
vi.mock('~/utils/vault/categories', () => ({ fetchVaultCategory: mocks.category }))
const chainId = ref<number | undefined>(1)
const vault = (address = cozy.address, type = 'EVault') => ({
  ...cozy, address, type, isEscrow: false, shares: { ...cozy.asset, address, decimals: 6 },
  asset: { ...cozy.asset, decimals: 6 }, totalShares: 0n, totalAssets: 0n,
}) as VaultEntity
const collateral = '0xCee57C0F5060063F6875CFF54225F814Db604150'
const earn = '0x0000000000000000000000000000000000000003'
const owner = '0x9Db3e0FBd969ec2468C8d9f85440dC5595CE1FD9'
const portfolio = (debt: VaultEntity | undefined = vault()) => ({
  account: { chainId: 1, getSubAccount: () => ({ enabledCollaterals: [collateral] }) },
  savings: [{ vault: vault(earn, 'EulerEarn'), position: { vaultAddress: earn } }],
  borrows: [{ borrowVault: debt, borrow: { account: owner, vaultAddress: cozy.address },
    collateralVaults: [collateral], collaterals: [{ vaultAddress: collateral, vault: vault(collateral) }] }],
}) as unknown as Portfolio<VaultEntity>

beforeEach(() => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
  vi.stubGlobal('useEulerLabels', useEulerLabels)
  vi.stubGlobal('useEulerSdk', () => ({ getEulerSdkForChain: async () => ({ eVaultService: { fetchVault: mocks.fetchVault } }) }))
  chainId.value = undefined
  useVaultRegistry().clear()
  chainId.value = 1
  mocks.category.mockReset().mockResolvedValue('evk')
  mocks.fetchVault.mockReset().mockResolvedValue({ result: vault(), errors: [] })
  useGeoBlock().country.value = 'NL'
})
afterEach(() => vi.unstubAllGlobals())

describe.each(['v3', 'v3-metadata', 'static'] as const)('%s held vault hydration', (source) => {
  beforeEach(() => __setEulerLabelsDataForTest(source === 'static'
    ? staticGeoLabels()
    : {
        source, sourceFetchedAt: Date.now(), geoFetchedAt: Date.now(), candidateVaultAddresses: [], candidateEarnVaultAddresses: [],
        geoContext: { chainId: 1, policies: [], productByVault: {} },
      }))
  it('registers unpublished debt, collateral and savings from the SDK without fetching', async () => {
    const p = portfolio()
    expect(getVaultGeoBlockReason(cozy.address)).toBe('asset-unavailable')
    await hydrateHeldVaults(p)
    const registry = useVaultRegistry()
    expect(registry.getVault(cozy.address)).toBe(p.borrows[0]!.borrowVault)
    expect(registry.get(cozy.address)).toMatchObject({ verified: false, portfolioOnly: true })
    expect(registry.getVault(collateral)).toBe(p.borrows[0]!.collaterals[0]!.vault)
    expect(registry.get(earn)).toMatchObject({ type: 'earn', verified: false, portfolioOnly: true })
    expect(mocks.fetchVault).not.toHaveBeenCalled()
    expect(isVaultBlockedByCountry(cozy.address)).toBe(false)
    expect(registry.getVerifiedEVaults()).toEqual([])
  })
  it('does not overwrite a discovered vault or its verification', async () => {
    const registry = useVaultRegistry()
    const discovered = vault()
    registry.set(cozy.address, discovered, 'evk', { verified: true })
    await hydrateHeldVaults(portfolio())
    expect(registry.getVault(cozy.address)).toBe(discovered)
    expect(registry.get(cozy.address)?.verified).toBe(true)
    expect(registry.get(cozy.address)?.portfolioOnly).not.toBe(true)
  })
  it('refreshes held SDK metadata without promoting it to discovery', async () => {
    const registry = useVaultRegistry()
    await hydrateHeldVaults(portfolio())
    const updated = vault()
    await hydrateHeldVaults(portfolio(updated))
    expect(registry.getVault(cozy.address)).toBe(updated)
    expect(registry.get(cozy.address)).toMatchObject({ verified: false, portfolioOnly: true })
    registry.set(cozy.address, vault(), 'evk')
    expect(registry.get(cozy.address)?.portfolioOnly).toBe(true)
    registry.setMany([{ address: cozy.address, vault: updated, type: 'evk', verified: true }])
    expect(registry.get(cozy.address)?.portfolioOnly).not.toBe(true)
  })
  it('resolves missing SDK vaults through the registry without granting discovery membership', async () => {
    const p = portfolio()
    p.borrows[0]!.borrowVault = undefined
    useVaultRegistry().clear()
    await hydrateHeldVaults(p)
    expect(mocks.fetchVault).toHaveBeenCalledTimes(1)
    expect(useVaultRegistry().get(cozy.address)).toMatchObject({ verified: false, portfolioOnly: true })
    expect(isVaultBlockedByCountry(cozy.address)).toBe(false)
  })
  it('keeps a failed resolution guarded while retaining the other held metadata', async () => {
    const p = portfolio()
    p.borrows[0]!.borrowVault = undefined
    mocks.fetchVault.mockRejectedValueOnce(new Error('unavailable'))
    await hydrateHeldVaults(p)
    expect(useVaultRegistry().getVault(cozy.address)).toBeUndefined()
    expect(useVaultRegistry().getVault(collateral)).toBeDefined()
    expect(getVaultGeoBlockReason(cozy.address)).toBe('asset-unavailable')
    expect(isVaultBlockedByCountry(cozy.address)).toBe(true)
  })
  it('does not demote discovery that arrives during a held-vault fallback', async () => {
    const p = portfolio()
    p.borrows[0]!.borrowVault = undefined
    let finish!: (value: { result: VaultEntity, errors: never[] }) => void
    mocks.fetchVault.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    const pending = hydrateHeldVaults(p)
    await vi.waitFor(() => expect(finish).toBeDefined())
    const discovered = vault()
    useVaultRegistry().setMany([{ address: cozy.address, vault: discovered, type: 'evk', verified: true }])
    finish({ result: vault(), errors: [] })
    await pending
    expect(useVaultRegistry().get(cozy.address)).toMatchObject({ vault: discovered, verified: true })
    expect(useVaultRegistry().get(cozy.address)?.portfolioOnly).not.toBe(true)
  })
  it('does not register a fallback that completes after a chain switch', async () => {
    const p = portfolio()
    p.borrows[0]!.borrowVault = undefined
    let finish!: (value: { result: VaultEntity, errors: never[] }) => void
    mocks.fetchVault.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    const pending = hydrateHeldVaults(p)
    await vi.waitFor(() => expect(finish).toBeDefined())
    chainId.value = 8453
    finish({ result: vault(), errors: [] })
    await pending
    expect(useVaultRegistry().getAll()).toEqual([])
    chainId.value = 1
    expect(useVaultRegistry().getVault(cozy.address)).toBeUndefined()
  })
  it('does not reuse a resolved asset from the wrong chain', async () => {
    const p = portfolio({ ...vault(), chainId: 8453 } as VaultEntity)
    await hydrateHeldVaults(p)
    expect(mocks.fetchVault).toHaveBeenCalledTimes(1)
    expect(useVaultRegistry().getVault(cozy.address)?.chainId).toBe(1)
  })
  it('registers held Securitize collateral and keeps held escrow out of collateral discovery', async () => {
    const p = portfolio()
    const securitize = vault(collateral, 'SecuritizeCollateral')
    p.borrows[0]!.collaterals[0]!.vault = securitize
    p.savings[0]!.vault = { ...vault(earn), isEscrow: true } as VaultEntity
    await hydrateHeldVaults(p)
    expect(useVaultRegistry().get(collateral)).toMatchObject({ type: 'securitize', verified: false, portfolioOnly: true })
    expect(useVaultRegistry().getVault(earn)).toBe(p.savings[0]!.vault)
    expect(useVaultRegistry().getEscrowVaults()).toEqual([])
  })
  it('ignores a portfolio from another chain', async () => {
    chainId.value = 8453
    await hydrateHeldVaults(portfolio())
    expect(useVaultRegistry().getAll()).toEqual([])
    expect(mocks.fetchVault).not.toHaveBeenCalled()
  })
  it('retains unknown-country guards after hydration', async () => {
    await hydrateHeldVaults(portfolio())
    useGeoBlock().country.value = null
    expect(isVaultBlockedByCountry(cozy.address)).toBe(true)
    expect(getVaultGeoBlockReason(cozy.address)).toBe('country-unavailable')
  })
})
