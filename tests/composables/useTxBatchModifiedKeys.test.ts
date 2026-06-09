import { describe, expect, it } from 'vitest'
import { Account, type IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { buildModifiedPositionKeySets } from '~/composables/useTxBatch'

const owner = getAddress('0x1000000000000000000000000000000000000000')
const subAccount = getAddress('0x8A54C278D117854486db0F6460D901a180Fff517')
const collateralVault = getAddress('0x797Dd80692C3B2daDAbcE8e30C07fDE5307d48A9')
const borrowVault = getAddress('0x859160Db5841E5cfB8D3f144C6b3381A85A4b410')

const key = (vault: Address) => `${subAccount.toLowerCase()}:${vault.toLowerCase()}`

const position = (vaultAddress: Address, shares: bigint, borrowed: bigint) => ({
  account: subAccount,
  vaultAddress,
  asset: vaultAddress,
  shares,
  assets: shares,
  borrowed,
  isController: borrowed > 0n,
  isCollateral: shares > 0n,
  balanceForwarderEnabled: false,
})

const accountWithPositions = (
  positions: Array<ReturnType<typeof position>>,
) => new Account<IHasVaultAddress>({
  chainId: 1,
  owner,
  subAccounts: {
    [subAccount]: {
      timestamp: 0,
      account: subAccount,
      owner,
      lastAccountStatusCheckTimestamp: 0,
      enabledControllers: [],
      enabledCollaterals: [],
      positions,
    },
  },
  populated: { vaults: true, marketPrices: true },
})

describe('buildModifiedPositionKeySets', () => {
  it('keeps collateral balance changes out of debt keys', () => {
    const base = accountWithPositions([
      position(collateralVault, 100n, 0n),
      position(borrowVault, 0n, 50n),
    ])
    const current = accountWithPositions([
      position(collateralVault, 80n, 0n),
      position(borrowVault, 0n, 50n),
    ])

    const modified = buildModifiedPositionKeySets(current, base)

    expect(modified.balance.has(key(collateralVault))).toBe(true)
    expect(modified.debt.has(key(collateralVault))).toBe(false)
    expect(modified.debt.has(key(borrowVault))).toBe(false)
  })

  it('keeps debt changes out of balance keys', () => {
    const base = accountWithPositions([
      position(collateralVault, 100n, 0n),
      position(borrowVault, 0n, 50n),
    ])
    const current = accountWithPositions([
      position(collateralVault, 100n, 0n),
      position(borrowVault, 0n, 75n),
    ])

    const modified = buildModifiedPositionKeySets(current, base)

    expect(modified.debt.has(key(borrowVault))).toBe(true)
    expect(modified.balance.has(key(borrowVault))).toBe(false)
    expect(modified.balance.has(key(collateralVault))).toBe(false)
  })
})
