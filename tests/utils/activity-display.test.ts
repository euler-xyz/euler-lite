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
  formatActivityRelativeTimestamp,
  formatActivityTimestamp,
  formatActivityValuation,
  formatActivityValuationForAssets,
  getAccountActivityCategories,
  getAccountActivityFilterOptions,
  getActivityAmountDirection,
  getActivityAssetAddressLabel,
  getActivityAssetLabel,
  getActivityAssetsForDisplay,
  getActivityChangeEntries,
  getActivityEventIcon,
  getActivityLiquidationDisplayDetails,
  getPortfolioActivityPositionParticipant,
  getActivityTransferDirection,
  getActivityTransactionGroupLabel,
  getDefaultVaultActivityFilter,
  getDisplayActivityEventTypes,
  getVaultActivityFilterOptions,
  groupActivityEventsByTransaction,
  isActivityScopeUnsupported,
  resolveActivityFilterCategories,
  resolveActivityVaultDisplay,
} from '~/utils/activity-display'
import { isVaultBorrowable } from '~/utils/vault/classification'

const ASSET = '0x0000000000000000000000000000000000000001' as const
const VAULT = '0x0000000000000000000000000000000000000002' as const
const SHARES = '0x0000000000000000000000000000000000000003' as const
const OTHER_VAULT = '0x0000000000000000000000000000000000000004' as const
const VIOLATOR = '0x0000000000000000000000000000000000000005' as const
const LIQUIDATOR = '0x0000000000000000000000000000000000000006' as const
const USD_UNIT_OF_ACCOUNT = '0x0000000000000000000000000000000000000348' as const

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

    const earnEventTypes = getDisplayActivityEventTypes({ kind: 'vault', vaultType: 'earn' })
    expect(earnEventTypes).toEqual(expect.arrayContaining([
      'deposit',
      'withdraw',
      'transfer',
      'reallocate_supply',
      'reallocate_withdraw',
      'public_reallocate_to',
      'public_withdrawal',
      'set_cap',
      'set_fee',
    ]))
    expect(earnEventTypes).not.toEqual(expect.arrayContaining([
      'approval',
      'update_last_total_assets',
      'update_lost_assets',
    ]))
  })

  it('returns the focused portfolio position category filters in display order', () => {
    // Only liquidations is exposed as a chip — verbs and transaction grouping
    // already communicate lending/borrowing — while the unfiltered feed still
    // queries every displayable category. No `account` category anywhere:
    // none of its event types are displayed on Lite.
    expect(getAccountActivityFilterOptions()).toEqual([
      { value: 'liquidations', label: 'Liquidations', categories: ['liquidations'] },
    ])
    expect(getAccountActivityCategories()).toEqual(['lending', 'borrowing', 'liquidations'])
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

  it('defaults vault activity to lending and borrowing without hiding other filters', () => {
    expect(getDefaultVaultActivityFilter('evk')).toBe('lending-borrowing')
    expect(getDefaultVaultActivityFilter('earn')).toBe('lending')
    expect(getDefaultVaultActivityFilter('securitize')).toBe('lending')
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
    expect(formatActivityEventLabel({ type: 'set_ltv' })).toBe('Set LTV')
    expect(formatActivityEventLabel({ type: 'set_interest_rate_model' })).toBe('Set interest rate model')
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
    expect(formatActivityEventLabel(sent)).toBe('Vault shares sent')
    expect(getActivityEventIcon(sent)).toEqual({ name: 'borrow-outline' })
    expect(getActivityTransferDirection(received)).toBe('received')
    expect(formatActivityEventLabel(received)).toBe('Vault shares received')
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

  it('hides only the violator repay emitted alongside a liquidation', () => {
    const base = {
      chainId: 1,
      timestamp: '2026-07-13T10:30:00.000Z',
      blockNumber: '123',
      txHash: '0x830d02459a26d4893b105cd7edbf4720bd2cd649f5fa382cdbed5fee4b64895c',
      source: 'v3-ponder',
      payload: {},
      vault: VAULT,
    }
    const events = [
      {
        ...base,
        id: 'violator-repay',
        category: 'borrowing',
        logIndex: 259,
        type: 'repay',
        rawType: 'repay',
        account: VIOLATOR,
        assets: [{ kind: 'assets', address: ASSET, amountRaw: '2584055565' }],
      },
      {
        ...base,
        id: 'liquidator-borrow',
        category: 'borrowing',
        logIndex: 261,
        type: 'borrow',
        rawType: 'borrow',
        account: LIQUIDATOR,
        assets: [{ kind: 'assets', address: ASSET, amountRaw: '2584055565' }],
      },
      {
        ...base,
        id: 'liquidation',
        category: 'liquidations',
        logIndex: 265,
        type: 'liquidation',
        rawType: 'liquidation',
        account: VIOLATOR,
        counterparty: VIOLATOR,
        payload: { violator: VIOLATOR },
        assets: [
          { kind: 'assets', address: ASSET, amountRaw: '2584055565' },
          { kind: 'collateral', address: OTHER_VAULT, amountRaw: '200' },
        ],
      },
      {
        ...base,
        id: 'liquidator-repay',
        category: 'borrowing',
        logIndex: 268,
        type: 'repay',
        rawType: 'repay',
        account: LIQUIDATOR,
        assets: [{ kind: 'assets', address: ASSET, amountRaw: '2584055565' }],
      },
    ] as ActivityEvent[]

    expect(filterActivityEventsForDisplay(events, ['borrow', 'repay', 'liquidation']).map(event => event.id)).toEqual([
      'liquidator-borrow',
      'liquidation',
      'liquidator-repay',
    ])
  })

  it('preserves a liquidator repay when the liquidation is projected onto their account', () => {
    const base = {
      chainId: 1,
      timestamp: '2026-07-13T10:30:00.000Z',
      blockNumber: '123',
      txHash: '0x830d02459a26d4893b105cd7edbf4720bd2cd649f5fa382cdbed5fee4b64895c',
      source: 'v3-ponder',
      vault: VAULT,
    }
    const events = [
      {
        ...base,
        id: 'liquidation',
        category: 'liquidations',
        logIndex: 265,
        type: 'liquidation',
        rawType: 'liquidation',
        account: LIQUIDATOR,
        counterparty: VIOLATOR,
        payload: { violator: VIOLATOR },
        assets: [{ kind: 'assets', address: ASSET, amountRaw: '2584055565' }],
      },
      {
        ...base,
        id: 'liquidator-repay',
        category: 'borrowing',
        logIndex: 268,
        type: 'repay',
        rawType: 'repay',
        account: LIQUIDATOR,
        payload: {},
        assets: [{ kind: 'assets', address: ASSET, amountRaw: '2584055565' }],
      },
    ] as ActivityEvent[]

    expect(filterActivityEventsForDisplay(events, ['repay', 'liquidation']).map(event => event.id)).toEqual([
      'liquidation',
      'liquidator-repay',
    ])
  })

  it('keeps matching repayments when the liquidation violator is unavailable', () => {
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
        account: VIOLATOR,
        assets: [{ kind: 'assets', address: ASSET, amountRaw: '100' }],
      },
      {
        ...base,
        id: 'liquidation',
        category: 'liquidations',
        logIndex: 2,
        type: 'liquidation',
        rawType: 'liquidation',
        assets: [{ kind: 'assets', address: ASSET, amountRaw: '100' }],
      },
    ] as ActivityEvent[]

    expect(filterActivityEventsForDisplay(events, ['repay', 'liquidation']).map(event => event.id)).toEqual([
      'repay',
      'liquidation',
    ])
  })

  it('suppresses zero-value liquidation artifacts but keeps unknown and non-zero rows', () => {
    const base = {
      chainId: 1,
      category: 'liquidations' as const,
      timestamp: '2026-07-13T10:30:00.000Z',
      blockNumber: '123',
      logIndex: 0,
      txHash: `0x${'a'.repeat(64)}`,
      type: 'liquidation' as const,
      rawType: 'liquidation',
      source: 'v3-ponder',
      payload: {},
    }
    const events = [
      {
        ...base,
        id: 'zero',
        assets: [
          { kind: 'assets' as const, amountRaw: '0' },
          { kind: 'collateral' as const, amountRaw: '0' },
        ],
      },
      {
        ...base,
        id: 'non-zero',
        logIndex: 1,
        assets: [
          { kind: 'assets' as const, amountRaw: '1' },
          { kind: 'collateral' as const, amountRaw: '0' },
        ],
      },
      { ...base, id: 'unknown', logIndex: 2 },
    ] as ActivityEvent[]

    expect(filterActivityEventsForDisplay(events, ['liquidation'], {
      hideZeroLiquidations: true,
    }).map(event => event.id)).toEqual([
      'non-zero',
      'unknown',
    ])
    expect(filterActivityEventsForDisplay(events, ['liquidation']).map(event => event.id)).toEqual([
      'zero',
      'non-zero',
      'unknown',
    ])
  })

  it('groups composite portfolio operations by chain and transaction hash', () => {
    const base = {
      chainId: 1,
      category: 'lending' as const,
      timestamp: '2026-07-13T10:30:00.000Z',
      blockNumber: '123',
      logIndex: 0,
      txHash: `0x${'a'.repeat(64)}`,
      source: 'v3-ponder',
      payload: {},
    }
    const events = [
      { ...base, id: 'deposit', type: 'deposit', rawType: 'deposit' },
      { ...base, id: 'borrow', type: 'borrow', rawType: 'borrow', txHash: base.txHash.toUpperCase() },
      { ...base, id: 'withdraw', type: 'withdraw', rawType: 'withdraw', txHash: `0x${'b'.repeat(64)}` },
    ] as ActivityEvent[]

    expect(groupActivityEventsByTransaction(events).map(group => group.events.map(event => event.id))).toEqual([
      ['deposit', 'borrow'],
      ['withdraw'],
    ])
  })

  it('labels transaction groups containing a liquidation', () => {
    expect(getActivityTransactionGroupLabel({
      events: [
        { type: 'repay' } as ActivityEvent,
        { type: 'liquidation' } as ActivityEvent,
      ],
    })).toBe('Liquidation transaction')
    expect(getActivityTransactionGroupLabel({
      events: [{ type: 'repay' } as ActivityEvent],
    })).toBe('Transaction')
  })

  it('shows only underlying asset amounts', () => {
    const event = {
      category: 'lending',
      assets: [
        { kind: 'assets', address: ASSET, amountRaw: '100' },
        { kind: 'shares', address: VAULT, amountRaw: '90' },
        { kind: 'collateral', address: OTHER_VAULT, amountRaw: '80' },
      ],
    } as Pick<ActivityEvent, 'assets' | 'category'>

    expect(getActivityAssetsForDisplay(event)).toEqual([
      { kind: 'assets', address: ASSET, amountRaw: '100' },
    ])
  })

  it('includes collateral seized by liquidations without relabeling the debt token as a vault', () => {
    const event = {
      category: 'liquidations',
      assets: [
        { kind: 'assets', address: ASSET, amountRaw: '100' },
        { kind: 'collateral', address: OTHER_VAULT, amountRaw: '80' },
        { kind: 'shares', address: VAULT, amountRaw: '70' },
      ],
    } as Pick<ActivityEvent, 'assets' | 'category'>

    expect(getActivityAssetsForDisplay(event)).toEqual([
      { kind: 'assets', address: ASSET, amountRaw: '100' },
      { kind: 'collateral', address: OTHER_VAULT, amountRaw: '80' },
    ])
    expect(getActivityAssetAddressLabel('assets', 'liquidations')).toBe('Asset')
    expect(getActivityAssetAddressLabel('collateral', 'liquidations')).toBe('Collateral vault')
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

  it('orders LTV change fields and trims ramp fields on immediate changes', () => {
    // Upstream field order is unhelpful; an immediate change never ramps, so
    // the ramp target fields are dropped.
    expect(getActivityChangeEntries({
      type: 'set_ltv',
      vault: VAULT,
      vaultType: 'evk',
      change: {
        fields: {
          borrow_ltv: '9000',
          ramp_duration: '0',
          initial_liquidation_ltv: '0',
          liquidation_ltv: '9300',
          target_timestamp: '1767225600',
          collateral: OTHER_VAULT,
        },
      },
    }).map(entry => `${entry.field}:${entry.value ?? 'addresses'}`)).toEqual([
      'collateral:addresses',
      'borrow_ltv:90%',
      'liquidation_ltv:93%',
      'ramp_duration:Immediately',
    ])
  })

  it('decodes config flag bitmasks and renders zero addresses as None', () => {
    const configFlagEntries = (newConfigFlags: string) => getActivityChangeEntries({
      type: 'set_config_flags',
      change: { fields: { new_config_flags: newConfigFlags } },
    })
    expect(configFlagEntries('0')).toEqual([
      { field: 'new_config_flags', label: 'New config flags', value: 'Debt socialization enabled' },
    ])
    expect(configFlagEntries('1')).toEqual([
      { field: 'new_config_flags', label: 'New config flags', value: 'Debt socialization disabled' },
    ])
    // Unknown bit combinations fall back to the raw bitmask.
    expect(configFlagEntries('5')).toEqual([
      { field: 'new_config_flags', label: 'New config flags', value: '5' },
    ])

    expect(getActivityChangeEntries({
      type: 'set_governor_admin',
      change: { fields: { new_governor_admin: '0x0000000000000000000000000000000000000000' } },
    })).toEqual([
      { field: 'new_governor_admin', label: 'New governor admin', value: 'None' },
    ])
  })

  it('drops redundant share amounts from reallocation change entries', () => {
    const getVaultMetadata = () => ({
      asset: { address: ASSET, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
      shares: { address: SHARES, name: 'Euler USDC', symbol: 'eUSDC', decimals: 18 },
      vaultType: 'evk' as const,
    })

    // The share amount restates the asset amount in strategy share units.
    expect(getActivityChangeEntries({
      type: 'reallocate_supply',
      vault: VAULT,
      vaultType: 'earn',
      change: {
        fields: {
          strategy: OTHER_VAULT,
          supplied_assets: '20003',
          supplied_shares: '20003',
        },
      },
    }, getVaultMetadata)).toEqual([
      {
        field: 'strategy',
        label: 'Strategy',
        addresses: [{
          address: OTHER_VAULT,
          label: 'Euler USDC',
          linkKind: 'vault',
          vaultType: 'evk',
        }],
      },
      { field: 'supplied_assets', label: 'Supplied assets', value: '0.02 USDC' },
    ])
  })

  it('formats EVK config amounts as percentages and empty hooked ops as None', () => {
    expect(getActivityChangeEntries({
      type: 'set_interest_fee',
      change: { fields: { new_fee: '500' } },
    })).toEqual([{ field: 'new_fee', label: 'New fee', value: '5%' }])

    expect(getActivityChangeEntries({
      type: 'set_max_liquidation_discount',
      change: { fields: { new_discount: '350' } },
    })).toEqual([{ field: 'new_discount', label: 'New discount', value: '3.5%' }])

    expect(getActivityChangeEntries({
      type: 'set_hook_config',
      change: { fields: { new_hooked_ops: '0' } },
    })).toEqual([{ field: 'new_hooked_ops', label: 'New hooked ops', value: 'None' }])
    // Non-empty bitmasks stay raw — the operation names are not decoded.
    expect(getActivityChangeEntries({
      type: 'set_hook_config',
      change: { fields: { new_hooked_ops: '4096' } },
    })).toEqual([{ field: 'new_hooked_ops', label: 'New hooked ops', value: 'Flash loan' }])
    expect(getActivityChangeEntries({
      type: 'set_hook_config',
      change: { fields: { new_hooked_ops: '192' } },
    })).toEqual([{ field: 'new_hooked_ops', label: 'New hooked ops', value: 'Borrow, Repay' }])
    expect(getActivityChangeEntries({
      type: 'set_hook_config',
      change: { fields: { new_hooked_ops: '32768' } },
    })).toEqual([{ field: 'new_hooked_ops', label: 'New hooked ops', value: 'Unknown flags (32768)' }])
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
  })

  it('labels a viewed liquidated subaccount by position number', () => {
    expect(getPortfolioActivityPositionParticipant({
      account: VAULT,
      actor: ASSET,
      category: 'liquidations',
      counterparty: VAULT,
      owner: OTHER_VAULT,
      subAccountIndex: 7,
    })).toEqual({ index: 7, label: 'Position 7' })

    expect(getPortfolioActivityPositionParticipant({
      account: VAULT,
      actor: OTHER_VAULT,
      category: 'liquidations',
      counterparty: ASSET,
      owner: VAULT,
      subAccountIndex: 0,
    })).toBeNull()
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
    expect(getActivityAssetLabel('collateral', 'liquidations')).toBe('Collateral shares seized')
    expect(getActivityAssetAddressLabel('assets', 'liquidations')).toBe('Asset')
    expect(getActivityAssetAddressLabel('collateral', 'liquidations')).toBe('Collateral vault')
  })

  it('formats timestamps', () => {
    expect(formatActivityTimestamp('not-a-date')).toBe('-')
    expect(formatActivityTimestamp('2026-07-13T10:30:00.000Z')).toContain('13 Jul 2026')
  })

  it('formats timestamps relatively at every age', () => {
    const now = Date.parse('2026-07-13T10:30:00.000Z')
    expect(formatActivityRelativeTimestamp('not-a-date', now)).toBe('-')
    expect(formatActivityRelativeTimestamp('2026-07-13T10:29:40.000Z', now)).toBe('Just now')
    expect(formatActivityRelativeTimestamp('2026-07-13T10:05:00.000Z', now)).toBe('25 min ago')
    expect(formatActivityRelativeTimestamp('2026-07-13T04:30:00.000Z', now)).toBe('6 h ago')
    expect(formatActivityRelativeTimestamp('2026-07-10T10:30:00.000Z', now)).toBe('3 d ago')
    expect(formatActivityRelativeTimestamp('2026-07-01T10:30:00.000Z', now)).toBe('1 w ago')
    expect(formatActivityRelativeTimestamp('2026-05-13T10:30:00.000Z', now)).toBe('2 mo ago')
    expect(formatActivityRelativeTimestamp('2024-07-13T10:30:00.000Z', now)).toBe('2 y ago')
    // Future timestamps (clock skew) fall back to the absolute date.
    expect(formatActivityRelativeTimestamp('2026-07-14T10:30:00.000Z', now)).toBe('14 Jul 2026')
  })

  it('derives asset flow direction from the event type and transfer sides', () => {
    expect(getActivityAmountDirection({ type: 'deposit' })).toBe('in')
    expect(getActivityAmountDirection({ type: 'repay' })).toBe('in')
    expect(getActivityAmountDirection({ type: 'withdraw' })).toBe('out')
    expect(getActivityAmountDirection({ type: 'borrow' })).toBe('out')
    expect(getActivityAmountDirection({ type: 'set_caps' })).toBeUndefined()
    expect(getActivityAmountDirection({
      account: VAULT,
      payload: { from: VAULT, to: OTHER_VAULT },
      type: 'transfer',
    })).toBe('out')
    expect(getActivityAmountDirection({
      account: VAULT,
      payload: { from: OTHER_VAULT, to: VAULT },
      type: 'transfer',
    })).toBe('in')
    expect(getActivityAmountDirection({ type: 'transfer' })).toBeUndefined()
  })

  it('formats historical liquidation valuations for display', () => {
    const record = {
      chainId: 1,
      vault: VAULT as Address,
      violator: ASSET as Address,
      liquidator: OTHER_VAULT as Address,
      collateral: SHARES as Address,
      repayAssets: '724612',
      yieldBalance: '812035276912150036',
      debtAsset: ASSET as Address,
      debtAssetDecimals: 6,
      repayAssetsUsd: 0.7245298289992,
      collateralAsset: ASSET as Address,
      collateralAssetDecimals: 18,
      collateralAssets: '852576641882433905',
      collateralAssetsUsd: 0.8525394439635485,
      bonusUsd: 0.12800961496434857,
      unitOfAccountValuation: null,
      valuation: { status: 'available' as const },
      blockNumber: '25562800',
      txHash: `0x${'ab'.repeat(32)}` as `0x${string}`,
      timestamp: '2026-07-18T23:13:35.000Z',
    }

    expect(getActivityLiquidationDisplayDetails(record, address =>
      address === ASSET
        ? { address: ASSET as Address, symbol: 'wM', decimals: 18 }
        : undefined,
    )).toEqual({
      repayUsd: '$0.72',
      collateralAmount: '0.85 wM',
      collateralUsd: '$0.85',
      bonus: '+$0.13',
      bonusTitle: 'Collateral seized minus debt repaid, valued in event-time USD',
      bonusTone: 'positive',
    })

    // Symbol lookup misses keep the bare converted quantity.
    expect(getActivityLiquidationDisplayDetails(record).collateralAmount).toBe('0.85')

    // Money values pad cents — "$2.70", never "$2.7".
    expect(getActivityLiquidationDisplayDetails({
      ...record,
      repayAssetsUsd: 2.7,
    }).repayUsd).toBe('$2.70')

    // Unprofitable liquidations show an explicitly negative, danger-toned bonus.
    const unprofitable = getActivityLiquidationDisplayDetails({
      ...record,
      bonusUsd: -0.25,
    })
    expect(unprofitable.bonus).toBe('−$0.25')
    expect(unprofitable.bonusTone).toBe('negative')
    expect(getActivityLiquidationDisplayDetails({
      ...record,
      bonusUsd: -0.001,
    }).bonus).toBe('−<$0.01')
    const breakeven = getActivityLiquidationDisplayDetails({
      ...record,
      bonusUsd: 0,
    })
    expect(breakeven.bonus).toBe('$0.00')
    expect(breakeven.bonusTone).toBeUndefined()

    const unitOfAccountValuation = {
      source: 'historical-protocol-oracle' as const,
      unitOfAccount: USD_UNIT_OF_ACCOUNT as Address,
      unitOfAccountDecimals: 18,
      repayValue: '1000000000000000000',
      collateralValue: '2140000000000000000',
      bonusValue: '1140000000000000000',
      blockNumber: record.blockNumber,
    }
    // Event-time USD remains authoritative when both enrichments are present.
    expect(getActivityLiquidationDisplayDetails({
      ...record,
      unitOfAccountValuation,
    }).bonus).toBe('+$0.13')

    // Without USD, the protocol-oracle quote uses the sentinel denomination.
    expect(getActivityLiquidationDisplayDetails({
      ...record,
      bonusUsd: undefined,
      unitOfAccountValuation,
    })).toMatchObject({
      bonus: '+1.14 USD',
      bonusTone: 'positive',
      bonusTitle: 'Collateral seized minus debt repaid, quoted by the protocol oracle at the liquidation',
    })

    // Ordinary unit-of-account tokens resolve through existing token metadata.
    const negativeFallback = getActivityLiquidationDisplayDetails({
      ...record,
      bonusUsd: undefined,
      unitOfAccountValuation: {
        ...unitOfAccountValuation,
        unitOfAccount: ASSET as Address,
        repayValue: '1250000',
        collateralValue: '1000000',
        bonusValue: '-250000',
        unitOfAccountDecimals: 6,
      },
    }, address => address === ASSET
      ? { address: ASSET as Address, symbol: 'USDC', decimals: 6 }
      : undefined)
    expect(negativeFallback).toMatchObject({
      bonus: '−0.25 USDC',
      bonusTone: 'negative',
    })

    // An unsafe raw integer is never shown without decimals or a denomination.
    expect(getActivityLiquidationDisplayDetails({
      ...record,
      bonusUsd: undefined,
      unitOfAccountValuation: {
        ...unitOfAccountValuation,
        unitOfAccountDecimals: null,
      },
    }).bonus).toBeUndefined()
    expect(getActivityLiquidationDisplayDetails({
      ...record,
      bonusUsd: undefined,
      unitOfAccountValuation: {
        ...unitOfAccountValuation,
        unitOfAccount: OTHER_VAULT as Address,
      },
    }).bonus).toBeUndefined()

    // Fields the endpoint could not reconstruct stay absent, leaving the
    // event's own share-quantity display in place.
    const sparse = getActivityLiquidationDisplayDetails({
      ...record,
      debtAsset: undefined,
      debtAssetDecimals: undefined,
      repayAssetsUsd: undefined,
      collateralAsset: undefined,
      collateralAssetDecimals: undefined,
      collateralAssets: undefined,
      collateralAssetsUsd: undefined,
      bonusUsd: undefined,
      unitOfAccountValuation: null,
      valuation: { status: 'unavailable' as const },
    })
    expect(sparse).toEqual({})
  })
})
