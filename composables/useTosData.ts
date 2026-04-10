import type { Hex } from 'viem'
import { keccak256, stringToHex } from 'viem'
import { logWarn } from '~/utils/errorHandling'

let cachedTosData: TosData | null = null
let fetchPromise: Promise<TosData> | null = null

export interface TosData {
  tosMessage: string
  tosMessageHash: Hex
}

export async function getTosData(): Promise<TosData> {
  if (cachedTosData) {
    return cachedTosData
  }
  if (fetchPromise) {
    return fetchPromise
  }

  const { tosUrl } = useDeployConfig()

  fetchPromise = fetch('/api/tos')
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch ToS: ${response.status} ${response.statusText}`)
      }
      return response.text()
    })
    .then((content) => {
      const tosHash = keccak256(stringToHex(content))
      const tosHashShort = tosHash.slice(0, 14)
      const tosMessage = `By proceeding to engage with and use Euler, you accept and agree to abide by the Terms of Use: ${tosUrl}\n\nhash:${tosHashShort}`
      const tosMessageHash = keccak256(stringToHex(tosMessage))
      cachedTosData = { tosMessage, tosMessageHash }
      return cachedTosData
    })
    .catch((error) => {
      logWarn('tos/loadMarkdown', error, { severity: 'error' })
      throw error
    })
    .finally(() => {
      fetchPromise = null
    })

  return fetchPromise
}
