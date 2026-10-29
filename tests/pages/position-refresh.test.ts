import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ScriptTarget, transpileModule } from 'typescript'
import { until } from '@vueuse/core'
import { dataIssueLocation, subAccountDiagnosticOwner, type DataIssue } from '@eulerxyz/euler-v2-sdk'
import { effectScope, nextTick, ref, watch, type EffectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, '../../pages/position/[number]/index.vue'), 'utf8')
const start = source.indexOf('const load = async (')
const end = source.indexOf('const borrowApyModalData', start)
expect(start).toBeGreaterThan(0)
expect(end).toBeGreaterThan(start)
const loader = transpileModule(`let loadSequence = 0;\n${source.slice(start, end)}`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText

type TestPosition = { healthFactor: bigint, supplied: bigint }
const sourceFailure: DataIssue = {
  code: 'SOURCE_UNAVAILABLE',
  severity: 'warning',
  message: 'Failed to fetch a controller position.',
  source: 'accountLens',
  locations: [dataIssueLocation(subAccountDiagnosticOwner(1, '0x1000000000000000000000000000000000000001'), '$.positions')],
}
let scope: EffectScope | undefined

// Run the page's loader and disappearance watcher with network and UI bindings
// supplied by the test, so redirects and retained position state are exercised.
const setupPage = (initial: TestPosition | null = { healthFactor: 4n, supplied: 10n }) => {
  const position = ref<TestPosition | undefined>(initial ?? undefined)
  const getPositionBySubAccountIndex = vi.fn<() => TestPosition | undefined>(() => initial ?? undefined)
  const portfolioDiagnostics = ref<DataIssue[]>([])
  const router = { replace: vi.fn() }
  const vault = { address: 'collateral' }
  const collateralItems = ref(initial ? [{ vault, assets: initial.supplied }] : [])
  const bindings = {
    ref, watch, until, position, router, portfolioDiagnostics, getPositionBySubAccountIndex, collateralItems,
    isConnected: ref(true), isSpyMode: ref(false), isSimulating: ref(false),
    _route: { params: { number: '1' }, query: { network: '1' } },
    isPositionsLoaded: ref(true), isPositionsLoading: ref(false),
    getCurrentRoutePositionIndex: () => '1', collateralVault: ref(vault),
    positionCollateralAddresses: ref(['collateral']), hasQueryFailure: ref(false),
    loadCollaterals: vi.fn(async () => {}), showError: vi.fn(),
  }
  const factory = new Function('bindings', `const { ${Object.keys(bindings).join(', ')} } = bindings;\n${loader}\nreturn load;`)
  scope = effectScope()
  const load = scope.run(() => factory(bindings)) as (options?: { silent?: boolean }) => Promise<void>
  return { ...bindings, load }
}

afterEach(() => {
  scope?.stop()
})

describe('position page background refresh', () => {
  it('retains the displayed position and collaterals when a partial read omits the position', async () => {
    const page = setupPage()
    const previousPosition = page.position.value
    const previousCollaterals = page.collateralItems.value
    page.getPositionBySubAccountIndex.mockReturnValue(undefined)
    page.portfolioDiagnostics.value = [sourceFailure]

    await page.load({ silent: true })
    await nextTick()

    expect(page.position.value).toBe(previousPosition)
    expect(page.collateralItems.value).toBe(previousCollaterals)
    expect(page.router.replace).not.toHaveBeenCalled()
  })

  it('returns to the portfolio when a complete read confirms the displayed position is gone', async () => {
    const page = setupPage()
    page.getPositionBySubAccountIndex.mockReturnValue(undefined)

    await page.load({ silent: true })
    await nextTick()

    expect(page.position.value).toBeUndefined()
    expect(page.collateralItems.value).toEqual([])
    expect(page.router.replace).toHaveBeenCalledWith({ path: '/portfolio', query: { network: '1' } })
  })

  it('updates a present position even when another data source failed', async () => {
    const page = setupPage()
    page.getPositionBySubAccountIndex.mockReturnValue({ healthFactor: 2n, supplied: 8n })
    page.portfolioDiagnostics.value = [sourceFailure]

    await page.load({ silent: true })
    await nextTick()

    expect(page.position.value?.healthFactor).toBe(2n)
    expect(page.collateralItems.value[0]?.assets).toBe(8n)
    expect(page.router.replace).not.toHaveBeenCalled()
  })

  it('keeps the not-found state for an invalid position URL', async () => {
    const missingPage = setupPage(null)
    missingPage.getPositionBySubAccountIndex.mockReturnValue(undefined)
    await missingPage.load()
    await nextTick()

    expect(missingPage.position.value).toBeUndefined()
    expect(missingPage.router.replace).not.toHaveBeenCalled()
  })
})
