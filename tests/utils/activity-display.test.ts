import { describe, expect, it } from 'vitest'
import type { ActivityEvent } from '@eulerxyz/euler-v2-sdk'
import { maxUint256, type Address } from 'viem'
import {
  decodeEvkAmountCap,
  enrichActivityAssetForDisplay,
  filterActivityEventsForDisplay,
  formatActivityAssetAmount,
  formatActivityAssetUsd,
  formatActivityEventLabel,
  formatActivityTimestamp,
  formatActivityValuation,
  formatActivityValuationForAssets,
  getAccountActivityFilterOptions,
  getActivityAssetAddressLabel,
  getActivityAssetLabel,
  getActivityAssetsForDisplay,
  getActivityChangeEntries,
  getActivityEventIcon,
  getActivityParticipants,
  getActivityTransferDirection,
  getDisplayActivityEventTypes,
  getVaultActivityFilterOptions,
  isActivityScopeUnsupported,
  resolveActivityFilterCategories,
  resolveActivityVaultDisplay,
} from '~/utils/activity-display'
import { isVaultBorrowable } from '~/utils/vault/classification'

const ASSET = '0x0000000000000000000000000000000000000001' as const
const VAULT = '0x0000000000000000000000000000000000000002' as const
const SHARES = '0x0000000000000000000000000000000000000003' as const
const OTHER_VAULT = '0x0000000000000000000000000000000000000004' as const

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

    expect(getDisplayActivityEventTypes({ kind: 'account' })).toEqual([
      'deposit',
      'withdraw',
      'borrow',
      'repay',
      'pull_debt',
      'liquidation',
      'operator_status',
    ])
    expect(getDisplayActivityEventTypes({ kind: 'vault', vaultType: 'evk' })).toEqual(expect.arrayContaining([
      'deposit',
      'withdraw',
      'borrow',
      'repay',
      'set_caps',
      'set_ltv',
      'liquidation',
    ]))
  })

  it('returns the focused portfolio position category filters in display order', () => {
    expect(getAccountActivityFilterOptions()).toEqual([
      { value: 'lending', label: 'Lending', categories: ['lending'] },
      { value: 'borrowing', label: 'Borrowing', categories: ['borrowing'] },
      { value: 'liquidations', label: 'Liquidations', categories: ['liquidations'] },
      { value: 'account', label: 'Position', categories: ['account'] },
    ])
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

  it('distinguishes same-token account activity from different markets', () => {
    const getVaultMetadata = (address: Address) => ({
      asset: { address: ASSET, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
      shares: {
        address,
        name: 'Euler USDC',
        symbol: 'eUSDC',
        decimals: 18,
      },
    })

    const firstMarket = resolveActivityVaultDisplay(VAULT, getVaultMetadata, 'USDC Prime')
    const secondMarket = resolveActivityVaultDisplay(OTHER_VAULT, getVaultMetadata)

    expect(firstMarket).toMatchObject({
      name: 'USDC Prime',
      addressLabel: '0x0000...0002',
    })
    expect(secondMarket).toMatchObject({
      name: 'Euler USDC',
      addressLabel: '0x0000...0004',
    })
    expect(firstMarket?.addressLabel).not.toBe(secondMarket?.addressLabel)
  })

  it('falls back to a shortened market address when registry metadata is unavailable', () => {
    expect(resolveActivityVaultDisplay(VAULT, () => undefined)).toEqual({
      address: VAULT,
      addressLabel: '0x0000...0002',
    })
    expect(resolveActivityVaultDisplay(undefined, () => undefined)).toBeNull()
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

  it('labels and styles vault share transfers relative to the event position', () => {
    const sent = {
      account: VAULT,
      category: 'lending' as const,
      payload: { from: VAULT, to: OTHER_VAULT },
      type: 'transfer',
    }
    const received = {
      account: VAULT,
      category: 'lending' as const,
      payload: { from: OTHER_VAULT, to: VAULT },
      type: 'transfer',
    }

    expect(getActivityTransferDirection(sent)).toBe('sent')
    expect(formatActivityEventLabel(sent)).toBe('Sent shares')
    expect(getActivityEventIcon(sent)).toEqual({ name: 'borrow-outline' })
    expect(getActivityTransferDirection(received)).toBe('received')
    expect(formatActivityEventLabel(received)).toBe('Received shares')
    expect(getActivityEventIcon(received)).toEqual({ name: 'lend-outline' })
    expect(formatActivityEventLabel({ ...sent, label: 'Custom transfer' })).toBe('Custom transfer')
  })

  it('hides only exact paired vault share transfers from the same transaction', () => {
    const base = {
      chainId: 1,
      category: 'lending' as const,
      timestamp: '2026-07-13T10:30:00.000Z',
      blockNumber: '123',
      logIndex: 0,
      txHash: `0x${'1'.repeat(64)}`,
      source: 'v3-ponder',
      payload: {},
      vault: VAULT,
      groupId: 'transaction-one',
    }
    const events = [
      {
        ...base,
        id: 'deposit',
        type: 'deposit',
        rawType: 'deposit',
        assets: [{ kind: 'shares', address: SHARES, amountRaw: '100' }],
      },
      {
        ...base,
        id: 'paired-transfer',
        type: 'transfer',
        rawType: 'transfer',
        assets: [{ kind: 'shares', address: SHARES, amountRaw: '100' }],
      },
      {
        ...base,
        id: 'independent-transfer',
        type: 'transfer',
        rawType: 'transfer',
        assets: [{ kind: 'shares', address: SHARES, amountRaw: '25' }],
      },
      {
        ...base,
        id: 'other-transaction',
        txHash: `0x${'2'.repeat(64)}`,
        type: 'transfer',
        rawType: 'transfer',
        assets: [{ kind: 'shares', address: SHARES, amountRaw: '100' }],
      },
    ] as ActivityEvent[]

    expect(filterActivityEventsForDisplay(events, ['deposit', 'transfer']).map(event => event.id)).toEqual([
      'deposit',
      'independent-transfer',
      'other-transaction',
    ])
  })

  it('hides an exact repay emitted alongside a liquidation', () => {
    const base = {
      chainId: 1,
      timestamp: '2026-07-13T10:30:00.000Z',
      blockNumber: '123',
      txHash: `0x${'1'.repeat(64)}`,
      source: 'v3-ponder',
      payload: {},
      vault: VAULT,
    }
    const events = [
      {
        ...base,
        id: 'repay',
        category: 'borrowing',
        logIndex: 1,
        type: 'repay',
        rawType: 'repay',
        assets: [{ kind: 'assets', address: ASSET, amountRaw: '100' }],
      },
      {
        ...base,
        id: 'liquidation',
        category: 'liquidations',
        logIndex: 2,
        type: 'liquidation',
        rawType: 'liquidation',
        assets: [
          { kind: 'assets', address: ASSET, amountRaw: '100' },
          { kind: 'collateral', address: OTHER_VAULT, amountRaw: '200' },
        ],
      },
      {
        ...base,
        id: 'independent-repay',
        category: 'borrowing',
        logIndex: 3,
        type: 'repay',
        rawType: 'repay',
        assets: [{ kind: 'assets', address: ASSET, amountRaw: '25' }],
      },
    ] as ActivityEvent[]

    expect(filterActivityEventsForDisplay(events, ['repay', 'liquidation']).map(event => event.id)).toEqual([
      'liquidation',
      'independent-repay',
    ])
  })

  it('shows only underlying asset amounts', () => {
    const event = {
      assets: [
        { kind: 'assets', address: ASSET, amountRaw: '100' },
        { kind: 'shares', address: VAULT, amountRaw: '90' },
        { kind: 'collateral', address: OTHER_VAULT, amountRaw: '80' },
      ],
    } as Pick<ActivityEvent, 'assets'>

    expect(getActivityAssetsForDisplay(event)).toEqual([
      { kind: 'assets', address: ASSET, amountRaw: '100' },
    ])
  })

  it('formats normalized and raw asset amounts without inventing USD values', () => {
    expect(formatActivityAssetAmount({ kind: 'assets', address: ASSET, amountRaw: '1234500000', amount: '1234.5', symbol: 'USDC' })).toBe('1,234.50 USDC')
    expect(formatActivityAssetAmount({ kind: 'assets', address: ASSET, amountRaw: '1500000', decimals: 6, symbol: 'USDC' })).toBe('1.5 USDC')
    expect(formatActivityAssetAmount({ kind: 'assets', amountRaw: '1500000' })).toBe('Amount unavailable')
    expect(formatActivityAssetUsd({ kind: 'assets', amountRaw: '1', amountUsd: '1234.5' })).toBe('$1.23K')
    expect(formatActivityAssetUsd({ kind: 'assets', amountRaw: '1' })).toBeNull()
    expect(formatActivityValuation({ status: 'unavailable', reason: 'No historical price' })).toBeNull()
    expect(formatActivityValuation({ status: 'partial', amountUsd: '1234.5' })).toBe('$1.23K (partial)')
    expect(formatActivityAssetAmount({ kind: 'assets', amountRaw: maxUint256.toString(), decimals: 18, symbol: 'USDC' }, 'approval')).toBe('Unlimited')
    expect(formatActivityAssetAmount({ kind: 'assets', amountRaw: '0', decimals: 18, symbol: 'USDC' }, 'approval')).toBe('Revoked')
    expect(getActivityAssetLabel('assets', 'account', 'approval')).toBe('Allowance')
    expect(formatActivityValuationForAssets(
      { status: 'available', amountUsd: '1234.5' },
      [{ kind: 'assets', amountRaw: '1', amountUsd: '1234.5' }],
    )).toBeNull()
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

    expect(enrichActivityAssetForDisplay(
      { kind: 'value', amountRaw: '100', address: ASSET },
      { category: 'rewards' },
      getVaultMetadata,
      address => address === ASSET
        ? { address: ASSET, symbol: 'EUL', decimals: 18 }
        : undefined,
    )).toEqual({
      kind: 'value',
      amountRaw: '100',
      address: ASSET,
      symbol: 'EUL',
      decimals: 18,
    })

    const unpriced = enrichActivityAssetForDisplay(
      { kind: 'assets', amountRaw: '1500000' },
      { category: 'lending', vault: VAULT },
      getVaultMetadata,
    )
    expect(unpriced.amountUsd).toBeUndefined()
  })

  it('decodes EVK caps and formats vault configuration changes semantically', () => {
    const getVaultMetadata = (address: Address) => address.toLowerCase() === VAULT.toLowerCase()
      ? {
          asset: { address: ASSET, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
          shares: { address: VAULT, name: 'Euler USDC', symbol: 'eUSDC', decimals: 18 },
        }
      : address.toLowerCase() === OTHER_VAULT.toLowerCase()
        ? {
            asset: { address: ASSET, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
            shares: { address: OTHER_VAULT, name: 'Collateral vault', symbol: 'eUSDC', decimals: 18 },
            vaultType: 'evk' as const,
          }
        : undefined

    expect(decodeEvkAmountCap('43213')).toBe(67_500_000_000_000n)
    expect(decodeEvkAmountCap('65536')).toBeNull()
    expect(getActivityChangeEntries({
      type: 'set_caps',
      vault: VAULT,
      vaultType: 'evk',
      change: {
        fields: {
          supply_cap: '48013',
          borrow_cap: '43213',
        },
      },
    }, getVaultMetadata)).toEqual([
      { field: 'supply_cap', label: 'Supply cap', value: '75,000,000.00 USDC' },
      { field: 'borrow_cap', label: 'Borrow cap', value: '67,500,000.00 USDC' },
    ])

    expect(getActivityChangeEntries({
      type: 'set_ltv',
      vault: VAULT,
      vaultType: 'evk',
      change: {
        fields: {
          collateral: OTHER_VAULT,
          borrow_ltv: '8500',
          liquidation_ltv: '9000',
          ramp_duration: '90000',
          target_timestamp: '1767225600',
        },
      },
    }, getVaultMetadata)).toEqual([
      {
        field: 'collateral',
        label: 'Collateral',
        addresses: [{
          address: OTHER_VAULT,
          label: 'Collateral vault',
          linkKind: 'vault',
          vaultType: 'evk',
        }],
      },
      { field: 'borrow_ltv', label: 'Borrow LTV', value: '85%' },
      { field: 'liquidation_ltv', label: 'Liquidation LTV', value: '90%' },
      { field: 'ramp_duration', label: 'Ramp duration', value: '1 day 1 hour' },
      { field: 'target_timestamp', label: 'Target timestamp', value: expect.stringContaining('1 Jan 2026') },
    ])
  })

  it('links protocol addresses externally and user identities through spy mode', () => {
    expect(getActivityChangeEntries({
      type: 'set_interest_rate_model',
      vault: VAULT,
      vaultType: 'evk',
      change: { fields: { new_interest_rate_model: OTHER_VAULT } },
    })).toEqual([{
      field: 'new_interest_rate_model',
      label: 'New interest rate model',
      addresses: [{ address: OTHER_VAULT, linkKind: 'explorer' }],
    }])

    expect(getActivityParticipants({
      category: 'lending',
      account: VAULT,
      actor: ASSET,
    })).toEqual([
      { label: 'User', address: VAULT, linkKind: 'spy' },
      { label: 'Actor', address: ASSET, linkKind: 'explorer' },
    ])
  })

  it('formats all governance changes and category-specific liquidation details', () => {
    expect(getActivityChangeEntries({
      type: 'set_config_flags',
      change: {
        fields: {
          supply_cap: '2000',
          is_allocator: true,
          queue: ['one', 'two'],
        },
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
      { label: 'Liquidator', address: ASSET, linkKind: 'explorer' },
      { label: 'Violator', address: '0x0000000000000000000000000000000000000002', linkKind: 'spy' },
    ])
  })

  it('formats timestamps', () => {
    expect(formatActivityTimestamp('not-a-date')).toBe('-')
    expect(formatActivityTimestamp('2026-07-13T10:30:00.000Z')).toContain('13 Jul 2026')
  })
})
