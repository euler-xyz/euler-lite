import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, type Address, type Hex } from 'viem'
import {
  CLOSE_POSITION_PARAMS_COMPONENTS,
  COLLATERAL_SWAP_PARAMS_COMPONENTS,
  OPEN_POSITION_PARAMS_COMPONENTS,
} from '~/abis/cowswap-wrapper'
import {
  buildClosePositionQuoteAppData,
  buildCollateralSwapQuoteAppData,
  buildOpenPositionQuoteAppData,
} from '~/entities/cowswap/order-builder'

const address = (byte: string) => `0x${byte.repeat(20)}` as Address

describe('CoW quote appData builders', () => {
  it('omits the EVC permit signature from open-position wrapper data', () => {
    const appData = buildOpenPositionQuoteAppData({
      owner: address('11'),
      account: address('22'),
      deadline: 123,
      collateralVault: address('33'),
      borrowVault: address('44'),
      collateralAmount: 100n,
      borrowAmount: 200n,
    }, address('55'), 50)

    const parsed = JSON.parse(appData)
    const [params, signature] = decodeAbiParameters([
      { type: 'tuple', components: OPEN_POSITION_PARAMS_COMPONENTS },
      { type: 'bytes' },
    ], parsed.metadata.wrappers[0].data as Hex)

    expect(parsed.metadata.quote.slippageBips).toBe(50)
    expect(params.borrowAmount).toBe(200n)
    expect(signature).toBe('0x')
  })

  it('uses the collateral-swap app code and omits the permit signature', () => {
    const appData = buildCollateralSwapQuoteAppData({
      owner: address('11'),
      account: address('22'),
      deadline: 123,
      fromVault: address('33'),
      toVault: address('44'),
      fromAmount: 200n,
      disableSourceCollateral: true,
    }, address('55'), 50)

    const parsed = JSON.parse(appData)
    const [params, signature] = decodeAbiParameters([
      { type: 'tuple', components: COLLATERAL_SWAP_PARAMS_COMPONENTS },
      { type: 'bytes' },
    ], parsed.metadata.wrappers[0].data as Hex)

    expect(parsed.appCode).toBe('euler_position_collateral_swap')
    expect(params.fromAmount).toBe(200n)
    expect(signature).toBe('0x')
  })

  it('uses the close-position app code and omits the permit signature', () => {
    const appData = buildClosePositionQuoteAppData({
      owner: address('11'),
      account: address('22'),
      deadline: 123,
      borrowVault: address('33'),
      collateralVault: address('44'),
      collateralAmount: 200n,
    }, address('55'), 50)

    const parsed = JSON.parse(appData)
    const [params, signature] = decodeAbiParameters([
      { type: 'tuple', components: CLOSE_POSITION_PARAMS_COMPONENTS },
      { type: 'bytes' },
    ], parsed.metadata.wrappers[0].data as Hex)

    expect(parsed.appCode).toBe('euler_position_close')
    expect(params.collateralAmount).toBe(200n)
    expect(signature).toBe('0x')
  })
})
