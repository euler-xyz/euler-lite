import { describe, expect, it } from 'vitest'
import {
  assertSwapQuoteContractsAllowed,
  assertSwapperAllowed,
  getAllowedSwapperAddresses,
} from '~/utils/swap-validation'

const SWAPPER = '0x0000000000000000000000000000000000000001'
const EULER_SWAP_V1_PERIPHERY = '0x0000000000000000000000000000000000000002'
const EULER_SWAP_V2_PERIPHERY = '0x0000000000000000000000000000000000000003'
const SWAP_VERIFIER = '0x0000000000000000000000000000000000000004'
const ATTACKER = '0x0000000000000000000000000000000000000005'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const knownAddresses = {
  swapper: SWAPPER,
  eulerSwapV1Periphery: EULER_SWAP_V1_PERIPHERY,
  eulerSwapV2Periphery: EULER_SWAP_V2_PERIPHERY,
  swapVerifier: SWAP_VERIFIER,
}

describe('swap validation', () => {
  it('allowlists canonical swapper contracts from Euler chain config', () => {
    expect(getAllowedSwapperAddresses({
      swapper: SWAPPER,
      eulerSwapV1Periphery: EULER_SWAP_V1_PERIPHERY,
      eulerSwapV2Periphery: EULER_SWAP_V2_PERIPHERY,
      eulerSwapPeriphery: ZERO_ADDRESS,
    })).toEqual([
      SWAPPER,
      EULER_SWAP_V1_PERIPHERY,
      EULER_SWAP_V2_PERIPHERY,
    ])
  })

  it('accepts quote swappers that match canonical deployments', () => {
    expect(() => assertSwapperAllowed(EULER_SWAP_V2_PERIPHERY, knownAddresses)).not.toThrow()
  })

  it('rejects quote swappers outside canonical deployments', () => {
    expect(() => assertSwapperAllowed(ATTACKER, knownAddresses)).toThrow(
      `Unknown swapper address: ${ATTACKER}`,
    )
  })

  it('validates swapper and verifier before a quote can build EVC calls', () => {
    expect(() => assertSwapQuoteContractsAllowed({
      swapperAddress: EULER_SWAP_V1_PERIPHERY,
      verifierAddress: SWAP_VERIFIER,
    }, knownAddresses)).not.toThrow()

    expect(() => assertSwapQuoteContractsAllowed({
      swapperAddress: ATTACKER,
      verifierAddress: SWAP_VERIFIER,
    }, knownAddresses)).toThrow(`Unknown swapper address: ${ATTACKER}`)
  })

  it('fails closed when no canonical swapper is configured', () => {
    expect(() => assertSwapperAllowed(SWAPPER, { swapVerifier: SWAP_VERIFIER })).toThrow(
      'Known swapper address not configured',
    )
  })
})
