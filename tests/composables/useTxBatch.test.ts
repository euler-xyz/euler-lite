import { describe, expect, it, vi } from 'vitest'
import { Account, type IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { buildWalletChanges, fetchBaseAccountSnapshot, stitchAccount } from '~/composables/useTxBatch'

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

// Position carrying a resolved vault entity, with optional reward / intrinsic-APY
// metadata — mirrors what the SDK populates on the base account but the
// per-layer simulated vaults lack.
const vaultEntity = (rewards?: unknown, intrinsicApy?: unknown) => ({
  address: vault,
  ...(rewards ? { rewards } : {}),
  ...(intrinsicApy ? { intrinsicApy } : {}),
  populated: { rewards: !!rewards, intrinsicApy: !!intrinsicApy },
})

const accountWithVaultPosition = (shares: bigint, vEntity: ReturnType<typeof vaultEntity>) =>
  new Account<IHasVaultAddress>({
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
        positions: [{ ...position(subAccount, shares), vault: vEntity } as never],
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

  it('carries reward and intrinsic-APY metadata onto the simulated position vault', () => {
    const rewards = [{ id: 'campaign-1' }]
    const intrinsicApy = { apy: 3.1, provider: 'lido' }
    // Base vault has the off-chain APY metadata; the simulated (touched) vault,
    // decoded from the per-layer lens block, has none.
    const base = accountWithVaultPosition(1n, vaultEntity(rewards, intrinsicApy))
    const touched = accountWithVaultPosition(2n, vaultEntity())

    const stitched = stitchAccount(base, touched)

    const stitchedVault = stitched.getSubAccount(subAccount)?.positions[0]?.vault as {
      rewards?: unknown
      intrinsicApy?: unknown
      populated?: { rewards?: boolean, intrinsicApy?: boolean }
    } | undefined

    expect(stitched.getSubAccount(subAccount)?.positions[0]?.shares).toBe(2n)
    expect(stitchedVault?.rewards).toEqual(rewards)
    expect(stitchedVault?.intrinsicApy).toEqual(intrinsicApy)
    expect(stitchedVault?.populated?.rewards).toBe(true)
    expect(stitchedVault?.populated?.intrinsicApy).toBe(true)
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

describe('buildWalletChanges', () => {
  it('uses simulated balance deltas', () => {
    const token = getAddress('0x2000000000000000000000000000000000000000').toLowerCase()

    const changes = buildWalletChanges(
      { [token]: 15n },
      { [token]: 10n },
      { [token]: { symbol: 'USDC', decimals: 6 } },
    )

    expect(changes).toEqual([{ token, symbol: 'USDC', decimals: 6, delta: 5n }])
  })
})
