import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const sourcesIn = (directory: string): string[] => readdirSync(resolve(root, directory), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory()
    ? sourcesIn(`${directory}/${entry.name}`)
    : /\.(?:ts|vue)$/.test(entry.name) ? [`${directory}/${entry.name}`] : [])
const appSources = ['composables', 'pages', 'components', 'features', 'utils', 'plugins']
  .flatMap(sourcesIn)
  .filter(path => !path.startsWith('composables/cowswap/'))
const consumersOf = (symbol: string) => appSources.filter(path => read(path).includes(`${symbol}(`)).sort()

// CoW orders skip reviewed execution, so these form guards are the only gate that keeps an exit-only address out.
describe('CoW execution for an exit-only address', () => {
  it('opens a position or swaps collateral only from the two guarded flows', () => {
    expect(consumersOf('useCowSwapOpenPositionExecution')).toEqual(['composables/borrow/useMultiplyCowSwap.ts'])
    expect(consumersOf('useCowSwapCollateralSwapExecution')).toEqual(['pages/position/[number]/borrow/swap.vue'])
  })

  it('keeps closing a position, which only reduces exposure, in the collateral repay flow', () => {
    expect(consumersOf('useCowSwapClosePositionExecution')).toEqual(['composables/repay/useCollateralSwapRepay.ts'])
  })

  it('guards the multiply CoW branch with the geo block of the pair', () => {
    const form = read('composables/borrow/useMultiplyForm.ts')
    const guard = form.indexOf('isMultiplyPreparing.value || isGeoBlocked.value')
    expect(guard).toBeGreaterThan(-1)
    expect(form.indexOf('await submitCowSwapMultiply()')).toBeGreaterThan(guard)
    expect(read('pages/borrow/[collateral]/[borrow]/index.vue'))
      .toContain('const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(collateralAddress, borrowAddress))')
  })

  it('guards the refinance CoW branch with the geo block of every vault involved', () => {
    const page = read('pages/position/[number]/borrow/swap.vue')
    const guard = page.indexOf('if (isPreparing.value || isGeoBlocked.value || isSubmitDisabled.value) return')
    expect(guard).toBeGreaterThan(-1)
    expect(page.indexOf('await submitCowSwapCollateralSwap()')).toBeGreaterThan(guard)
    expect(page).toContain('const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(...getOperationVaultAddresses()))')
  })

  it.each([
    ['composables/borrow/useBorrowForm.ts', 'isPreparing.value || isGeoBlocked.value'],
    ['composables/useSwapPageLogic.ts', 'isPreparing.value || isGeoBlocked.value'],
    ['pages/position/[number]/multiply.vue', 'isPreparing.value || isGeoBlocked.value'],
  ])('keeps the geo guard on the reviewed flow in %s', (path, guard) => {
    expect(read(path)).toContain(guard)
  })
})
