import type { Address, Hex } from 'viem'

export interface TenderlyConfig {
  accessKey: string
  accountSlug: string
  projectSlug: string
  budget: {
    url: string
    token: string
    dailyLimit: number
    maxConcurrent: number
  }
}

export interface ViemStateOverrideEntry {
  address: Address
  stateDiff?: { slot: Hex, value: Hex }[]
}

export const resolveTenderlyConfig = (): TenderlyConfig | undefined => {
  const accessKey = process.env.TENDERLY_ACCESS_KEY
  const accountSlug = process.env.TENDERLY_ACCOUNT_SLUG
  const projectSlug = process.env.TENDERLY_PROJECT_SLUG
  const budgetUrl = process.env.TENDERLY_BUDGET_REDIS_REST_URL
  const token = process.env.TENDERLY_BUDGET_REDIS_REST_TOKEN
  const dailyLimit = Number(process.env.TENDERLY_DAILY_SIMULATION_LIMIT)
  const maxConcurrent = Number(process.env.TENDERLY_MAX_CONCURRENT_SIMULATIONS)

  if (!accessKey || !accountSlug || !projectSlug || !budgetUrl || !token
    || !Number.isSafeInteger(dailyLimit) || dailyLimit < 1
    || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    return undefined
  }

  try {
    const url = new URL(budgetUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return undefined
    }
    return { accessKey, accountSlug, projectSlug, budget: { url: url.origin, token, dailyLimit, maxConcurrent } }
  }
  catch {
    return undefined
  }
}

export const viemStateOverridesToTenderly = (
  overrides: ViemStateOverrideEntry[],
): Record<string, { storage: Record<string, string> }> => {
  const result: Record<string, { storage: Record<string, string> }> = {}

  for (const entry of overrides) {
    if (!entry.stateDiff?.length) continue

    const storage: Record<string, string> = {}
    for (const diff of entry.stateDiff) {
      storage[diff.slot] = diff.value
    }

    const key = entry.address.toLowerCase()
    const existing = result[key]
    if (existing) {
      result[key] = { storage: { ...existing.storage, ...storage } }
    }
    else {
      result[key] = { storage }
    }
  }

  return result
}
