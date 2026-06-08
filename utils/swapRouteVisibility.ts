import type { SwapRouteItem } from '~/utils/swapRouteItems'

export const SWAP_ROUTE_VISIBLE_COUNT = 3

export const isGaslessSwapRouteItem = (item: Pick<SwapRouteItem, 'isGasless'>) => !!item.isGasless

export const getVisibleSwapRouteItems = (
  items: SwapRouteItem[],
  options: {
    expanded: boolean
    promoteGasless: boolean
    visibleCount?: number
  },
) => {
  const visibleCount = options.visibleCount ?? SWAP_ROUTE_VISIBLE_COUNT
  if (options.expanded) return items

  const top = items.slice(0, visibleCount)
  if (!options.promoteGasless || top.some(isGaslessSwapRouteItem)) return top

  const gasless = items.find(isGaslessSwapRouteItem)
  if (!gasless) return top

  return top.length >= visibleCount
    ? [...top.slice(0, visibleCount - 1), gasless]
    : [...top, gasless]
}
