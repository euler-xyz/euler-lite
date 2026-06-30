import { getAddress, type Address } from 'viem'

const SWAP_VERIFIER_ENV_PREFIX = 'EULER_SWAP_VERIFIER_ADDRESS_'

export type SwapVerifierOverrides = Record<number, Address>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function readSwapVerifierOverrides(env: NodeJS.ProcessEnv = process.env): SwapVerifierOverrides {
  const overrides: SwapVerifierOverrides = {}

  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.startsWith(SWAP_VERIFIER_ENV_PREFIX)) continue
    const value = rawValue?.trim()
    if (!value) continue

    const chainId = Number(key.slice(SWAP_VERIFIER_ENV_PREFIX.length))
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new Error(`${key} must end with a positive integer chain id`)
    }

    try {
      overrides[chainId] = getAddress(value)
    }
    catch {
      throw new Error(`${key} must be a valid EVM address`)
    }
  }

  return overrides
}

export function applyEulerChainsSwapVerifierOverrides(
  data: unknown[],
  env: NodeJS.ProcessEnv = process.env,
): unknown[] {
  const overrides = readSwapVerifierOverrides(env)
  if (Object.keys(overrides).length === 0) return data

  return data.map((entry) => {
    if (!isRecord(entry)) return entry
    const chainId = Number(entry.chainId)
    if (!Number.isSafeInteger(chainId)) return entry

    const swapVerifier = overrides[chainId]
    if (!swapVerifier) return entry

    const addresses = isRecord(entry.addresses) ? entry.addresses : {}
    const peripheryAddrs = isRecord(addresses.peripheryAddrs) ? addresses.peripheryAddrs : {}

    return {
      ...entry,
      addresses: {
        ...addresses,
        peripheryAddrs: {
          ...peripheryAddrs,
          swapVerifier,
        },
      },
    }
  })
}
