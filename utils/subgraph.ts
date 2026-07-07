import { getAddress } from 'viem'
import axios from 'axios'
import { logger } from '~/utils/logger'
import {
  SUBGRAPH_TIMEOUT_MS,
  SUBGRAPH_BLOCK_POLL_INTERVAL_MS,
  SUBGRAPH_BLOCK_CATCHUP_TIMEOUT_MS,
} from '~/entities/tuning-constants'

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
    logger.warn(
      { ctx: 'subgraph/fetchPositions', wallet: walletAddress, err: error },
      'failed to fetch account positions from subgraph',
    )
    return { borrows: [], deposits: [] }
  }
}

/**
 * Poll the subgraph until it has indexed `targetBlock`, returning whether it
 * caught up before the timeout. `subgraphUrl` should be the SDK's subgraph
 * proxy path (`/api/internal/proxy/subgraph/{chainId}`) so the head measured here is the
 * same one serving queryAccountVaults — not a separately-resolved upstream.
 */
export async function waitForSubgraphBlock(
  subgraphUrl: string,
  targetBlock: bigint,
  opts: { intervalMs?: number, timeoutMs?: number } = {},
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? SUBGRAPH_BLOCK_POLL_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? SUBGRAPH_BLOCK_CATCHUP_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const { data } = await axios.post(
        subgraphUrl,
        { query: '{ _meta { block { number } } }' },
        { timeout: SUBGRAPH_TIMEOUT_MS },
      )
      const indexed = BigInt(data?.data?._meta?.block?.number ?? 0)
      if (indexed >= targetBlock) return true
    }
    catch (error) {
      logger.warn(
        { ctx: 'subgraph/waitForBlock', target: targetBlock.toString(), err: error },
        'failed to poll subgraph block height',
      )
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return false
}
