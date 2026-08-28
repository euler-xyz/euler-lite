import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it } from 'vitest'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { buildRefinanceIntentArgs } from '~/utils/refinance-intent'
import { TEST_ACCOUNT, TEST_TOKEN, TEST_VAULT } from '../reviewed-execution/fixtures'
import { makeSwapQuote } from '../reviewed-execution/swap-quote.test-fixture'

const OTHER_VAULT = '0x5000000000000000000000000000000000000000' as const
const OTHER_TOKEN = '0x6000000000000000000000000000000000000000' as const

describe('buildRefinanceIntentArgs', () => {
  it('keeps swap-only fields out of a mixed refinance same-asset leg', () => {
    const quote = makeSwapQuote()
    const intent = createOperationIntent({
      kind: 'refinance',
      planner: 'refinance-position',
      args: buildRefinanceIntentArgs({
        collateral: {
          fromVault: TEST_VAULT,
          toVault: OTHER_VAULT,
          amount: 12n,
          positionAccount: TEST_ACCOUNT,
          fromAsset: TEST_TOKEN,
          toAsset: TEST_TOKEN,
          isMax: true,
          enableCollateralTo: true,
          disableCollateralFrom: true,
          swapperMode: SwapperMode.EXACT_IN,
        },
        debt: {
          oldLiabilityVault: TEST_VAULT,
          newLiabilityVault: OTHER_VAULT,
          liabilityAccount: TEST_ACCOUNT,
          newLiabilityAsset: quote.tokenIn.address,
          swapQuote: quote,
          swapperMode: SwapperMode.TARGET_DEBT,
        },
      }),
      chainId: 1,
      account: TEST_ACCOUNT,
      subAccounts: [TEST_ACCOUNT],
      source: 'test:refinance',
      createdAt: 1,
      intentId: 'intent:refinance',
    })

    expect(intent.planner.args.collateral).toEqual({
      planner: 'migrate-same-asset-collateral',
      args: {
        fromVault: TEST_VAULT,
        toVault: OTHER_VAULT,
        amount: 12n,
        positionAccount: TEST_ACCOUNT,
        fromAsset: TEST_TOKEN,
        toAsset: TEST_TOKEN,
        isMax: true,
        enableCollateralTo: true,
        disableCollateralFrom: true,
      },
    })
    expect(intent.planner.args.debt).toEqual({
      planner: 'swap-debt',
      args: {
        swapQuote: expect.any(Object),
        swapperMode: SwapperMode.TARGET_DEBT,
      },
    })
  })

  it('projects the same-asset debt leg to its exact planner fields', () => {
    const quote = makeSwapQuote()
    const intent = createOperationIntent({
      kind: 'refinance',
      planner: 'refinance-position',
      args: buildRefinanceIntentArgs({
        collateral: {
          fromVault: TEST_VAULT,
          toVault: OTHER_VAULT,
          amount: 12n,
          positionAccount: TEST_ACCOUNT,
          toAsset: OTHER_TOKEN,
          swapQuote: quote,
          swapperMode: SwapperMode.EXACT_IN,
        },
        debt: {
          oldLiabilityVault: TEST_VAULT,
          newLiabilityVault: OTHER_VAULT,
          liabilityAccount: TEST_ACCOUNT,
          liabilityAmount: 7n,
          oldLiabilityAsset: TEST_TOKEN,
          newLiabilityAsset: TEST_TOKEN,
          sweepExcess: true,
          transferRemainingSharesToOwner: true,
          swapperMode: SwapperMode.TARGET_DEBT,
        },
      }),
      chainId: 1,
      account: TEST_ACCOUNT,
      subAccounts: [TEST_ACCOUNT],
      source: 'test:refinance',
      createdAt: 1,
      intentId: 'intent:refinance',
    })

    expect(intent.planner.args.collateral).toEqual({
      planner: 'swap-collateral',
      args: {
        swapQuote: expect.any(Object),
        swapperMode: SwapperMode.EXACT_IN,
      },
    })
    expect(intent.planner.args.debt).toEqual({
      planner: 'migrate-same-asset-debt',
      args: {
        oldLiabilityVault: TEST_VAULT,
        newLiabilityVault: OTHER_VAULT,
        liabilityAccount: TEST_ACCOUNT,
        liabilityAmount: 7n,
        oldLiabilityAsset: TEST_TOKEN,
        newLiabilityAsset: TEST_TOKEN,
        sweepExcess: true,
        transferRemainingSharesToOwner: true,
      },
    })
  })
})
