import { describe, expect, it } from 'vitest'
import type { Portfolio, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { buildBatchHealthSummary } from '~/utils/batchHealthSummary'

const WAD = 10n ** 18n
const subAccount = getAddress('0x8A54C278D117854486db0F6460D901a180Fff517')
const oldController = getAddress('0x1111111111111111111111111111111111111111')
const newController = getAddress('0x2222222222222222222222222222222222222222')

const borrowPosition = (
  controller: Address,
  healthFactor: bigint,
): PortfolioBorrowPosition<VaultEntity> => ({
  subAccount,
  healthFactor,
  borrowVault: { address: controller } as VaultEntity,
  borrow: { vaultAddress: controller } as PortfolioBorrowPosition<VaultEntity>['borrow'],
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
})
