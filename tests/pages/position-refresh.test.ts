import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ScriptTarget, transpileModule } from 'typescript'
import { until } from '@vueuse/core'
import { Account, Portfolio, assetDiagnosticOwner, dataIssueLocation, subAccountDiagnosticOwner, type DataIssue, type IAccountPosition } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { computed, effectScope, nextTick, ref, watch, type EffectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

const OWNER = '0x1000000000000000000000000000000000000000'
const SUB_ACCOUNT = '0x1000000000000000000000000000000000000001'
const BORROW = '0x2000000000000000000000000000000000000000'
const COLLATERAL = '0x3000000000000000000000000000000000000000'
const SECOND_COLLATERAL = '0x6000000000000000000000000000000000000000'
const ASSET = '0x4000000000000000000000000000000000000000'
const WAD = 10n ** 18n

const source = readFileSync(resolve(import.meta.dirname, '../../pages/position/[number]/index.vue'), 'utf8')
const collateralStart = source.indexOf('const loadCollaterals = async (')
const collateralEnd = source.indexOf('const disableCollateral = async (', collateralStart)
const start = source.indexOf('const load = async (')
const end = source.indexOf('const borrowApyModalData', start)
expect(collateralStart).toBeGreaterThan(0)
expect(collateralEnd).toBeGreaterThan(collateralStart)
expect(start).toBeGreaterThan(0)
expect(end).toBeGreaterThan(start)
const loader = transpileModule(`let loadSequence = 0;\n${source.slice(collateralStart, collateralEnd)}\n${source.slice(start, end)}`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText

const sourceFailure: DataIssue = {
  code: 'SOURCE_UNAVAILABLE',
  severity: 'warning',
  message: 'Failed to fetch vault account info.',
  source: 'accountLens',
  locations: [dataIssueLocation(subAccountDiagnosticOwner(1, SUB_ACCOUNT), '$.positions')],
}
const pricingFailure: DataIssue = {
  code: 'SOURCE_UNAVAILABLE',
  severity: 'warning',
  message: 'Failed to fetch market price.',
  source: 'priceService',
  locations: [dataIssueLocation(assetDiagnosticOwner(1, ASSET), '$.marketPriceUsd')],
}
const vault = (address: Address) => ({ chainId: 1, address, asset: { address: ASSET, symbol: 'TEST', decimals: 18 } })
type TestVault = ReturnType<typeof vault>
const makePosition = ({ omitted, removed, assets = 4n }: { omitted?: Address, removed?: Address, assets?: bigint } = {}) => {
  const enabledCollaterals = [COLLATERAL, SECOND_COLLATERAL].filter(address => address !== removed) as Address[]
  const values = (value: bigint) => ({ borrowing: value * WAD, liquidation: value * WAD, oracleMid: value * WAD })
  const account = new Account<TestVault>({
    chainId: 1, owner: OWNER, populated: { vaults: true, marketPrices: true },
    subAccounts: { [SUB_ACCOUNT]: {
      account: SUB_ACCOUNT, owner: OWNER, timestamp: 1, lastAccountStatusCheckTimestamp: 1,
      enabledControllers: [BORROW], enabledCollaterals,
      positions: [
        ...enabledCollaterals.filter(address => address !== omitted).map<IAccountPosition<TestVault>>(address => ({
          account: SUB_ACCOUNT, vaultAddress: address, vault: vault(address), asset: ASSET,
          assets, shares: assets, borrowed: 0n, isCollateral: true, isController: false, balanceForwarderEnabled: false,
        })),
        {
          account: SUB_ACCOUNT, vaultAddress: BORROW, vault: vault(BORROW), asset: ASSET,
          assets: 0n, shares: 0n, borrowed: 1n, isCollateral: false, isController: true, balanceForwarderEnabled: false,
          liquidity: {
            vaultAddress: BORROW, unitOfAccount: ASSET, daysToLiquidation: 'Infinity',
            liabilityValue: values(1n), totalCollateralValue: values(BigInt(enabledCollaterals.length) * assets),
            collaterals: enabledCollaterals.map(address => ({ address, value: values(assets) })),
          },
        },
      ],
    } },
  })
  return new Portfolio(account).borrows[0]!
}
type TestPosition = ReturnType<typeof makePosition>
let scope: EffectScope | undefined

// Exercise the page's loaders and disappearance watcher with SDK portfolio positions.
const setupPage = (initial: TestPosition | null = makePosition()) => {
  const position = ref<TestPosition | undefined>(initial ?? undefined)
  const getPositionBySubAccountIndex = vi.fn<() => TestPosition | undefined>(() => initial ?? undefined)
  const portfolioDiagnostics = ref<DataIssue[]>([])
  const router = { replace: vi.fn() }
  const collateralItems = ref<{ vault: TestVault, assets: bigint }[]>([])
  const bindings = {
    ref, watch, until, getAddress, position, router, portfolioDiagnostics, getPositionBySubAccountIndex, collateralItems,
    isConnected: ref(true), isSpyMode: ref(false), isSimulating: ref(false),
    _route: { params: { number: '1' }, query: { network: '1' } },
    isPositionsLoaded: ref(true), isPositionsLoading: ref(false),
    isVaultsReady: ref(true), isCollateralsLoading: ref(false), getOrFetch: vi.fn(),
    getCurrentRoutePositionIndex: () => '1',
    collateralVault: computed(() => position.value?.collateralVault),
    primaryCollateralAddress: computed(() => position.value?.collateralVault?.address ?? ''),
    positionCollateralAddresses: computed(() => position.value?.collateralVaults ?? []),
    hasQueryFailure: ref(false), showError: vi.fn(),
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
    await page.load()
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

  it.each([COLLATERAL, SECOND_COLLATERAL] as const)('retains both collateral rows when the SDK omits %s', async (omitted) => {
    const page = setupPage()
    await page.load()
    const previousPosition = page.position.value
    const previousCollaterals = page.collateralItems.value
    const partial = makePosition({ omitted })
    expect(partial.borrow.liquidity?.collaterals.map(item => item.address)).toContain(omitted)
    expect(partial.collateralVaults).not.toContain(omitted)
    page.getPositionBySubAccountIndex.mockReturnValue(partial)
    page.portfolioDiagnostics.value = [sourceFailure]

    await page.load({ silent: true })

    expect(page.position.value).toBe(previousPosition)
    expect(page.collateralItems.value).toBe(previousCollaterals)
    expect(page.collateralItems.value.map(item => item.vault.address)).toEqual([COLLATERAL, SECOND_COLLATERAL])
    expect(page.router.replace).not.toHaveBeenCalled()

    page.portfolioDiagnostics.value = []
    page.getPositionBySubAccountIndex.mockReturnValue(makePosition({ assets: 8n }))
    await page.load({ silent: true })
    expect(page.collateralItems.value.map(item => item.assets)).toEqual([8n, 8n])

    page.getPositionBySubAccountIndex.mockReturnValue(makePosition({ removed: omitted }))
    await page.load({ silent: true })
    expect(page.collateralItems.value).toHaveLength(1)
    expect(page.collateralItems.value[0]?.vault.address).not.toBe(omitted)
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

  it.each([
    ['pricing', pricingFailure],
    ['another sub-account', { ...sourceFailure, locations: [dataIssueLocation(subAccountDiagnosticOwner(1, OWNER), '$.positions')] }],
    ['rewards', { ...sourceFailure, locations: [dataIssueLocation(subAccountDiagnosticOwner(1, SUB_ACCOUNT), '$.rewardStreams')] }],
  ] satisfies [string, DataIssue][])('updates balances and closed collaterals when %s fails', async (_name, diagnostic) => {
    const page = setupPage()
    await page.load()
    const updated = makePosition({ assets: 8n, removed: SECOND_COLLATERAL })
    page.getPositionBySubAccountIndex.mockReturnValue(updated)
    page.portfolioDiagnostics.value = [diagnostic]

    await page.load({ silent: true })
    await nextTick()

    expect(page.position.value?.healthFactor).toBe(updated.healthFactor)
    expect(page.collateralItems.value).toHaveLength(1)
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
