type AssetUnits = { address: string, decimals: number }

/** Reject quote metadata that would relabel the verified wallet debit. */
export const assertSpendingQuoteAsset = (quote: { tokenIn: AssetUnits }, asset: AssetUnits, wrappedAddress?: string | null) => {
  if (quote.tokenIn.address.toLowerCase() !== (wrappedAddress || asset.address).toLowerCase()
    || quote.tokenIn.decimals !== asset.decimals) {
    throw new Error('Quote input does not match verified spending asset')
  }
}
