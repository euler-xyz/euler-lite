import { parseChainIds } from './parseChainIds'

export function parseDeprecatedChains(rawEnv: string | undefined, enabledSet: Set<number>): number[] {
  return parseChainIds(rawEnv, enabledSet)
}
