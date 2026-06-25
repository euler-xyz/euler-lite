export type FilterMetricUnit = 'usd' | 'percent' | 'multiplier'

export interface FilterMetricOption {
  key: string
  label: string
  shortLabel: string
  unit: FilterMetricUnit
}

export interface CustomFilter {
  id: string
  metric: string
  operator: 'gt' | 'lt'
  value: number
  label: string
  includeWhenValueUnavailable?: boolean
}
