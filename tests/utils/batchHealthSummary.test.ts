import { describe, expect, it } from 'vitest'
import type { Portfolio, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { buildBatchHealthSummary } from '~/utils/batchHealthSummary'

const WAD = 10n ** 18n
const subAccount = getAddress('0x8A54C278D117854486db0F6460D901a180Fff517')
const otherSubAccount = getAddress('0x7B54C278D117854486db0F6460D901a180Fff516')
const oldController = getAddress('0x1111111111111111111111111111111111111111')
const newController = getAddress('0x2222222222222222222222222222222222222222')
const collateralVault = getAddress('0x3333333333333333333333333333333333333333')

const changedKey = (
  vault: Address,
  account: Address = subAccount,
): string => `${account.toLowerCase()}:${vault.toLowerCase()}`

const borrowPosition = (
  controller: Address,
  healthFactor: bigint,
  options: {
    account?: Address
    collateralVaults?: Address[]
  } = {},
): PortfolioBorrowPosition<VaultEntity> => ({
  subAccount: options.account ?? subAccount,
  healthFactor,
  borrowVault: { address: controller } as VaultEntity,
  borrow: { vaultAddress: controller } as PortfolioBorrowPosition<VaultEntity>['borrow'],
  collateralVaults: options.collateralVaults ?? [],
  collaterals: (options.collateralVaults ?? []).map(vaultAddress => ({ vaultAddress })),
} as PortfolioBorrowPosition<VaultEntity>)

const portfolio = (
  controller: Address,
  healthFactor: bigint,
): Portfolio<VaultEntity> => ({
  borrows: [borrowPosition(controller, healthFactor)],
  account: {
    getSubAccount: () => ({
      enabledControllers: [controller],
    }),
  },
} as unknown as Portfolio<VaultEntity>)

const unknownHealthPortfolio = (): Portfolio<VaultEntity> => ({
  borrows: [{
    ...borrowPosition(oldController, 0n),
    healthFactor: undefined,
  }],
  account: {
    getSubAccount: () => ({
      enabledControllers: [oldController],
    }),
  },
} as unknown as Portfolio<VaultEntity>)

const positionTag = () => 'Position 1'

describe('buildBatchHealthSummary', () => {
  it('shows before and after health when the controller is unchanged', () => {
    expect(buildBatchHealthSummary({
      basePortfolio: portfolio(oldController, 2n * WAD),
      finalPortfolio: portfolio(oldController, 3n * WAD),
      positionTag,
    })).toEqual([{
      label: 'Position 1',
      before: '2.00',
      after: '3.00',
    }])
  })

  it('treats a matching sub-account with a different controller as a new position', () => {
    expect(buildBatchHealthSummary({
      basePortfolio: portfolio(oldController, 2n * WAD),
      finalPortfolio: portfolio(newController, 3n * WAD),
      positionTag,
    })).toEqual([{
      label: 'Position 1',
      after: '3.00',
    }])
  })

  it('omits unchanged health for the same controller', () => {
    expect(buildBatchHealthSummary({
      basePortfolio: portfolio(oldController, 2n * WAD),
      finalPortfolio: portfolio(oldController, 2n * WAD),
      positionTag,
    })).toEqual([])
  })

  it('omits positions whose health is unknown before and after', () => {
    expect(buildBatchHealthSummary({
      basePortfolio: unknownHealthPortfolio(),
      finalPortfolio: unknownHealthPortfolio(),
      positionTag,
    })).toEqual([])
  })

  it('omits raw health changes for positions the batch did not touch', () => {
    expect(buildBatchHealthSummary({
      basePortfolio: portfolio(oldController, 2n * WAD),
      finalPortfolio: portfolio(oldController, 3n * WAD),
      changedPositionKeys: new Set([changedKey(newController, otherSubAccount)]),
      positionTag,
    })).toEqual([])
  })

  it('omits touched positions when the displayed health does not change', () => {
    expect(buildBatchHealthSummary({
      basePortfolio: portfolio(oldController, 1021_000_000_000_000_000n),
      finalPortfolio: portfolio(oldController, 1024_000_000_000_000_000n),
      changedPositionKeys: new Set([changedKey(oldController)]),
      positionTag,
    })).toEqual([])
  })

  it('shows health changes caused by collateral removed from the final position', () => {
    const basePortfolio = {
      borrows: [borrowPosition(oldController, 2n * WAD, { collateralVaults: [collateralVault] })],
      account: {
        getSubAccount: () => ({
          enabledControllers: [oldController],
        }),
      },
    } as unknown as Portfolio<VaultEntity>

    const finalPortfolio = {
      borrows: [borrowPosition(oldController, 3n * WAD)],
      account: {
        getSubAccount: () => ({
          enabledControllers: [oldController],
        }),
      },
    } as unknown as Portfolio<VaultEntity>

    expect(buildBatchHealthSummary({
      basePortfolio,
      finalPortfolio,
      changedPositionKeys: new Set([changedKey(collateralVault)]),
      positionTag,
    })).toEqual([{
      label: 'Position 1',
      before: '2.00',
      after: '3.00',
    }])
  })
})
