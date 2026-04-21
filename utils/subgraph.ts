import { getAddress } from 'viem'
import axios from 'axios'
import { logWarn } from '~/utils/errorHandling'
import { SUBGRAPH_TIMEOUT_MS } from '~/entities/tuning-constants'

export interface SubgraphPositionEntry {
  subAccount: string
  vault: string
}

export interface AccountPositions {
  borrows: SubgraphPositionEntry[]
  deposits: SubgraphPositionEntry[]
}

export const getAddressPrefix = (address: string) => address.toLowerCase().slice(0, 40)

function parseEntries(entries: string[]): SubgraphPositionEntry[] {
  return entries.map(entry => ({
    subAccount: getAddress(entry.substring(0, 42)),
    vault: getAddress(`0x${entry.substring(42)}`),
  }))
}

export async function fetchAccountPositions(subgraphUrl: string, walletAddress: string): Promise<AccountPositions> {
  try {
    const prefix = getAddressPrefix(walletAddress)

    const { data } = await axios.post(subgraphUrl, {
      query: `query AccountPositions {
        trackingActiveAccount(id: "${prefix}") {
          borrows
          deposits
        }
      }`,
      operationName: 'AccountPositions',
    }, { timeout: SUBGRAPH_TIMEOUT_MS })

    const account = data.data?.trackingActiveAccount

    return {
      borrows: parseEntries(account?.borrows || []),
      deposits: parseEntries(account?.deposits || []),
    }
  }
  catch (error) {
    logWarn('subgraph/fetchPositions', error)
    return { borrows: [], deposits: [] }
  }
}
