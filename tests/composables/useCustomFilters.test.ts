import { describe, expect, it, vi } from 'vitest'
import { useCustomFilters, type CustomFilter } from '~/composables/useCustomFilters'

vi.mock('#components', () => ({
  UiCustomFilterModal: {},
}))

vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({ open: vi.fn() }),
}))

type Market = {
  liquidity?: number
  apy?: number
}

const initialLiquidityFilter: CustomFilter = {
  id: 'borrow-min-liquidity-usd',
  metric: 'liquidity',
  operator: 'gt',
  value: 1000,
  label: 'Avail. liquidity > $1K',
  includeWhenValueUnavailable: true,
}

describe('useCustomFilters', () => {
  it('shows initial filters as active filters and resets back to them', () => {
    const {
      customFilters,
      addCustomFilter,
      removeCustomFilter,
      clearCustomFilters,
      matchesCustomFilters,
    } = useCustomFilters<Market>(
      [
        { key: 'liquidity', label: 'Available liquidity', shortLabel: 'Avail. liquidity', unit: 'usd' },
        { key: 'apy', label: 'APY', shortLabel: 'APY', unit: 'percent' },
      ],
      (market, metric) => market[metric as keyof Market],
      [initialLiquidityFilter],
    )

    expect(customFilters.value).toEqual([initialLiquidityFilter])
    expect(matchesCustomFilters({ liquidity: 1500 })).toBe(true)
    expect(matchesCustomFilters({ liquidity: 500 })).toBe(false)

    removeCustomFilter(initialLiquidityFilter.id)
    expect(customFilters.value).toEqual([])
    expect(matchesCustomFilters({ liquidity: 500 })).toBe(true)

    addCustomFilter({
      id: 'apy-floor',
      metric: 'apy',
      operator: 'gt',
      value: 5,
      label: 'APY > 5%',
    })

    clearCustomFilters()
    expect(customFilters.value).toEqual([initialLiquidityFilter])
  })
})
