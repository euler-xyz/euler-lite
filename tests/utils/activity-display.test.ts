import { describe, expect, it } from 'vitest'
import {
  enrichActivityAssetForDisplay,
  formatActivityAssetAmount,
  formatActivityAssetUsd,
  formatActivityEventLabel,
  formatActivityTimestamp,
  formatActivityValuation,
  getActivityAssetAddressLabel,
  getActivityAssetLabel,
  getActivityChangeEntries,
  getActivityParticipants,
  getDisplayActivityEventTypes,
  getVaultActivityFilterOptions,
  isActivityScopeUnsupported,
  resolveActivityFilterCategories,
} from '~/utils/activity-display'
import { isVaultBorrowable } from '~/utils/vault/classification'

const ASSET = '0x0000000000000000000000000000000000000001' as const
const VAULT = '0x0000000000000000000000000000000000000002' as const
const SHARES = '0x0000000000000000000000000000000000000003' as const

describe('activity display helpers', () => {
  it('uses bounded scope-specific event filters without display noise', () => {
    const scopes = [
      { kind: 'account' },
      { kind: 'vault', vaultType: 'evk' },
      { kind: 'vault', vaultType: 'earn' },
      { kind: 'vault', vaultType: 'securitize' },
    ] as const
    const hiddenTypes = ['interest_accrued', 'accrue_interest', 'mint', 'burn']

    for (const scope of scopes) {
      const eventTypes = getDisplayActivityEventTypes(scope)
      expect(eventTypes.join(',').length).toBeLessThanOrEqual(1_024)
      expect(eventTypes).not.toEqual(expect.arrayContaining(hiddenTypes))
    }

    expect(getDisplayActivityEventTypes({ kind: 'account' })).toEqual(expect.arrayContaining([
      'deposit',
      'transfer',
      'reward_transfer',
    ]))
    expect(getDisplayActivityEventTypes({ kind: 'vault', vaultType: 'evk' })).toEqual(expect.arrayContaining([
      'deposit',
      'transfer',
      'set_caps',
    ]))
  })

  it('returns vault-specific category filters with category-accurate labels', () => {
    expect(getVaultActivityFilterOptions('evk')).toEqual([
      { value: 'lending-borrowing', label: 'Lending and borrowing', categories: ['lending', 'borrowing'] },
      { value: 'governance', label: 'Governance', categories: ['governance'] },
      { value: 'liquidations', label: 'Liquidations', categories: ['liquidations'] },
    ])
    expect(getVaultActivityFilterOptions('earn')).toEqual([
      { value: 'lending', label: 'Lending', categories: ['lending'] },
      { value: 'governance', label: 'Governance', categories: ['governance'] },
    ])
    expect(getVaultActivityFilterOptions('securitize')).toEqual([
      { value: 'lending', label: 'Lending', categories: ['lending'] },
      { value: 'governance', label: 'Governance', categories: ['governance'] },
    ])

    const options = getVaultActivityFilterOptions('evk')
    expect(resolveActivityFilterCategories(options, [])).toEqual([
      'borrowing',
      'governance',
      'lending',
      'liquidations',
    ])
    expect(resolveActivityFilterCategories(options, ['lending-borrowing'])).toEqual([
      'borrowing',
      'lending',
    ])
  })

  it('keeps historical borrowing filters for a currently non-borrowable EVK', () => {
    expect(isVaultBorrowable({ isBorrowable: false, totalBorrowed: 0n })).toBe(false)

    expect(resolveActivityFilterCategories(getVaultActivityFilterOptions('evk'), [])).toEqual([
      'borrowing',
      'governance',
      'lending',
      'liquidations',
    ])
  })

  it('treats only explicit-All unsupported coverage as scope-wide', () => {
    expect(isActivityScopeUnsupported('unsupported', [])).toBe(true)
    expect(isActivityScopeUnsupported('unsupported', ['governance'])).toBe(false)
    expect(isActivityScopeUnsupported('partial', [])).toBe(false)
  })

  it('uses normalized labels and titleizes fallback event types', () => {
    expect(formatActivityEventLabel({ label: 'Borrowed USDC', type: 'borrow' })).toBe('Borrowed USDC')
    expect(formatActivityEventLabel({ type: 'set_supply_cap' })).toBe('Set supply cap')
  })

  it('formats normalized and raw asset amounts without inventing USD values', () => {
    expect(formatActivityAssetAmount({ kind: 'assets', address: ASSET, amountRaw: '1234500000', amount: '1234.5', symbol: 'USDC' })).toBe('1,234.50 USDC')
    expect(formatActivityAssetAmount({ kind: 'assets', address: ASSET, amountRaw: '1500000', decimals: 6, symbol: 'USDC' })).toBe('1.5 USDC')
    expect(formatActivityAssetAmount({ kind: 'assets', amountRaw: '1500000' })).toBe('Raw: 1,500,000')
    expect(formatActivityAssetUsd({ kind: 'assets', amountRaw: '1', amountUsd: '1234.5' })).toBe('$1.23K')
    expect(formatActivityAssetUsd({ kind: 'assets', amountRaw: '1' })).toBeNull()
    expect(formatActivityValuation({ status: 'unavailable', reason: 'No historical price' })).toBe('USD value unavailable')
    expect(formatActivityValuation({ status: 'partial', amountUsd: '1234.5' })).toBe('$1.23K (partial)')
  })

  it('enriches raw amounts from registry metadata without overriding source fields', () => {
    const getVaultMetadata = (address: string) => address.toLowerCase() === VAULT.toLowerCase()
      ? {
          asset: { address: ASSET, symbol: 'USDC', decimals: 6 },
          shares: { address: SHARES, symbol: 'eUSDC', decimals: 18 },
        }
      : undefined

    expect(enrichActivityAssetForDisplay(
      { kind: 'assets', amountRaw: '1500000' },
      { category: 'lending', vault: VAULT },
      getVaultMetadata,
    )).toEqual({
      kind: 'assets',
      amountRaw: '1500000',
      address: ASSET,
      symbol: 'USDC',
      decimals: 6,
    })

    expect(enrichActivityAssetForDisplay(
      { kind: 'shares', amountRaw: '1', address: VAULT, symbol: 'Source shares' },
      { category: 'lending', vault: VAULT },
      getVaultMetadata,
    )).toEqual({
      kind: 'shares',
      amountRaw: '1',
      address: VAULT,
      symbol: 'Source shares',
      decimals: 18,
    })

    const unpriced = enrichActivityAssetForDisplay(
      { kind: 'assets', amountRaw: '1500000' },
      { category: 'lending', vault: VAULT },
      getVaultMetadata,
    )
    expect(unpriced.amountUsd).toBeUndefined()
  })

  it('formats all governance changes and category-specific liquidation details', () => {
    expect(getActivityChangeEntries({
      fields: {
        supply_cap: '2000',
        is_allocator: true,
        queue: ['one', 'two'],
      },
    })).toEqual([
      { field: 'supply_cap', label: 'Supply cap', value: '2000' },
      { field: 'is_allocator', label: 'Is allocator', value: 'Enabled' },
      { field: 'queue', label: 'Queue', value: 'one, two' },
    ])
    expect(getActivityAssetLabel('assets', 'liquidations')).toBe('Debt repaid')
    expect(getActivityAssetLabel('collateral', 'liquidations')).toBe('Collateral seized')
    expect(getActivityAssetAddressLabel('assets', 'liquidations')).toBe('Debt vault')
    expect(getActivityAssetAddressLabel('collateral', 'liquidations')).toBe('Collateral vault')

    expect(getActivityParticipants({
      category: 'liquidations',
      actor: ASSET,
      counterparty: '0x0000000000000000000000000000000000000002',
    })).toEqual([
      { label: 'Liquidator', address: ASSET },
      { label: 'Violator', address: '0x0000000000000000000000000000000000000002' },
    ])
  })

  it('formats timestamps', () => {
    expect(formatActivityTimestamp('not-a-date')).toBe('-')
    expect(formatActivityTimestamp('2026-07-13T10:30:00.000Z')).toContain('13 Jul 2026')
  })
})
