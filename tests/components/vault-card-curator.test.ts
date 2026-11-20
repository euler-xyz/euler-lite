import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Component } from 'vue'
import type { EulerEarn, EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import VaultItem from '~/components/entities/vault/VaultItem.vue'
import VaultEarnItem from '~/components/entities/vault/VaultEarnItem.vue'
import SecuritizeVaultItem from '~/components/entities/vault/SecuritizeVaultItem.vue'
import VaultBorrowItem from '~/components/entities/vault/VaultBorrowItem.vue'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import {
  EBOLD_1,
  EUSDC_42,
  LIQUITY_HUB_ENTITY,
  LIQUITY_HUB_GOVERNOR,
  LIQUITY_HUB_PRODUCT,
  USDC,
  liquityHubHiddenVerdict,
  makeEbold1,
  makeEusdc42,
} from '~/tests/fixtures/liquity-hub'
import {
  EARN_STRATEGY_FAILED,
  EARN_STRATEGY_FAILED_RAW_ASSESSMENT,
  EARN_STRATEGY_FAILED_VERDICT,
  EARN_TIMELOCK_FAILED,
  EARN_TIMELOCK_FAILED_RAW_ASSESSMENT,
  EARN_TIMELOCK_FAILED_VERDICT,
  EUSDC_42_RAW_ASSESSMENT,
  IDLE_CREDIT_VAULT,
  IDLE_CREDIT_VAULT_RAW_ASSESSMENT,
  IDLE_CREDIT_VAULT_VERDICT,
  IDLE_ENTITY,
  IDLE_GOVERNOR,
  IDLE_PRODUCT,
  assessmentEntry,
  makeIdleCreditVault,
} from '~/tests/fixtures/v3-hidden-vault-assessments'
import {
  curatorStates,
  disclosureCounts,
  ensuredAddresses,
  renderCard,
  setCardLabels,
  stubCardGlobals,
  type CardLabels,
} from '~/tests/components/vault-card-curator.harness'

vi.mock('#components', () => ({ VaultApyModal: {}, VaultMaxRoeModal: {}, VaultNetApyPairModal: {}, UiModalPreviewTrigger: { render: () => null } }))
vi.mock('~/utils/sdk-prices', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/sdk-prices')>()),
  formatAssetValue: async () => ({ hasPrice: false, usdValue: 0, display: '-' }),
}))

const K3 = 'curator:K3 Capital'
const BOTH_UNKNOWN = ['unknown', 'unknown']
const EARN_CURATOR = 'earn-curator'
const EARN_OWNER = getAddress('0x00000000000000000000000000000000000000e1')

const k3 = { name: 'K3 Capital', addresses: { [LIQUITY_HUB_GOVERNOR]: 'K3 governor' } }
const idle = { name: 'Idle DAO', addresses: { [IDLE_GOVERNOR]: 'Idle DAO Limited Governor' } }
const earnCurator = { name: 'Earn Curator', addresses: { [EARN_OWNER]: 'Earn owner' } }

const visibleVerdict = { status: 'visible', decidedBy: 'verified', reason: null, explorableLend: true, explorableBorrow: true }

const labelsFor = (verdicts: Record<string, unknown>, entries: CardLabels['entries'] = {}, verified: string[] = []): CardLabels => ({
  verdicts,
  entries,
  entities: { [LIQUITY_HUB_ENTITY]: k3, [IDLE_ENTITY]: idle, [EARN_CURATOR]: earnCurator },
  products: {
    [LIQUITY_HUB_PRODUCT]: { name: 'Liquity Hub', entity: LIQUITY_HUB_ENTITY, vaults: [EUSDC_42, EBOLD_1] },
    [IDLE_PRODUCT]: { name: 'Idle Credit Vaults', entity: IDLE_ENTITY, vaults: [IDLE_CREDIT_VAULT] },
    [EARN_CURATOR]: { name: 'Earn Curator Vaults', entity: EARN_CURATOR, vaults: [EARN_STRATEGY_FAILED, EARN_TIMELOCK_FAILED] },
  },
  managingEntityByVault: {
    [EUSDC_42.toLowerCase()]: LIQUITY_HUB_ENTITY,
    [EBOLD_1.toLowerCase()]: LIQUITY_HUB_ENTITY,
    [IDLE_CREDIT_VAULT.toLowerCase()]: IDLE_ENTITY,
    [EARN_STRATEGY_FAILED.toLowerCase()]: EARN_CURATOR,
    [EARN_TIMELOCK_FAILED.toLowerCase()]: EARN_CURATOR,
  },
  verifiedVaultAddresses: verified,
})

const pausedEusdc42 = (entry: { status: string } = assessmentEntry(EUSDC_42_RAW_ASSESSMENT)) =>
  labelsFor({ [EUSDC_42.toLowerCase()]: liquityHubHiddenVerdict() }, { [EUSDC_42.toLowerCase()]: entry })
const deprecatedGovernorIdle = () => labelsFor(
  { [IDLE_CREDIT_VAULT.toLowerCase()]: IDLE_CREDIT_VAULT_VERDICT },
  { [IDLE_CREDIT_VAULT.toLowerCase()]: assessmentEntry(IDLE_CREDIT_VAULT_RAW_ASSESSMENT, { verdict: IDLE_CREDIT_VAULT_VERDICT }) },
)
const listedEusdc42 = () => labelsFor({ [EUSDC_42.toLowerCase()]: visibleVerdict }, {}, [EUSDC_42])

const asSecuritize = (vault: EVault, governor: string) =>
  ({ ...vault, type: 'SecuritizeCollateral', governor }) as unknown as SecuritizeCollateralVault

const makeEarn = (address: string) => ({
  type: 'EulerEarn',
  chainId: 1,
  address,
  asset: USDC,
  shares: { address, symbol: 'eaUSDC', decimals: 6, name: 'Earn USDC' },
  governance: { owner: EARN_OWNER, curator: EARN_OWNER, guardian: EARN_OWNER, timelock: 86_400 },
  strategies: [],
  totalAssets: 0n,
  availableAssets: 0n,
  performanceFee: 0,
}) as unknown as EulerEarn

type CardCase = {
  name: string
  component: Component
  hidden: { props: Record<string, unknown>, labels: (entry?: { status: string }) => CardLabels, loads: string[] }
  governanceFailing: { props: Record<string, unknown>, labels: () => CardLabels }
  visible: { props: Record<string, unknown>, labels: () => CardLabels }
}

const pausedPair = (entry?: { status: string }) => {
  const clear = entry ?? assessmentEntry(EUSDC_42_RAW_ASSESSMENT)
  const eboldEntry = entry ?? assessmentEntry({ ...EUSDC_42_RAW_ASSESSMENT, vaultAddress: EBOLD_1 })
  return labelsFor(
    { [EUSDC_42.toLowerCase()]: liquityHubHiddenVerdict(), [EBOLD_1.toLowerCase()]: liquityHubHiddenVerdict() },
    { [EUSDC_42.toLowerCase()]: clear, [EBOLD_1.toLowerCase()]: eboldEntry },
  )
}
const pair = (collateral: EVault, borrow: EVault) => ({ pair: { collateral, borrow, ltv: { borrowLTV: 0.9 } } })

const CARDS: CardCase[] = [
  {
    name: 'VaultItem',
    component: VaultItem,
    hidden: { props: { vault: makeEusdc42() }, labels: pausedEusdc42, loads: [EUSDC_42] },
    governanceFailing: { props: { vault: makeIdleCreditVault() }, labels: deprecatedGovernorIdle },
    visible: { props: { vault: makeEusdc42() }, labels: listedEusdc42 },
  },
  {
    name: 'SecuritizeVaultItem',
    component: SecuritizeVaultItem,
    hidden: { props: { vault: asSecuritize(makeEusdc42(), LIQUITY_HUB_GOVERNOR) }, labels: pausedEusdc42, loads: [EUSDC_42] },
    governanceFailing: { props: { vault: asSecuritize(makeIdleCreditVault(), IDLE_GOVERNOR) }, labels: deprecatedGovernorIdle },
    visible: { props: { vault: asSecuritize(makeEusdc42(), LIQUITY_HUB_GOVERNOR) }, labels: listedEusdc42 },
  },
  {
    name: 'VaultBorrowItem',
    component: VaultBorrowItem,
    hidden: { props: pair(makeEbold1(), makeEusdc42()), labels: pausedPair, loads: [EBOLD_1, EUSDC_42] },
    governanceFailing: {
      props: pair(makeEusdc42(), makeIdleCreditVault()),
      labels: () => {
        const labels = pausedEusdc42()
        const idleLabels = deprecatedGovernorIdle()
        return { ...labels, verdicts: { ...labels.verdicts, ...idleLabels.verdicts }, entries: { ...labels.entries, ...idleLabels.entries } }
      },
    },
    visible: {
      props: pair(makeEbold1(), makeEusdc42()),
      labels: () => labelsFor({ [EUSDC_42.toLowerCase()]: visibleVerdict, [EBOLD_1.toLowerCase()]: visibleVerdict }, {}, [EUSDC_42, EBOLD_1]),
    },
  },
]

const EARN_CARD = {
  name: 'VaultEarnItem',
  component: VaultEarnItem,
  hidden: {
    props: { vault: makeEarn(EARN_STRATEGY_FAILED) },
    labels: (entry: { status: string } = assessmentEntry(EARN_STRATEGY_FAILED_RAW_ASSESSMENT, { verdict: EARN_STRATEGY_FAILED_VERDICT, family: 'earn' })) =>
      labelsFor({ [EARN_STRATEGY_FAILED.toLowerCase()]: EARN_STRATEGY_FAILED_VERDICT }, { [EARN_STRATEGY_FAILED.toLowerCase()]: entry }),
    loads: [EARN_STRATEGY_FAILED],
  },
  governanceFailing: {
    props: { vault: makeEarn(EARN_TIMELOCK_FAILED) },
    labels: () => labelsFor(
      { [EARN_TIMELOCK_FAILED.toLowerCase()]: EARN_TIMELOCK_FAILED_VERDICT },
      { [EARN_TIMELOCK_FAILED.toLowerCase()]: assessmentEntry(EARN_TIMELOCK_FAILED_RAW_ASSESSMENT, { verdict: EARN_TIMELOCK_FAILED_VERDICT, family: 'earn' }) },
    ),
  },
  visible: {
    props: { vault: makeEarn(EARN_STRATEGY_FAILED) },
    labels: () => labelsFor({ [EARN_STRATEGY_FAILED.toLowerCase()]: visibleVerdict }, {}, [EARN_STRATEGY_FAILED]),
  },
} satisfies CardCase

beforeEach(() => stubCardGlobals())

describe('curator cell of a borrow pair with one listed side', () => {
  const listedCollateralPausedBorrow = (entry?: { status: string }) => labelsFor(
    { [EBOLD_1.toLowerCase()]: visibleVerdict, [EUSDC_42.toLowerCase()]: liquityHubHiddenVerdict() },
    { [EUSDC_42.toLowerCase()]: entry ?? assessmentEntry(EUSDC_42_RAW_ASSESSMENT) },
    [EBOLD_1],
  )

  it('names the curator once the hidden side is identified, without the curator details of a listed pair', async () => {
    setCardLabels(listedCollateralPausedBorrow())
    const html = await renderCard(VaultBorrowItem, pair(makeEbold1(), makeEusdc42()))
    expect(curatorStates(html)).toEqual([K3, K3])
    expect(disclosureCounts(html).every(count => count === 0)).toBe(true)
    expect(ensuredAddresses()).toEqual([EUSDC_42.toLowerCase()])
  })

  it.each([['loading', { status: 'loading' }], ['unavailable', { status: 'unavailable' }]])(
    'keeps Unknown while the hidden side\'s assessment is %s',
    async (_label, entry) => {
      setCardLabels(listedCollateralPausedBorrow(entry))
      expect(curatorStates(await renderCard(VaultBorrowItem, pair(makeEbold1(), makeEusdc42())))).toEqual(BOTH_UNKNOWN)
    },
  )

  it('keeps Unknown when the assessment was read under an earlier verdict', async () => {
    setCardLabels(listedCollateralPausedBorrow(assessmentEntry(EUSDC_42_RAW_ASSESSMENT, { verdict: liquityHubHiddenVerdict('config-failed') })))
    expect(curatorStates(await renderCard(VaultBorrowItem, pair(makeEbold1(), makeEusdc42())))).toEqual(BOTH_UNKNOWN)
  })
})

afterEach(() => {
  useVaultRegistry().clear()
  vi.unstubAllGlobals()
})

describe.each([...CARDS, EARN_CARD])('curator cell of $name, desktop and mobile', (card) => {
  const curatorName = card === EARN_CARD ? 'curator:Earn Curator' : K3
  const render = async (props: Record<string, unknown>, labels: CardLabels) => {
    setCardLabels(labels)
    return renderCard(card.component, props)
  }

  it('names the curator of a vault hidden for a non-governance reason once its assessment proves it', async () => {
    const html = await render(card.hidden.props, card.hidden.labels())
    expect(curatorStates(html)).toEqual([curatorName, curatorName])
    expect(disclosureCounts(html).every(count => count === 0)).toBe(true)
  })

  it('keeps Unknown when the assessment shows a governance cause', async () => {
    const html = await render(card.governanceFailing.props, card.governanceFailing.labels())
    expect(curatorStates(html)).toEqual(BOTH_UNKNOWN)
  })

  it('keeps Unknown while the assessment loads', async () => {
    const html = await render(card.hidden.props, card.hidden.labels({ status: 'loading' }))
    expect(curatorStates(html)).toEqual(BOTH_UNKNOWN)
  })

  it('leaves a listed vault as it was, with its curator details', async () => {
    const html = await render(card.visible.props, card.visible.labels())
    expect(curatorStates(html)).toEqual([curatorName, curatorName])
    expect(disclosureCounts(html)[0]).toBeGreaterThan(0)
  })

  it('loads the assessment once for each hidden vault and never for a listed one', async () => {
    await render(card.hidden.props, card.hidden.labels())
    expect(ensuredAddresses().sort()).toEqual(card.hidden.loads.map(address => address.toLowerCase()).sort())

    stubCardGlobals()
    await render(card.visible.props, card.visible.labels())
    expect(ensuredAddresses()).toEqual([])
  })
})
