import { useModal } from '~/components/ui/composables/useModal'
import { UiCustomFilterModal } from '#components'
import type { CustomFilter, FilterMetricOption, FilterMetricUnit } from '~/components/ui/modals/customFilter.types'

export type { CustomFilter, FilterMetricOption, FilterMetricUnit }

export const useCustomFilters = <T>(
  metrics: FilterMetricOption[],
  getValue: (item: T, metric: string) => number | undefined,
  initialFilters: CustomFilter[] = [],
) => {
  const modal = useModal()
  const customFilters = ref<CustomFilter[]>([...initialFilters])

  const addCustomFilter = (filter: CustomFilter) => {
    const filtersWithoutReplacedDefaults = customFilters.value.filter(existing =>
      !(existing.tone === 'neutral' && existing.metric === filter.metric),
    )
    customFilters.value = [...filtersWithoutReplacedDefaults, filter]
  }

  const removeCustomFilter = (id: string) => {
    const removedFilter = customFilters.value.find(f => f.id === id)
    const nextFilters = customFilters.value.filter(f => f.id !== id)
    const neutralDefault = removedFilter && removedFilter.tone !== 'neutral'
      ? initialFilters.find(f => f.tone === 'neutral' && f.metric === removedFilter.metric)
      : undefined

    customFilters.value = neutralDefault && !nextFilters.some(f => f.metric === neutralDefault.metric)
      ? [...nextFilters, neutralDefault]
      : nextFilters
  }

  const clearCustomFilters = () => {
    customFilters.value = [...initialFilters]
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
    if (!customFilters.value.length) return true
    return customFilters.value.every((f) => {
      const val = getValue(item, f.metric)
      if (typeof val !== 'number' || !Number.isFinite(val)) return f.includeWhenValueUnavailable === true
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
