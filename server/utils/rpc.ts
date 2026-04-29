export const resolveRpcUrl = (chainId: number): string | undefined => {
  const key = `RPC_URL_${chainId}`
  return process.env[key]
}
