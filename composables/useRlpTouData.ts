import type { Hex } from 'viem'
import { keccak256, stringToHex } from 'viem'
import { logWarn } from '~/utils/errorHandling'

let cachedRlpTouData: RlpTouData | null = null
let fetchPromise: Promise<RlpTouData> | null = null

export interface RlpTouData {
  tosMessage: string
  tosMessageHash: Hex
}

export async function getRlpTouData(): Promise<RlpTouData> {
  if (cachedRlpTouData) {
    return cachedRlpTouData
  }
  if (fetchPromise) {
    return fetchPromise
  }

  const { rlpTouMdUrl } = useDeployConfig()
  if (!rlpTouMdUrl) {
    throw new Error('RLP ToU URL not configured')
  }

  fetchPromise = fetch(rlpTouMdUrl)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch RLP ToU: ${response.status} ${response.statusText}`)
      }
      return response.text()
    })
    .then((content) => {
      const tosHash = keccak256(stringToHex(content))
      const tosHashShort = tosHash.slice(0, 14)
      const tosMessage = `By proceeding to interact with this RLP redemption vault, you accept and agree to abide by the additional Terms of Use: ${rlpTouMdUrl}\n\nhash:${tosHashShort}`
      const tosMessageHash = keccak256(stringToHex(tosMessage))
      cachedRlpTouData = { tosMessage, tosMessageHash }
      return cachedRlpTouData
    })
    .catch((error) => {
      logWarn('rlpTou/loadMarkdown', error, { severity: 'error' })
      throw error
    })
    .finally(() => {
      fetchPromise = null
    })

  return fetchPromise
}
