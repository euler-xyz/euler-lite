import { describe, expect, it, vi } from 'vitest'
import { Account, type IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { fetchBaseAccountSnapshot, stitchAccount } from '~/composables/useTxBatch'

const owner = getAddress('0x1000000000000000000000000000000000000000')
const subAccount = getAddress('0x8A54C278D117854486db0F6460D901a180Fff517')
const vault = getAddress('0x797Dd80692C3B2daDAbcE8e30C07fDE5307d48A9')

const position = (account: Address, shares: bigint) => ({
  account,
  vaultAddress: vault,
  asset: vault,
  shares,
  assets: shares,
  borrowed: 0n,
  isController: false,
  isCollateral: false,
  balanceForwarderEnabled: false,
})

const accountWithPosition = (
  subAccountKey: Address,
  positionAccount: Address,
  shares: bigint,
) => new Account<IHasVaultAddress>({
  chainId: 1,
  owner,
  subAccounts: {
    [subAccountKey]: {
      timestamp: 0,
      account: positionAccount,
      owner,
      lastAccountStatusCheckTimestamp: 0,
      enabledControllers: [],
      enabledCollaterals: [],
      positions: [position(positionAccount, shares)],
    },
  },
  populated: { vaults: true, marketPrices: true, userRewards: true },
})

describe('stitchAccount', () => {
  it('merges simulated sub-accounts by canonical address key', () => {
    const base = accountWithPosition(subAccount, subAccount, 1n)
    const touched = accountWithPosition(
      subAccount.toLowerCase() as Address,
      subAccount.toLowerCase() as Address,
      2n,
    )

    const stitched = stitchAccount(base, touched)

    expect(Object.keys(stitched.subAccounts)).toEqual([subAccount])
    expect(stitched.getSubAccount(subAccount)?.positions).toHaveLength(1)
    expect(stitched.getSubAccount(subAccount)?.positions[0]?.shares).toBe(2n)
  })
})

describe('fetchBaseAccountSnapshot', () => {
  it('uses the same full population path as the normal portfolio read', async () => {
    const expected = accountWithPosition(subAccount, subAccount, 1n)
    const fetchAccount = vi.fn(async () => ({ result: expected, errors: [] }))
    const sdk = {
      accountService: { fetchAccount },
    } as unknown as Parameters<typeof fetchBaseAccountSnapshot>[0]

    const result = await fetchBaseAccountSnapshot(sdk, 1, owner)

    expect(result).toBe(expected)
    expect(fetchAccount).toHaveBeenCalledWith(1, owner, { populateAll: true })
  })
})
