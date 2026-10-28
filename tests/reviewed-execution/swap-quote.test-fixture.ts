import { SwapVerificationType, type SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { TEST_ACCOUNT, TEST_TOKEN, TEST_VAULT } from './fixtures'

export const makeSwapQuote = (): SwapQuote => ({
  amountIn: '10',
  amountInMax: '11',
  amountOut: '9',
  amountOutMin: '8',
  accountIn: TEST_ACCOUNT,
  accountOut: TEST_ACCOUNT,
  vaultIn: TEST_VAULT,
  receiver: TEST_ACCOUNT,
  tokenIn: { address: TEST_TOKEN, chainId: 1, decimals: 18, logoURI: '', name: 'Input', symbol: 'IN' },
  tokenOut: { address: TEST_VAULT, chainId: 1, decimals: 18, logoURI: '', name: 'Output', symbol: 'OUT' },
  slippage: 0.5,
  swap: { swapperAddress: TEST_VAULT, swapperData: '0x1234', multicallItems: [] },
  verify: { verifierAddress: TEST_VAULT, verifierData: '0x1234', type: SwapVerificationType.SkimMin, vault: TEST_VAULT, account: TEST_ACCOUNT, amount: '8', deadline: 2_000_000_000 },
  route: [{ providerName: 'test' }],
})
