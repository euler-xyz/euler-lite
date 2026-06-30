import { describe, expect, it } from 'vitest'
import {
  applyEulerChainsSwapVerifierOverrides,
  readSwapVerifierOverrides,
} from '~/server/utils/euler-chains-overrides'

const MAINNET_SWAP_VERIFIER = '0x312eE8B4a2df952E3c52Bb155c44F54f81f92d1d'
const BASE_SWAP_VERIFIER = '0x67c9C729258fcF4c84C6c43950581B73a187f00B'

describe('euler chains swap verifier overrides', () => {
  it('reads per-chain SwapVerifier overrides from server env', () => {
    expect(readSwapVerifierOverrides({
      EULER_SWAP_VERIFIER_ADDRESS_1: MAINNET_SWAP_VERIFIER,
      EULER_SWAP_VERIFIER_ADDRESS_8453: BASE_SWAP_VERIFIER,
    })).toEqual({
      1: MAINNET_SWAP_VERIFIER,
      8453: BASE_SWAP_VERIFIER,
    })
  })

  it('applies overrides without mutating the upstream payload', () => {
    const upstream = [
      {
        chainId: 1,
        addresses: {
          coreAddrs: {},
          peripheryAddrs: {
            swapVerifier: '0x0000000000000000000000000000000000000001',
            swapper: '0x0000000000000000000000000000000000000002',
          },
        },
      },
      {
        chainId: 8453,
        addresses: {
          coreAddrs: {},
          peripheryAddrs: {
            swapper: '0x0000000000000000000000000000000000000003',
          },
        },
      },
      {
        chainId: 42161,
        addresses: {
          coreAddrs: {},
          peripheryAddrs: {
            swapVerifier: '0x0000000000000000000000000000000000000004',
          },
        },
      },
    ]

    const result = applyEulerChainsSwapVerifierOverrides(upstream, {
      EULER_SWAP_VERIFIER_ADDRESS_1: MAINNET_SWAP_VERIFIER,
      EULER_SWAP_VERIFIER_ADDRESS_8453: BASE_SWAP_VERIFIER,
    }) as typeof upstream

    expect(result[0]?.addresses.peripheryAddrs.swapVerifier).toBe(MAINNET_SWAP_VERIFIER)
    expect(result[0]?.addresses.peripheryAddrs.swapper).toBe('0x0000000000000000000000000000000000000002')
    expect(result[1]?.addresses.peripheryAddrs.swapVerifier).toBe(BASE_SWAP_VERIFIER)
    expect(result[2]?.addresses.peripheryAddrs.swapVerifier).toBe('0x0000000000000000000000000000000000000004')
    expect(upstream[0]?.addresses.peripheryAddrs.swapVerifier).toBe('0x0000000000000000000000000000000000000001')
  })

  it('ignores blank override values', () => {
    expect(readSwapVerifierOverrides({
      EULER_SWAP_VERIFIER_ADDRESS_1: '   ',
    })).toEqual({})
  })

  it('rejects invalid override addresses', () => {
    expect(() => readSwapVerifierOverrides({
      EULER_SWAP_VERIFIER_ADDRESS_1: 'not-an-address',
    })).toThrow('EULER_SWAP_VERIFIER_ADDRESS_1 must be a valid EVM address')
  })
})
