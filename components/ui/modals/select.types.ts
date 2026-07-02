export interface SelectOption {
  label: string
  value: string
  icon?: string
  iconName?: string
  iconFallback?: string
  quickFilterValues?: string[]
}

export interface SelectQuickFilter {
  label: string
  value: string
}
