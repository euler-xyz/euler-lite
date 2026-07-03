import { describe, expect, it } from 'vitest'
import type { PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import {
  getBorrowPositionCollateralAddresses,
  isRenderablePortfolioBorrowPosition,
} from '~/utils/portfolioBorrowPosition'

const borrowVault = {
  type: 'EVault',
  address: '0x852e00000000000000000000000000000000553b',
} as unknown as VaultEntity

const evaultCollateral = {
  type: 'EVault',
  address: '0xdb1b130512aedbbd7ff5da85b640250dd8230a41',
} as unknown as VaultEntity

const externalCollateral = {
  address: '0xdb1b130512aedbbd7ff5da85b640250dd8230a41',
} as unknown as VaultEntity

const position = (
  overrides: Partial<PortfolioBorrowPosition<VaultEntity>>,
): PortfolioBorrowPosition<VaultEntity> => ({
  borrowVault,
  collateralVaults: [],
  collaterals: [],
  ...overrides,
}) as PortfolioBorrowPosition<VaultEntity>

describe('portfolio borrow position helpers', () => {
  it('treats EVault and Securitize collateral as renderable', () => {
    expect(isRenderablePortfolioBorrowPosition(position({
      collateralVault: evaultCollateral,
    }))).toBe(true)

    expect(isRenderablePortfolioBorrowPosition(position({
      collateralVault: {
        type: 'SecuritizeCollateral',
        address: '0x43c8edfe8bdb8a9dc98a9c5dccfeb057bed25950',
      } as unknown as VaultEntity,
    }))).toBe(true)
  })

  it('routes missing or external collateral to the unsupported fallback', () => {
    expect(isRenderablePortfolioBorrowPosition(position({
      collateralVault: undefined,
    }))).toBe(false)

    expect(isRenderablePortfolioBorrowPosition(position({
      collateralVault: externalCollateral,
    }))).toBe(false)
  })

  it('deduplicates collateral addresses from all SDK borrow-position sources', () => {
    const addresses = getBorrowPositionCollateralAddresses(position({
      borrow: {
        liquidity: {
          collaterals: [
            { address: '0xDB1B130512AEDbbd7Ff5dA85b640250DD8230a41' },
          ],
        },
      },
      collateralVaults: [
        '0xdb1b130512aedbbd7ff5da85b640250dd8230a41',
        '0x43c8edfe8bdb8a9dc98a9c5dccfeb057bed25950',
      ],
      collaterals: [
        { vaultAddress: '0xDB1B130512AEDbbd7Ff5dA85b640250DD8230a41' },
        { vaultAddress: 'not-an-address' },
      ],
      collateral: {
        vaultAddress: '0x43C8edfE8BDB8a9dc98a9c5DCcfeb057bED25950',
      },
    } as unknown as Partial<PortfolioBorrowPosition<VaultEntity>>))

    expect(addresses).toEqual([
      '0xdB1B130512AEDbbd7Ff5dA85b640250DD8230a41',
      '0x43C8edfE8BDB8a9dc98a9c5DCcfeb057bED25950',
    ])
  })
})
