import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { getEulerLabelProductBrandEntityKeys } from '@eulerxyz/euler-v2-sdk/public-labels'
import { normalizePublicLabelsData } from '~/utils/public-labels'
import { ASSESSMENT_ONLY_EARN, ASSESSMENT_ONLY_EVK, KPK_VAULT, NEUTRAL_ESCROW, VERIFICATION_ONLY_EVK, VERIFICATION_ONLY_EARN, publicLabelsFixture } from '~/tests/fixtures/public-labels-v20260804151305236'

describe('V3-only label normalization', () => {
  it('preserves managing entities, co-branding, campaigns and current geo assignments', () => {
    const data = normalizePublicLabelsData(1, publicLabelsFixture)
    expect(getEulerLabelProductBrandEntityKeys(data.products['kpk-securitize'])).toEqual(['kpk', 'securitize'])
    expect(data.entities.kpk.logo).toBe('https://token-images.euler.finance/labels/kpk')
    expect(data.points[getAddress(KPK_VAULT)]?.[0]?.name).toBe('KPK RWA points')
    expect(data.geoContext?.productByVault[KPK_VAULT.toLowerCase()]).toBe('kpk-securitize')
    expect(data.geoContext?.policies).toEqual(publicLabelsFixture.geoPolicies)
  })
  it('never uses old file membership to trust empty or unclaimed inventory', () => {
    const data = normalizePublicLabelsData(1, publicLabelsFixture)
    for (const address of [ASSESSMENT_ONLY_EVK, NEUTRAL_ESCROW, VERIFICATION_ONLY_EVK]) expect(data.verifiedVaultAddresses).not.toContain(getAddress(address))
    for (const address of [ASSESSMENT_ONLY_EARN, VERIFICATION_ONLY_EARN]) expect(data.earnVaults).not.toContain(getAddress(address))
  })
  it.each(['hidden', 'pending_review'] as const)('enforces %s and per-side flags', (status) => {
    const visibility = Object.fromEntries(Object.keys(publicLabelsFixture.visibility).map(address => [address, { status, explorableLend: false, explorableBorrow: false, decidedBy: 'unclaimed', reason: null }]))
    const data = normalizePublicLabelsData(1, { ...publicLabelsFixture, visibility })
    expect(data.verifiedVaultAddresses).toEqual([])
    expect(data.earnVaults).toEqual([])
    expect(data.products['kpk-securitize'].vaultOverrides?.[getAddress(KPK_VAULT)]?.notExplorableLend).toBe(true)
    expect(data.notExplorableEarnVaults.has(VERIFICATION_ONLY_EARN.toLowerCase())).toBe(true)
  })
  it('does not infer one side from the other', () => {
    const visibility = { ...publicLabelsFixture.visibility, [KPK_VAULT.toLowerCase()]: { ...publicLabelsFixture.visibility[KPK_VAULT.toLowerCase()], explorableLend: false, explorableBorrow: true } }
    const data = normalizePublicLabelsData(1, { ...publicLabelsFixture, visibility })
    expect(data.products['kpk-securitize'].vaultOverrides?.[getAddress(KPK_VAULT)]).toMatchObject({ notExplorableLend: true, notExplorableBorrow: false })
  })
})
