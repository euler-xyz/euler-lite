// Unichain fixture from euler-data-v3#660 at b0460d8fdd4a28fdbae2c3bcc86bd58252989d5f.
export const oracleUsdLiquidation = {
  chainId: 130,
  vault: '0xA6be43F0505Da6e37B0805e1A0B7AaCb3065F0c8',
  violator: '0x12e74f3C61F6b4d17a9c3Fdb3F42e8f18a8bB394',
  liquidator: '0x834990FB2F4Ec7B039f1F29051195a15269ffe71',
  collateral: '0x64a1F82F9b7a0DF4CF465329112E03E45c5c297a',
  repayAssets: '8037413',
  yieldBalance: '8152917338544527180',
  debtAsset: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  debtAssetDecimals: 6,
  debtAssetPriceUsd: 0.999809,
  repayAssetsUsd: 8.035877854117,
  collateralAsset: null,
  collateralAssetDecimals: null,
  collateralAssetPriceUsd: null,
  collateralAssets: null,
  collateralAssetsUsd: 8.152917338544528,
  bonusUsd: 0.11703948442752718,
  blockNumber: '54951245',
  timestamp: '2026-08-02T19:40:04.000Z',
  txHash: '0x677ac092cc94a24e0a2c6d759a51dae67575f082577ed29eee5fd976552280e8',
  valuation: { status: 'available', source: 'historical-protocol-oracle' },
  unitOfAccountValuation: {
    source: 'historical-protocol-oracle',
    unitOfAccount: '0x0000000000000000000000000000000000000348',
    unitOfAccountDecimals: 18,
    repayValue: '8035323272620000000',
    collateralValue: '8152917338544527180',
    bonusValue: '117594065924527180',
    blockNumber: '54951245',
  },
} as const

export const liquidationPage = (data: unknown[]) => ({
  data,
  meta: { total: data.length, offset: 0, limit: 100, timestamp: '2026-09-23T00:00:00.000Z' },
})
