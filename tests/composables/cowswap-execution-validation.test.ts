import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type {
  CowSwapClosePositionExecuteParams,
  CowSwapCollateralSwapExecuteParams,
  CowSwapOpenPositionExecuteParams,
} from '~/entities/cowswap'
import {
  buildClosePositionQuoteAppData,
  buildCollateralSwapQuoteAppData,
  buildOpenPositionQuoteAppData,
  getCowSwapChainConfig,
} from '~/entities/cowswap'
import type { SwapApiQuote } from '~/entities/swap'
import { SwapVerificationType } from '~/entities/swap'
import { useCowSwapClosePositionExecution } from '~/composables/cowswap/useCowSwapClosePositionExecution'
import { useCowSwapCollateralSwapExecution } from '~/composables/cowswap/useCowSwapCollateralSwapExecution'
import { useCowSwapOpenPositionExecution } from '~/composables/cowswap/useCowSwapOpenPositionExecution'

const { core } = vi.hoisted(() => ({
  core: {
    requireWallet: vi.fn(),
    requireRpc: vi.fn(),
    configureCowApiCancellation: vi.fn(),
    configurePermitCancellation: vi.fn(),
    safeApprove: vi.fn(),
    fetchNonceAndPermitData: vi.fn(),
    signEvcPermit: vi.fn(),
    signOrderTypedData: vi.fn(),
    submitAndFinalize: vi.fn(),
    writeContractAndWait: vi.fn(),
    cancelOrder: vi.fn(),
    reset: vi.fn(),
    status: { value: 'idle' },
    orderUid: { value: undefined },
    isPending: { value: false },
    explorerUrl: { value: undefined },
    error: { value: null as Error | null },
    locallyCancelled: { value: false },
    cancellationStatus: { value: 'none' },
    cancelMode: { value: undefined },
  },
}))

vi.mock('~/composables/cowswap/useCowSwapExecutionCore', () => ({
  useCowSwapExecutionCore: () => core,
}))

const addr = (suffix: string) => `0x${suffix.padStart(40, '0')}` as Address
const chainConfig = getCowSwapChainConfig(1)!

const makeQuote = (): SwapApiQuote => ({
  amountIn: '1007',
  amountInMax: '1013',
  amountOut: '2500',
  amountOutMin: '2487',
  accountIn: addr('1'),
  accountOut: addr('1'),
  vaultIn: addr('2'),
  receiver: addr('3'),
  tokenIn: { address: addr('4'), chainId: 1, decimals: 18, logoURI: '', name: 'In', symbol: 'IN' },
  tokenOut: { address: addr('5'), chainId: 1, decimals: 18, logoURI: '', name: 'Out', symbol: 'OUT' },
  slippage: 0.5,
  swap: { swapperAddress: addr('6'), swapperData: '0x', multicallItems: [] },
  verify: {
    verifierAddress: addr('7'),
    verifierData: '0x',
    type: SwapVerificationType.SkimMin,
    vault: addr('8'),
    account: addr('1'),
    amount: '0',
    deadline: 0,
  },
  route: [{ providerName: 'cow' }],
  providerData: {
    sellAmount: '1000',
    buyAmount: '2500',
    feeAmount: '7',
  },
})

describe('CowSwap execution quote validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    core.requireWallet.mockReturnValue(addr('9'))
    core.requireRpc.mockReturnValue({
      readContract: vi.fn(),
      getCode: vi.fn(),
      getBlockNumber: vi.fn(),
    })
    core.status.value = 'idle'
    core.error.value = null
  })

  it('rejects open-position stale sell amount before approvals', async () => {
    const execution = useCowSwapOpenPositionExecution()
    const params: CowSwapOpenPositionExecuteParams = {
      chainId: 1,
      quote: makeQuote(),
      expectedSellAmount: 1006n,
      sellToken: addr('4'),
      buyToken: addr('5'),
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: 0.5,
      slippageBips: 50,
      validTo: 100,
      collateralToken: addr('10'),
      wrapper: {
        owner: addr('9'),
        account: addr('1'),
        deadline: 100,
        collateralVault: addr('11'),
        borrowVault: addr('2'),
        collateralAmount: 1n,
        borrowAmount: 1006n,
      },
    }
    params.expectedAppData = buildOpenPositionQuoteAppData(
      params.wrapper,
      chainConfig.openPositionWrapper,
      params.slippageBips,
    )
    params.quote.providerData!.appData = params.expectedAppData

    await expect(execution.executeAsync(params)).rejects.toThrow('CoW quote sell amount does not match requested amount')
    expect(core.safeApprove).not.toHaveBeenCalled()
    expect(core.fetchNonceAndPermitData).not.toHaveBeenCalled()
    expect(core.error.value?.message).toBe('CoW quote sell amount does not match requested amount')
  })

  it('rejects collateral-swap stale sell amount before approvals', async () => {
    const execution = useCowSwapCollateralSwapExecution()
    const params: CowSwapCollateralSwapExecuteParams = {
      chainId: 1,
      quote: makeQuote(),
      expectedSellAmount: 1006n,
      sellToken: addr('4'),
      buyToken: addr('5'),
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: 0.5,
      slippageBips: 50,
      validTo: 100,
      wrapper: {
        owner: addr('9'),
        account: addr('1'),
        deadline: 100,
        fromVault: addr('2'),
        toVault: addr('3'),
        fromAmount: 1006n,
        disableSourceCollateral: false,
      },
    }
    params.expectedAppData = buildCollateralSwapQuoteAppData(
      params.wrapper,
      chainConfig.collateralSwapWrapper,
      params.slippageBips,
    )
    params.quote.providerData!.appData = params.expectedAppData

    await expect(execution.executeAsync(params)).rejects.toThrow('CoW quote sell amount does not match requested amount')
    expect(core.safeApprove).not.toHaveBeenCalled()
    expect(core.fetchNonceAndPermitData).not.toHaveBeenCalled()
    expect(core.error.value?.message).toBe('CoW quote sell amount does not match requested amount')
  })

  it('rejects close-position target-debt stale buy amount before inbox reads', async () => {
    const execution = useCowSwapClosePositionExecution()
    const params: CowSwapClosePositionExecuteParams = {
      chainId: 1,
      quote: makeQuote(),
      expectedBuyAmount: 2499n,
      sellToken: addr('4'),
      buyToken: addr('5'),
      sellAmount: 1013n,
      buyAmount: 2500n,
      slippage: 0.5,
      slippageBips: 50,
      validTo: 100,
      orderKind: 'buy',
      wrapper: {
        owner: addr('9'),
        account: addr('1'),
        deadline: 100,
        borrowVault: addr('2'),
        collateralVault: addr('3'),
        collateralAmount: 1013n,
      },
    }
    params.expectedAppData = buildClosePositionQuoteAppData(
      params.wrapper,
      chainConfig.closePositionWrapper,
      params.slippageBips,
    )
    params.quote.providerData!.appData = params.expectedAppData

    await expect(execution.executeAsync(params)).rejects.toThrow('CoW quote buy amount does not match requested amount')
    expect(core.requireRpc().readContract).not.toHaveBeenCalled()
    expect(core.fetchNonceAndPermitData).not.toHaveBeenCalled()
    expect(core.error.value?.message).toBe('CoW quote buy amount does not match requested amount')
  })

  it('rejects close-position orders missing appData binding before inbox reads', async () => {
    const execution = useCowSwapClosePositionExecution()
    const params: CowSwapClosePositionExecuteParams = {
      chainId: 1,
      quote: makeQuote(),
      sellToken: addr('4'),
      buyToken: addr('5'),
      sellAmount: 1013n,
      buyAmount: 2500n,
      slippage: 0.5,
      slippageBips: 50,
      validTo: 100,
      orderKind: 'buy',
      wrapper: {
        owner: addr('9'),
        account: addr('1'),
        deadline: 100,
        borrowVault: addr('2'),
        collateralVault: addr('3'),
        collateralAmount: 1013n,
      },
    }

    await expect(execution.executeAsync(params)).rejects.toThrow('CoW quote appData is missing request binding')
    expect(core.requireRpc().readContract).not.toHaveBeenCalled()
    expect(core.fetchNonceAndPermitData).not.toHaveBeenCalled()
    expect(core.error.value?.message).toBe('CoW quote appData is missing request binding')
  })

  it('rejects close-position stale appData before inbox reads', async () => {
    const execution = useCowSwapClosePositionExecution()
    const params: CowSwapClosePositionExecuteParams = {
      chainId: 1,
      quote: makeQuote(),
      expectedBuyAmount: 2500n,
      expectedAppData: '{"stale":true}',
      sellToken: addr('4'),
      buyToken: addr('5'),
      sellAmount: 1013n,
      buyAmount: 2500n,
      slippage: 0.5,
      slippageBips: 50,
      validTo: 100,
      orderKind: 'buy',
      wrapper: {
        owner: addr('9'),
        account: addr('1'),
        deadline: 100,
        borrowVault: addr('2'),
        collateralVault: addr('3'),
        collateralAmount: 1013n,
      },
    }
    params.quote.providerData!.appData = params.expectedAppData

    await expect(execution.executeAsync(params)).rejects.toThrow('CoW quote appData does not match requested order')
    expect(core.requireRpc().readContract).not.toHaveBeenCalled()
    expect(core.fetchNonceAndPermitData).not.toHaveBeenCalled()
    expect(core.error.value?.message).toBe('CoW quote appData does not match requested order')
  })
})
