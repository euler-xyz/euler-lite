import { useModal } from '~/components/ui/composables/useModal'
import { UiCustomFilterModal } from '#components'
import type { CustomFilter, FilterMetricOption, FilterMetricUnit } from '~/components/ui/modals/customFilter.types'

export type { CustomFilter, FilterMetricOption, FilterMetricUnit }

export const useCustomFilters = <T>(
  metrics: FilterMetricOption[],
  getValue: (item: T, metric: string) => number,
  initialFilters: CustomFilter[] = [],
) => {
  const modal = useModal()
  const customFilters = ref<CustomFilter[]>([])

  const addCustomFilter = (filter: CustomFilter) => {
    customFilters.value = [...customFilters.value, filter]
  }

  const removeCustomFilter = (id: string) => {
    customFilters.value = customFilters.value.filter(f => f.id !== id)
  }

  const clearCustomFilters = () => {
    customFilters.value = []
  }

  const openCustomFilterModal = () => {
    modal.open(UiCustomFilterModal, {
      props: {
        metrics,
        onAdd: addCustomFilter,
      },
    })
  }

  const matchesCustomFilters = (item: T): boolean => {
    const filters = [...initialFilters, ...customFilters.value]
    if (!filters.length) return true
    return filters.every((f) => {
      const val = getValue(item, f.metric)
      if (typeof val !== 'number' || !Number.isFinite(val)) return false
      return f.operator === 'gt' ? val > f.value : val < f.value
    })
  }

  return {
    customFilters: readonly(customFilters),
    addCustomFilter,
    removeCustomFilter,
    clearCustomFilters,
    openCustomFilterModal,
    matchesCustomFilters,
  }
}
