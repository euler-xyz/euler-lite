import { describe, it, expect } from 'vitest'
import { zeroAddress } from 'viem'
import type { EVault, EVaultHookedOperations } from '@eulerxyz/euler-v2-sdk'
import {
  OP_DEPOSIT,
  OP_WITHDRAW,
  OP_BORROW,
  OP_REPAY,
  OP_REPAY_WITH_SHARES,
  OP_SKIM,
  OP_TRANSFER,
  OP_REDEEM,
  OP_MINT,
  OP_FLASHLOAN,
  OP_VAULT_STATUS_CHECK,
  OP_LIQUIDATE,
  OP_PULL_DEBT,
  areAllUserOpsHooked,
  decodeHookedOperationsMask,
  findBlockingDisabledOp,
  formatHookedOpsSummary,
  getHookedOperationMetas,
  getOpMeta,
  hasAnyHookedOperation,
  isHookDisabling,
  isOpDisabled,
  isOpHooked,
  isVaultEffectivelyPaused,
  type VaultOperation,
} from '~/utils/vault-hooks'

const HOOK_TARGET = '0x8EFc2DfFeF35A326d6e02440FB7dD5bdf7f0a9aA'
const OTHER_VAULT = '0x2222222222222222222222222222222222222222'

const emptyHookedOperations = (): EVaultHookedOperations => ({
  deposit: false,
  mint: false,
  withdraw: false,
  redeem: false,
  transfer: false,
  skim: false,
  borrow: false,
  repay: false,
  repayWithShares: false,
  pullDebt: false,
  convertFees: false,
  liquidate: false,
  flashloan: false,
  touch: false,
  vaultStatusCheck: false,
})

const hookedOperations = (...operations: VaultOperation[]): EVaultHookedOperations => {
  const result = emptyHookedOperations()
  for (const operation of operations) result[operation] = true
  return result
}

const vault = (
  operations: readonly VaultOperation[] = [],
  hookTarget: string = zeroAddress,
): EVault =>
  ({
    hooks: {
      hookedOperations: hookedOperations(...operations),
      hookTarget,
    },
  } as unknown as EVault)

describe('isHookDisabling', () => {
  it('is true when hookTarget is the zero address', () => {
    expect(isHookDisabling(vault([], zeroAddress))).toBe(true)
  })
  it('is false when hookTarget is non-zero', () => {
    expect(isHookDisabling(vault([], HOOK_TARGET))).toBe(false)
  })
})

describe('isOpHooked', () => {
  it('is true when the SDK boolean flag is true', () => {
    const v = vault([OP_DEPOSIT, OP_BORROW])
    expect(isOpHooked(v, OP_DEPOSIT)).toBe(true)
    expect(isOpHooked(v, OP_BORROW)).toBe(true)
  })
  it('is false when the SDK boolean flag is false', () => {
    expect(isOpHooked(vault([OP_DEPOSIT]), OP_BORROW)).toBe(false)
    expect(isOpHooked(vault(), OP_DEPOSIT)).toBe(false)
  })
})

describe('isOpDisabled', () => {
  it('is false when hookTarget is non-zero (op is merely hooked, may be conditionally allowed)', () => {
    expect(isOpDisabled(vault([OP_DEPOSIT], HOOK_TARGET), OP_DEPOSIT)).toBe(false)
  })
  it('is true when hookTarget is zero and the specific op flag is true', () => {
    expect(isOpDisabled(vault([OP_DEPOSIT], zeroAddress), OP_DEPOSIT)).toBe(true)
  })
  it('is false when hookTarget is zero but the specific op flag is false', () => {
    expect(isOpDisabled(vault([OP_BORROW], zeroAddress), OP_DEPOSIT)).toBe(false)
  })
  it('short-circuits to true for any op when vaultStatusCheck is disabled', () => {
    const v = vault([OP_VAULT_STATUS_CHECK], zeroAddress)
    expect(isOpDisabled(v, OP_DEPOSIT)).toBe(true)
    expect(isOpDisabled(v, OP_BORROW)).toBe(true)
    expect(isOpDisabled(v, OP_WITHDRAW)).toBe(true)
  })
  it('does not short-circuit when vaultStatusCheck is hooked with a non-zero target', () => {
    const v = vault([OP_VAULT_STATUS_CHECK], HOOK_TARGET)
    expect(isOpDisabled(v, OP_DEPOSIT)).toBe(false)
  })
})

describe('areAllUserOpsHooked', () => {
  it('is true when every user-facing op flag is true', () => {
    const all = hookedOperations(
      OP_DEPOSIT,
      OP_MINT,
      OP_WITHDRAW,
      OP_REDEEM,
      OP_TRANSFER,
      OP_SKIM,
      OP_BORROW,
      OP_REPAY,
      OP_REPAY_WITH_SHARES,
      OP_PULL_DEBT,
      OP_LIQUIDATE,
      OP_FLASHLOAN,
    )
    expect(areAllUserOpsHooked(all)).toBe(true)
  })
  it('is false when only a subset is true', () => {
    expect(areAllUserOpsHooked(hookedOperations(OP_DEPOSIT, OP_BORROW))).toBe(false)
  })
  it('ignores internal ops (vaultStatusCheck, touch, convertFees)', () => {
    expect(areAllUserOpsHooked(hookedOperations(OP_VAULT_STATUS_CHECK))).toBe(false)
  })
})

describe('isVaultEffectivelyPaused', () => {
  it('is false when the hook target is non-zero, regardless of flags', () => {
    expect(isVaultEffectivelyPaused(vault([OP_VAULT_STATUS_CHECK], HOOK_TARGET))).toBe(false)
  })
  it('is true when vaultStatusCheck is disabled (hookTarget zero)', () => {
    expect(isVaultEffectivelyPaused(vault([OP_VAULT_STATUS_CHECK], zeroAddress))).toBe(true)
  })
  it('is true when every user-facing op is disabled even without vaultStatusCheck', () => {
    const allUser: VaultOperation[] = [
      OP_DEPOSIT,
      OP_MINT,
      OP_WITHDRAW,
      OP_REDEEM,
      OP_TRANSFER,
      OP_SKIM,
      OP_BORROW,
      OP_REPAY,
      OP_REPAY_WITH_SHARES,
      OP_PULL_DEBT,
      OP_LIQUIDATE,
      OP_FLASHLOAN,
    ]
    expect(isVaultEffectivelyPaused(vault(allUser, zeroAddress))).toBe(true)
  })
  it('is false when only some user ops are disabled', () => {
    expect(isVaultEffectivelyPaused(vault([OP_DEPOSIT, OP_BORROW], zeroAddress))).toBe(false)
  })
})

describe('getHookedOperationMetas', () => {
  it('returns an empty array when no operation flags are true', () => {
    expect(getHookedOperationMetas(hookedOperations())).toEqual([])
  })
  it('returns metadata entries for each true user-facing flag', () => {
    const decoded = getHookedOperationMetas(hookedOperations(OP_DEPOSIT, OP_BORROW))
    expect(decoded.map(op => op.name)).toEqual(['Deposit', 'Borrow'])
  })
  it('hides internal ops by default', () => {
    const decoded = getHookedOperationMetas(hookedOperations(OP_DEPOSIT, OP_VAULT_STATUS_CHECK))
    expect(decoded.map(op => op.name)).toEqual(['Deposit'])
  })
  it('includes internal ops when includeInternal=true', () => {
    const decoded = getHookedOperationMetas(hookedOperations(OP_VAULT_STATUS_CHECK), { includeInternal: true })
    expect(decoded.map(op => op.name)).toContain('Vault status check')
  })
})

describe('decodeHookedOperationsMask', () => {
  it('decodes protocol operation bits and preserves unknown flags', () => {
    const decoded = decodeHookedOperationsMask((1n << 0n) | (1n << 6n) | (1n << 15n))

    expect(decoded.hookedOperations.deposit).toBe(true)
    expect(decoded.hookedOperations.borrow).toBe(true)
    expect(decoded.hookedOperations.repay).toBe(false)
    expect(decoded.unknownMask).toBe(1n << 15n)
  })
})

describe('hasAnyHookedOperation', () => {
  it('detects user and internal operation flags by default', () => {
    expect(hasAnyHookedOperation(hookedOperations(OP_DEPOSIT))).toBe(true)
    expect(hasAnyHookedOperation(hookedOperations(OP_VAULT_STATUS_CHECK))).toBe(true)
  })
  it('can ignore internal operation flags', () => {
    expect(hasAnyHookedOperation(hookedOperations(OP_VAULT_STATUS_CHECK), { includeInternal: false })).toBe(false)
  })
})

describe('formatHookedOpsSummary', () => {
  const mk = (...names: string[]) => names.map(n => ({ name: n } as ReturnType<typeof getOpMeta> & { name: string })) as never
  it('returns "None" for an empty list', () => {
    expect(formatHookedOpsSummary([])).toBe('None')
  })
  it('returns the single name when one op', () => {
    expect(formatHookedOpsSummary(mk('Deposit'))).toBe('Deposit')
  })
  it('joins two names with a comma', () => {
    expect(formatHookedOpsSummary(mk('Deposit', 'Mint'))).toBe('Deposit, Mint')
  })
  it('truncates 3+ to first two + "& N more"', () => {
    expect(formatHookedOpsSummary(mk('Deposit', 'Mint', 'Withdraw')))
      .toBe('Deposit, Mint & 1 more')
    expect(formatHookedOpsSummary(mk('Deposit', 'Mint', 'Withdraw', 'Redeem', 'Transfer')))
      .toBe('Deposit, Mint & 3 more')
  })
})

describe('getOpMeta', () => {
  it('returns the metadata row for a known operation', () => {
    expect(getOpMeta(OP_DEPOSIT)?.name).toBe('Deposit')
    expect(getOpMeta(OP_BORROW)?.name).toBe('Borrow')
  })
  it('returns undefined for an unknown operation key', () => {
    expect(getOpMeta('unknown' as VaultOperation)).toBeUndefined()
  })
})

describe('findBlockingDisabledOp', () => {
  const liab = vault([OP_BORROW], zeroAddress)
  const coll = vault([OP_TRANSFER], zeroAddress)
  const healthy = vault()

  it('returns null when no step is blocked', () => {
    expect(findBlockingDisabledOp([
      { vault: healthy, op: OP_DEPOSIT },
      { vault: healthy, op: OP_BORROW },
    ])).toBeNull()
  })
  it('returns the first blocking step in order', () => {
    const result = findBlockingDisabledOp([
      { vault: healthy, op: OP_DEPOSIT },
      { vault: liab, op: OP_BORROW },
      { vault: coll, op: OP_TRANSFER },
    ])
    expect(result?.vault).toBe(liab)
    expect(result?.op).toBe(OP_BORROW)
  })
  it('identifies blocks coming from the vaultStatusCheck short-circuit', () => {
    const statusDown = vault([OP_VAULT_STATUS_CHECK], zeroAddress)
    const result = findBlockingDisabledOp([{ vault: statusDown, op: OP_DEPOSIT }])
    expect(result?.vault).toBe(statusDown)
  })
  it('does not block when ops are merely hooked (non-zero hookTarget)', () => {
    expect(findBlockingDisabledOp([{ vault: vault([OP_DEPOSIT], HOOK_TARGET), op: OP_DEPOSIT }])).toBeNull()
  })
})

describe('HOOK_TARGET vs OTHER_VAULT sanity', () => {
  // Sanity that the helper addresses used above are distinct — prevents
  // accidental false positives in isHookDisabling.
  it('hook target fixture is not zero', () => {
    expect(HOOK_TARGET).not.toBe(zeroAddress)
  })
  it('other fixture vault is not zero', () => {
    expect(OTHER_VAULT).not.toBe(zeroAddress)
  })
})
