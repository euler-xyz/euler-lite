import type { Address, Hex } from 'viem'
import { CLOSE_POSITION_WRAPPER_ABI } from '~/abis/cowswap-wrapper'
import { logWarn } from '~/utils/errorHandling'
import {
  type CowSwapClosePositionExecuteParams,
  type CowSwapOrderUid,
  getCowSwapChainConfig,
  buildClosePositionWrapperData,
  buildClosePositionQuoteAppData,
  buildCowSwapAppData,
  buildCowSwapOrderTypedData,
  buildCowSwapOrderPayload,
  encodeOrderDataForInbox,
  buildInboxSignature,
  verifyInboxDomainSeparator,
  INBOX_DOMAIN_NAME,
  INBOX_DOMAIN_VERSION,
  validateCowSwapQuoteOrderAmounts,
} from '~/entities/cowswap'
import { useCowSwapExecutionCore } from './useCowSwapExecutionCore'

export const useCowSwapClosePositionExecution = () => {
  const core = useCowSwapExecutionCore()

  const waitForNextBlock = async (client: ReturnType<typeof core.requireRpc>, timeoutMs = 30_000) => {
    const startBlock = await client.getBlockNumber()
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1_000))
      const currentBlock = await client.getBlockNumber()
      if (currentBlock > startBlock) {
        return
      }
    }
  }

  const executeAsync = async (params: CowSwapClosePositionExecuteParams): Promise<CowSwapOrderUid> => {
    core.requireWallet()
    const client = core.requireRpc()
    const chainConfig = getCowSwapChainConfig(params.chainId)
    if (!chainConfig) throw new Error(`CowSwap not supported on chain ${params.chainId}`)
    core.configurePermitCancellation()

    if (params.sellAmount <= 0n) throw new Error('Sell amount must be greater than zero')
    if (params.buyAmount <= 0n) throw new Error('Buy amount must be greater than zero')

    core.error.value = null

    try {
      validateCowSwapQuoteOrderAmounts(params.quote, {
        sellAmount: params.sellAmount,
        buyAmount: params.buyAmount,
        slippage: params.slippage,
        slippageTarget: params.orderKind === 'buy' ? 'sellAmount' : 'buyAmount',
        maxSellAmount: params.maxSellAmount,
        expectedSellAmount: params.expectedSellAmount,
        expectedBuyAmount: params.expectedBuyAmount,
        expectedAppData: params.expectedAppData,
        actualAppData: buildClosePositionQuoteAppData(
          params.wrapper,
          chainConfig.closePositionWrapper,
          params.slippageBips,
        ),
      })

      // Step 1: Fetch Inbox address and domain separator
      core.status.value = 'fetching_inbox'

      const wrapperAddress = chainConfig.closePositionWrapper
      const [inboxAddress, inboxDomainSep] = await client.readContract({
        address: wrapperAddress,
        abi: CLOSE_POSITION_WRAPPER_ABI as readonly unknown[],
        functionName: 'getInboxAddressAndDomainSeparator',
        args: [params.wrapper.owner, params.wrapper.account],
      }) as [Address, Hex]

      // Verify the domain separator matches our expectation
      verifyInboxDomainSeparator(inboxAddress, params.chainId, inboxDomainSep)

      const inboxCode = await client.getCode({ address: inboxAddress })
      if (!inboxCode || inboxCode === '0x') {
        await core.writeContractAndWait({
          address: wrapperAddress,
          abi: CLOSE_POSITION_WRAPPER_ABI,
          functionName: 'getInbox',
          args: [params.wrapper.owner, params.wrapper.account],
        })

        // The orderbook validates EIP-1271 signatures against its own RPCs.
        // Waiting one more block after the deployment receipt reduces races
        // where our node has the Inbox code but the orderbook's backend does not yet.
        await waitForNextBlock(client)
      }

      // Step 2: No user-side approvals needed (Inbox handles internally)
      // Fetch EVC nonce + permit data, sign EVC permit
      core.status.value = 'signing_permit'

      const wrapperParams = {
        owner: params.wrapper.owner,
        account: params.wrapper.account,
        deadline: BigInt(params.wrapper.deadline),
        borrowVault: params.wrapper.borrowVault,
        collateralVault: params.wrapper.collateralVault,
        collateralAmount: params.wrapper.collateralAmount,
      }

      const { nonce, nonceNamespace, permitCalldata, evcAddress } = await core.fetchNonceAndPermitData(
        wrapperAddress,
        CLOSE_POSITION_WRAPPER_ABI,
        wrapperParams,
        params.chainId,
      )

      const permitSignature = await core.signEvcPermit({
        permitCalldata,
        chainId: params.chainId,
        evcAddress,
        wrapperAddress,
        nonceNamespace,
        nonce,
        deadline: params.wrapper.deadline,
      })

      // Step 3: Build wrapperData + appData
      core.status.value = 'signing_order'

      const wrapperData = buildClosePositionWrapperData(params.wrapper, permitSignature)
      const { appDataString, appDataHash } = buildCowSwapAppData(
        wrapperData,
        wrapperAddress,
        params.slippageBips,
        'euler_position_close',
      )

      // Build order typed data with Inbox domain (name='Inbox', version='1')
      const orderTypedData = buildCowSwapOrderTypedData({
        chainId: params.chainId,
        settlementContract: chainConfig.settlementContract,
        sellToken: params.sellToken,
        buyToken: params.buyToken,
        receiver: inboxAddress,
        sellAmount: params.sellAmount,
        buyAmount: params.buyAmount,
        validTo: params.validTo,
        appDataHash,
        kind: params.orderKind,
        domainName: INBOX_DOMAIN_NAME,
        domainVersion: INBOX_DOMAIN_VERSION,
        verifyingContract: inboxAddress,
      })

      // Sign the CoW order (user signs over Inbox domain)
      const ecdsaSignature = await core.signOrderTypedData(orderTypedData) as Hex

      // Step 4: Build EIP-1271 signature = concat(ecdsaSig, orderEncodeData)
      const orderEncodeData = encodeOrderDataForInbox({
        sellToken: params.sellToken,
        buyToken: params.buyToken,
        receiver: inboxAddress,
        sellAmount: params.sellAmount,
        buyAmount: params.buyAmount,
        validTo: params.validTo,
        appData: appDataHash,
        feeAmount: 0n,
        kind: params.orderKind,
        partiallyFillable: false,
        sellTokenBalance: 'erc20',
        buyTokenBalance: 'erc20',
      })

      const inboxSig = buildInboxSignature(ecdsaSignature, orderEncodeData)

      // Step 5: Submit (eip1271, from=inboxAddress)
      core.status.value = 'submitting'

      const payload = buildCowSwapOrderPayload(
        orderTypedData,
        inboxSig,
        inboxAddress,
        appDataString,
        appDataHash,
        { signingScheme: 'eip1271', quoteId: params.quoteId },
      )

      return await core.submitAndFinalize(payload, chainConfig.orderbookUrl, params.chainId)
    }
    catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      core.error.value = wrapped
      core.status.value = 'idle'
      logWarn('cowswap/closePosition', wrapped)
      throw wrapped
    }
  }

  return {
    executeAsync,
    cancelOrder: core.cancelOrder,
    reset: core.reset,
    status: core.status,
    orderUid: core.orderUid,
    isPending: core.isPending,
    explorerUrl: core.explorerUrl,
    error: core.error,
    locallyCancelled: core.locallyCancelled,
    cancellationStatus: core.cancellationStatus,
    cancellationMode: core.cancelMode,
  }
}
