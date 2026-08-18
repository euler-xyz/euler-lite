import { getAddress, isAddress, type Address } from 'viem'

export interface EulerRouterGovernanceCarrier {
  oracle?: {
    oracle?: string
    name?: string
  } | null
  eulerRouterGovernor?: Address | null
}

const getEulerRouterAddress = (vault: EulerRouterGovernanceCarrier): Address | null => {
  const address = vault.oracle?.oracle
  if (vault.oracle?.name !== 'EulerRouter' || !address || !isAddress(address)) return null
  return getAddress(address)
}

export const retainEulerRouterGovernor = <T extends object>(
  vault: T,
  governor: unknown,
): T & EulerRouterGovernanceCarrier => {
  if (governor === null) {
    return Object.assign(vault, { eulerRouterGovernor: null })
  }
  if (typeof governor === 'string' && isAddress(governor)) {
    return Object.assign(vault, { eulerRouterGovernor: getAddress(governor) })
  }
  return vault as T & EulerRouterGovernanceCarrier
}

export const resolveEulerRouterGovernors = async <T extends EulerRouterGovernanceCarrier>(
  vaults: T[],
  readGovernor: (router: Address) => Promise<unknown>,
): Promise<T[]> => {
  const routers = new Map<string, Address>()
  for (const vault of vaults) {
    const router = getEulerRouterAddress(vault)
    if (router) routers.set(router.toLowerCase(), router)
  }

  const governors = new Map<string, Address | null>()
  await Promise.all([...routers].map(async ([key, router]) => {
    try {
      const governor = await readGovernor(router)
      governors.set(key, typeof governor === 'string' && isAddress(governor) ? getAddress(governor) : null)
    }
    catch {
      governors.set(key, null)
    }
  }))

  for (const vault of vaults) {
    const router = getEulerRouterAddress(vault)
    if (router) retainEulerRouterGovernor(vault, governors.get(router.toLowerCase()) ?? null)
  }
  return vaults
}
