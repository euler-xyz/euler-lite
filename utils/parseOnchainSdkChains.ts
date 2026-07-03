import { parseChainIds } from './parseChainIds'

export function parseOnchainSdkChains(rawEnv: string | undefined, enabledSet: Set<number>): number[] {
  return parseChainIds(rawEnv, enabledSet)
}
