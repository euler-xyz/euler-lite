import { describe, expect, it } from 'vitest'
import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { groupHasExplorableMarket } from '~/utils/vault/market-group-visibility'
import { normalizeAddress } from '~/utils/normalizeAddress'

const LEND_VAULT = normalizeAddress('0x0000000000000000000000000000000000002001')
const WRAPPER_A = normalizeAddress('0x0000000000000000000000000000000000002002')
const WRAPPER_B = normalizeAddress('0x0000000000000000000000000000000000002003')
const TERM_BORROW = normalizeAddress('0x0000000000000000000000000000000000002004')

const makeEVault = (
  address: string,
  opts?: { isBorrowable?: boolean, totalBorrowed?: bigint },
): EVault =>
  ({
    type: 'EVault',
    address,
    isBorrowable: opts?.isBorrowable ?? true,
    totalBorrowed: opts?.totalBorrowed ?? 0n,
  }) as unknown as EVault

const makeWrapper = (address: string): SecuritizeCollateralVault =>
  ({
    type: 'SecuritizeCollateral',
    address,
  }) as unknown as SecuritizeCollateralVault

const productBase = {
  name: 'Test',
  description: '',
  url: '',
}

describe('groupHasExplorableMarket', () => {
  it('lists a product whose members carry no explorability flags', () => {
    __setEulerLabelsDataForTest({
      products: {
        test: { ...productBase, entity: ['curator'], vaults: [LEND_VAULT] },
      },
    })

    expect(groupHasExplorableMarket([makeEVault(LEND_VAULT)])).toBe(true)
  })

  it('hides a collateral-only product of lend-hidden non-borrowable wrappers', () => {
    __setEulerLabelsDataForTest({
      products: {
        securitize: {
          ...productBase,
          entity: ['securitize'],
          vaults: [WRAPPER_A, WRAPPER_B],
          vaultOverrides: {
            [WRAPPER_A]: { notExplorableLend: true },
            [WRAPPER_B]: { notExplorableLend: true },
          },
        },
      },
    })

    expect(groupHasExplorableMarket([makeWrapper(WRAPPER_A), makeWrapper(WRAPPER_B)])).toBe(false)
  })

  it('keeps a borrow-only market listed when its lend side is hidden', () => {
    __setEulerLabelsDataForTest({
      products: {
        term: {
          ...productBase,
          entity: ['curator'],
          vaults: [TERM_BORROW],
          vaultOverrides: {
            [TERM_BORROW]: { notExplorableLend: true },
          },
        },
      },
    })

    expect(groupHasExplorableMarket([makeEVault(TERM_BORROW)])).toBe(true)
  })

  it('hides every member of a product flagged notExplorable at the product level', () => {
    __setEulerLabelsDataForTest({
      products: {
        hidden: {
          ...productBase,
          entity: ['curator'],
          notExplorable: true,
          vaults: [LEND_VAULT],
        },
      },
    })

    expect(groupHasExplorableMarket([makeEVault(LEND_VAULT)])).toBe(false)
  })

  it('treats residual debt as a live borrow market on a lend-hidden vault', () => {
    __setEulerLabelsDataForTest({
      products: {
        term: {
          ...productBase,
          entity: ['curator'],
          vaults: [TERM_BORROW],
          vaultOverrides: {
            [TERM_BORROW]: { notExplorableLend: true },
          },
        },
      },
    })

    const rampedDown = makeEVault(TERM_BORROW, { isBorrowable: false, totalBorrowed: 1n })
    const drained = makeEVault(TERM_BORROW, { isBorrowable: false, totalBorrowed: 0n })

    expect(groupHasExplorableMarket([rampedDown])).toBe(true)
    expect(groupHasExplorableMarket([drained])).toBe(false)
  })
})
