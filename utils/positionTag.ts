import { getAddress } from 'viem'
import { getSubAccountId } from '@eulerxyz/euler-v2-sdk'

export const getPositionTag = (owner?: string, subAccount?: string): string | undefined => {
  if (!owner || !subAccount) return undefined
  try {
    const index = getSubAccountId(getAddress(owner), getAddress(subAccount))
    return index === 0 ? 'Deposits' : `Position ${index}`
  }
  catch {
    return undefined
  }
}

export const getSourcePositionTag = (
  owner?: string,
  sourceSubAccount?: string,
  targetSubAccount?: string,
): string | undefined => {
  if (!owner || !sourceSubAccount) return undefined
  try {
    if (targetSubAccount && getAddress(sourceSubAccount) === getAddress(targetSubAccount)) return undefined
  }
  catch {
    return undefined
  }
  const sourceTag = getPositionTag(owner, sourceSubAccount)
  return sourceTag ? `From ${sourceTag}` : undefined
}
