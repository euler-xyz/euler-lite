export const walletLaneKey = (account: string, chainId: number) =>
  `wallet:${chainId}:${account.toLowerCase()}`

export const withWalletLaneLock = async <T>(laneKey: string, work: () => Promise<T>): Promise<T> => {
  const locks = globalThis.navigator?.locks
  if (!locks) throw new Error('Web Locks are required for transaction execution')
  return locks.request(`euler-lite-reviewed-execution:${laneKey}`, { mode: 'exclusive' }, work)
}
