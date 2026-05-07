// Base hue for the app theme in degrees (0-360). Change to shift the brand palette.
export const themeHue = 150

// Intrinsic APY sources (data mapping, not deployment config)
export type IntrinsicApySourceConfig
  = | { provider: 'defillama', address: string, chainId: number, poolId: string, useSpotApy?: boolean }
    | { provider: 'pendle', address: string, chainId: number, pendleMarket: string, crossChainSourceChainId?: number }
    | { provider: 'securitize', address: string, chainId: number, symbol: string, yieldField: 'nav_yield_30d' | 'distribution_yield' }
    | { provider: 'stablewatch', address: string, chainId: number }
    | { provider: 'etherfi', address: string, chainId: number }
    | { provider: 'renzo', address: string, chainId: number, renzoVariant: 'ezETH' | 'pzETH' }
    | { provider: 'midas', address: string, chainId: number, midasKey: string }
    | { provider: 'yo', address: string, chainId: number }
    | { provider: 'spark', address: string, chainId: number }
    | { provider: 'puffer', address: string, chainId: number }
    | { provider: 'treehouse', address: string, chainId: number }
    | { provider: 'ondo', address: string, chainId: number }
    | { provider: 'benqi', address: string, chainId: number }
    | { provider: 'avant', address: string, chainId: number }
    | { provider: 'infinifi', address: string, chainId: number, infinifiVariant: 'locked' | 'staked', infinifiLockedKey?: string }
    | { provider: 'accountable', address: string, chainId: number, loanAddress: string }

export const intrinsicApySources: readonly IntrinsicApySourceConfig[] = [
  // DefiLlama pools — Ethereum (1)
  { provider: 'defillama', chainId: 1, address: '0x0655977FEb2f289A4aB78af67BAB0d17aAb84367', poolId: '5fd328af-4203-471b-bd16-1705c726d926' },
  { provider: 'defillama', chainId: 1, address: '0x09db87A538BD693E9d08544577d5cCfAA6373A48', poolId: '44dd4153-aa9f-4616-9a88-e6803c86b995' },
  { provider: 'defillama', chainId: 1, address: '0x0d86883FAf4FfD7aEb116390af37746F45b6f378', poolId: '9c4e675e-7615-4d60-90ef-03d58c66b476' },
  { provider: 'defillama', chainId: 1, address: '0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055', poolId: '0aedb3f6-9298-49de-8bb0-2f611a4df784' },
  { provider: 'defillama', chainId: 1, address: '0x12b004719fb632f1E7c010c6F5D6009Fb4258442', poolId: 'fef01bce-008a-43b0-85f9-5377a56411c4' },
  { provider: 'defillama', chainId: 1, address: '0x35D8949372D46B7a3D5A56006AE77B215fc69bC0', poolId: '55b0893b-1dbb-47fd-9912-5e439cd3d511' },
  { provider: 'defillama', chainId: 1, address: '0x3d7d6fdf07EE548B939A80edbc9B2256d0cdc003', poolId: '843be062-d836-43ef-9670-c78d6ecb60bf' },
  { provider: 'defillama', chainId: 1, address: '0x3eE841F47947FEFbE510366E4bbb49e145484195', poolId: '6258d8cc-e618-4165-9385-7775168369b2' },
  { provider: 'defillama', chainId: 1, address: '0x4956b52aE2fF65D74CA2d61207523288e4528f96', poolId: '2ad8497d-c855-4840-85ad-cdc536b92ced' },
  { provider: 'defillama', chainId: 1, address: '0x5fD13359Ba15A84B76f7F87568309040176167cd', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },
  { provider: 'defillama', chainId: 1, address: '0x657d9ABA1DBb59e53f9F3eCAA878447dCfC96dCb', poolId: 'e3c59895-d6ad-4634-b257-f599f1a1a4a0' },
  { provider: 'defillama', chainId: 1, address: '0x738d1115B90efa71AE468F1287fc864775e23a31', poolId: '402b0554-9525-40af-8703-3c59b0aa863c' },
  { provider: 'defillama', chainId: 1, address: '0x7a4EffD87C2f3C55CA251080b1343b605f327E3a', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },
  { provider: 'defillama', chainId: 1, address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },
  { provider: 'defillama', chainId: 1, address: '0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b', poolId: '43641cf5-a92e-416b-bce9-27113d3c0db6' },
  { provider: 'defillama', chainId: 1, address: '0x83F20F44975D03b1b09e64809B757c47f942BEeA', poolId: 'c8a24fee-ec00-4f38-86c0-9f6daebc4225' },
  { provider: 'defillama', chainId: 1, address: '0x856c4Efb76C1D1AE02e20CEB03A2A6a08b0b8dC3', poolId: '423681e3-4787-40ce-ae43-e9f67c5269b3' },
  { provider: 'defillama', chainId: 1, address: '0x88887bE419578051FF9F4eb6C858A951921D8888', poolId: 'bf6ca887-e357-49ec-8031-0d1a6141c455' },
  { provider: 'defillama', chainId: 1, address: '0x90455bd11Ce8a67C57d467e634Dc142b8e4105Aa', poolId: '08d1f13b-5d65-42c5-863d-fcb447dcea75' },
  { provider: 'defillama', chainId: 1, address: '0x9FD7466f987Fd4C45a5BBDe22ED8aba5BC8D72d1', poolId: '5de6008f-1be1-4ce6-b5f5-025bec262bc1' },
  { provider: 'defillama', chainId: 1, address: '0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },
  { provider: 'defillama', chainId: 1, address: '0xA35b1B31Ce002FBF2058D22F30f95D405200A15b', poolId: '90bfb3c2-5d35-4959-a275-ba5085b08aa3' },
  { provider: 'defillama', chainId: 1, address: '0xae78736Cd615f374D3085123A210448E74Fc6393', poolId: 'd4b3c522-6127-4b89-bedf-83641cdcd2eb' },
  { provider: 'defillama', chainId: 1, address: '0xb45ad160634c528Cc3D2926d9807104FA3157305', poolId: 'bf0f95c9-bc46-467d-9762-1d80ff50cd74' },
  { provider: 'defillama', chainId: 1, address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', poolId: '0f45d730-b279-4629-8e11-ccb5cc3038b4' },
  { provider: 'defillama', chainId: 1, address: '0xBEEF69Ac7870777598A04B2bd4771c71212E6aBc', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },
  { provider: 'defillama', chainId: 1, address: '0xC58D044404d8B14e953C115E67823784dEA53d8F', poolId: '8352355c-5ad7-45c5-aca2-628de224f8d8' },
  { provider: 'defillama', chainId: 1, address: '0xc824A08dB624942c5E5F330d56530cD1598859fD', poolId: 'bb925c10-033a-488d-90c1-595001b5656e' },
  { provider: 'defillama', chainId: 1, address: '0xc8CF6D7991f15525488b2A83Df53468D682Ba4B0', poolId: '0f67a08c-3f24-4a4b-963e-541f5a5c0364' },
  { provider: 'defillama', chainId: 1, address: '0xcf62F905562626CfcDD2261162a51fd02Fc9c5b6', poolId: '42523cca-14b0-44f6-95fb-4781069520a5' },
  { provider: 'defillama', chainId: 1, address: '0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa', poolId: 'b9f2f00a-ba96-4589-a171-dde979a23d87' },
  { provider: 'defillama', chainId: 1, address: '0xDcEe70654261AF21C44c093C300eD3Bb97b78192', poolId: '423681e3-4787-40ce-ae43-e9f67c5269b3' },
  { provider: 'defillama', chainId: 1, address: '0xE72B141DF173b999AE7c1aDcbF60Cc9833Ce56a8', poolId: '4e6cd326-72d5-4680-8d2f-3481d50e8bb1' },
  { provider: 'defillama', chainId: 1, address: '0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38', poolId: '4d01599c-69ae-41a3-bae1-5fab896f04c8' },
  { provider: 'defillama', chainId: 1, address: '0xf951E335afb289353dc249e82926178EaC7DEd78', poolId: 'ca2acc2d-6246-44aa-ae91-8725b2c62c7c' },
  { provider: 'defillama', chainId: 1, address: '0xFAe103DC9cf190eD75350761e95403b7b8aFa6c0', poolId: 'eff9b43c-a80d-4bfc-9f9e-55e02a8ef619' },
  { provider: 'defillama', chainId: 1, address: '0xE24a3DC889621612422A64E6388927901608B91D', poolId: 'afddf12f-59fb-4e1a-9748-27943cbb4f79' },
  { provider: 'defillama', chainId: 1, address: '0x50Bd66D59911F5e086Ec87aE43C811e0D059DD11', poolId: 'aea51635-6a47-4538-85e6-878421312271' },
  { provider: 'defillama', chainId: 1, address: '0x271C616157e69A43B4977412A64183Cf110Edf16', poolId: 'f7c345b1-d545-43c3-baf3-9c9135854f19' },
  { provider: 'defillama', chainId: 1, address: '0xdd50C053C096CB04A3e3362E2b622529EC5f2e8a', poolId: 'e140f3b2-0327-46ea-93f5-88b17b0a0a16' },
  { provider: 'defillama', chainId: 1, address: '0x7743e50F534a7f9F1791DdE7dCD89F7783Eefc39', poolId: 'ee0b7069-f8f3-4aa2-a415-728f13e6cc3d' },
  { provider: 'defillama', chainId: 1, address: '0x3db228fe836d99ccb25ec4dfdc80ed6d2cddcb4b', poolId: 'bc8b5474-015a-4af5-8d88-3b4b6155b56e' },
  { provider: 'defillama', chainId: 1, address: '0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8', poolId: '21617aef-e012-49dd-bb8f-a624d8bcd469' },
  { provider: 'defillama', chainId: 1, address: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', poolId: '66985a81-9c51-46ca-9977-42b4fe7bc6df' },
  { provider: 'defillama', chainId: 1, address: '0x007115416AB6c266329a03B09a8aa39aC2eF7d9d', poolId: '37bdb634-87d4-4eca-8b73-343653bd9a25' },
  { provider: 'defillama', chainId: 1, address: '0x030b69280892c888670EDCDCD8B69Fd8026A0BF3', poolId: '0ffd2dc2-72d2-449f-8cac-34a09ce6f323' },
  { provider: 'defillama', chainId: 1, address: '0x12fd502e2052CaFB41eccC5B596023d9978057d6', poolId: '69021e5e-7cae-4df4-915e-08a6b349f456' },
  { provider: 'defillama', chainId: 1, address: '0x2a8c22E3b10036f3AEF5875d04f8441d4188b656', poolId: 'b50e0e37-2256-466b-9030-168c515a2ca4' },
  { provider: 'defillama', chainId: 1, address: '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153', poolId: '24b3096a-488d-4a61-afa6-e5e9be2ce4bf' },
  { provider: 'defillama', chainId: 1, address: '0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94', poolId: 'b7daea94-6378-4eeb-8d10-52beebadf77b' },
  { provider: 'defillama', chainId: 1, address: '0xbB51E2a15A9158EBE2b0Ceb8678511e063AB7a55', poolId: 'd48e9c5a-7c28-4192-ab3d-795b5fbed7be' },

  // DefiLlama pools — BSC (56)
  { provider: 'defillama', chainId: 56, address: '0x211Cc4DD073734DA055fbF44a2b4667d5E5fE5d2', poolId: '66985a81-9c51-46ca-9977-42b4fe7bc6df' },
  { provider: 'defillama', chainId: 56, address: '0x32C830f5c34122C6afB8aE87ABA541B7900a2C5F', poolId: '89818a06-3414-4d9d-a8a6-7c8686a40d2a' },

  // DefiLlama pools — Unichain (130)
  { provider: 'defillama', chainId: 130, address: '0x94Cac393f3444cEf63a651FfC18497E7e8bd036a', poolId: 'd4b3c522-6127-4b89-bedf-83641cdcd2eb' },
  { provider: 'defillama', chainId: 130, address: '0xc02fE7317D4eb8753a02c35fe019786854A92001', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },
  { provider: 'defillama', chainId: 130, address: '0xc3eACf0612346366Db554C991D7858716db09f58', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },

  // DefiLlama pools — Monad (143)
  { provider: 'defillama', chainId: 143, address: '0x10Aeaf63194db8d453d4D85a06E5eFE1dd0b5417', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },
  { provider: 'defillama', chainId: 143, address: '0x1b68626dca36c7fe922fd2d55e4f631d962de19c', poolId: 'ee40513c-9356-4c53-9f26-446b484a8ae2' },

  // Accountable loans — Monad (143)
  { provider: 'accountable', chainId: 143, address: '0x8d3F9f9Eb2f5E8B48EFBB4074440D1E2A34Bc365', loanAddress: '0x8dCE15fc6a98484C995Fc702cBfBdA14A30454af' },

  // DefiLlama pools — Sonic (146)
  { provider: 'defillama', chainId: 146, address: '0x16af6b1315471Dc306D47e9CcEfEd6e5996285B6', poolId: '24b3096a-488d-4a61-afa6-e5e9be2ce4bf' },
  { provider: 'defillama', chainId: 146, address: '0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926', poolId: 'b7daea94-6378-4eeb-8d10-52beebadf77b' },
  { provider: 'defillama', chainId: 146, address: '0xB88fF15ae5f82c791e637b27337909BcF8065270', poolId: '69021e5e-7cae-4df4-915e-08a6b349f456' },

  // DefiLlama pools — TAC (239)
  { provider: 'defillama', chainId: 239, address: '0x1791BAff6a5e2F2A1340e8B7C1EA2B0c1E2DD1ea', poolId: '55b0893b-1dbb-47fd-9912-5e439cd3d511' },
  { provider: 'defillama', chainId: 239, address: '0x5448BBf60Ee2edBCd32F032f3294982f4ad1119e', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },
  { provider: 'defillama', chainId: 239, address: '0xAf368c91793CB22739386DFCbBb2F1A9e4bCBeBf', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },

  // DefiLlama pools — Swell (1923)
  { provider: 'defillama', chainId: 1923, address: '0x211Cc4DD073734DA055fbF44a2b4667d5E5fE5d2', poolId: '66985a81-9c51-46ca-9977-42b4fe7bc6df' },
  { provider: 'defillama', chainId: 1923, address: '0x09341022ea237a4DB1644DE7CCf8FA0e489D85B7', poolId: 'ca2acc2d-6246-44aa-ae91-8725b2c62c7c' },
  { provider: 'defillama', chainId: 1923, address: '0x18d33689AE5d02649a859A1CF16c9f0563975258', poolId: 'eff9b43c-a80d-4bfc-9f9e-55e02a8ef619' },
  { provider: 'defillama', chainId: 1923, address: '0x7c98E0779EB5924b3ba8cE3B17648539ed5b0Ecc', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },
  { provider: 'defillama', chainId: 1923, address: '0xc3eACf0612346366Db554C991D7858716db09f58', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },

  // DefiLlama pools — Base (8453)
  { provider: 'defillama', chainId: 8453, address: '0x1Bc71130A0e39942a7658878169764Bbd8A45993', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },
  { provider: 'defillama', chainId: 8453, address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', poolId: '0f45d730-b279-4629-8e11-ccb5cc3038b4' },
  { provider: 'defillama', chainId: 8453, address: '0x7FcD174E80f264448ebeE8c88a7C4476AAF58Ea6', poolId: 'f388573e-5c0f-4dac-9f70-116a4aabaf17' },
  { provider: 'defillama', chainId: 8453, address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', poolId: 'd4b3c522-6127-4b89-bedf-83641cdcd2eb' },
  { provider: 'defillama', chainId: 8453, address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },
  { provider: 'defillama', chainId: 8453, address: '0xEDfa23602D0EC14714057867A78d01e94176BEA0', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },

  // DefiLlama pools — Plasma (9745)
  { provider: 'defillama', chainId: 9745, address: '0x6eAf19b2FC24552925dB245F9Ff613157a7dbb4C', poolId: 'b7daea94-6378-4eeb-8d10-52beebadf77b' },
  { provider: 'defillama', chainId: 9745, address: '0x4809010926aec940b550D34a46A52739f996D75D', poolId: '402b0554-9525-40af-8703-3c59b0aa863c' },
  { provider: 'defillama', chainId: 9745, address: '0x9eCaf80c1303CCA8791aFBc0AD405c8a35e8d9f1', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },
  { provider: 'defillama', chainId: 9745, address: '0xC4374775489CB9C56003BF2C9b12495fC64F0771', poolId: '8edfdf02-cdbb-43f7-bca6-954e5fe56813' },
  { provider: 'defillama', chainId: 9745, address: '0xe561FE05C39075312Aa9Bc6af79DdaE981461359', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },

  // DefiLlama pools — Arbitrum (42161)
  { provider: 'defillama', chainId: 42161, address: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2', poolId: '66985a81-9c51-46ca-9977-42b4fe7bc6df' },
  { provider: 'defillama', chainId: 42161, address: '0x35E5dB674D8e93a03d814FA0ADa70731efe8a4b9', poolId: '2ad8497d-c855-4840-85ad-cdc536b92ced' },
  { provider: 'defillama', chainId: 42161, address: '0x4186BFC76E2E237523CBC30FD220FE055156b41F', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },
  { provider: 'defillama', chainId: 42161, address: '0x41CA7586cC1311807B4605fBB748a3B8862b42b5', poolId: '43641cf5-a92e-416b-bce9-27113d3c0db6' },
  { provider: 'defillama', chainId: 42161, address: '0x5979D7b546E38E414F7E9822514be443A4800529', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },
  { provider: 'defillama', chainId: 42161, address: '0x66CFbD79257dC5217903A36293120282548E2254', poolId: '0aedb3f6-9298-49de-8bb0-2f611a4df784' },
  { provider: 'defillama', chainId: 42161, address: '0xdDb46999F8891663a8F2828d25298f70416d7610', poolId: 'd8c4eff5-c8a9-46fc-a888-057c4c668e72' },
  { provider: 'defillama', chainId: 42161, address: '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8', poolId: 'd4b3c522-6127-4b89-bedf-83641cdcd2eb' },

  // DefiLlama pools — Avalanche (43114)
  { provider: 'defillama', chainId: 43114, address: '0x211Cc4DD073734DA055fbF44a2b4667d5E5fE5d2', poolId: '66985a81-9c51-46ca-9977-42b4fe7bc6df' },
  { provider: 'defillama', chainId: 43114, address: '0x7bFd4CA2a6Cf3A3fDDd645D10B323031afe47FF0', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },
  { provider: 'defillama', chainId: 43114, address: '0xA25EaF2906FA1a3a13EdAc9B9657108Af7B703e3', poolId: '3efc0d84-53c6-4c6a-b1c3-c140502c7f26' },

  // DefiLlama pools — Linea (59144)
  { provider: 'defillama', chainId: 59144, address: '0x211Cc4DD073734DA055fbF44a2b4667d5E5fE5d2', poolId: '66985a81-9c51-46ca-9977-42b4fe7bc6df' },
  { provider: 'defillama', chainId: 59144, address: '0x4809010926aec940b550D34a46A52739f996D75D', poolId: '402b0554-9525-40af-8703-3c59b0aa863c' },
  { provider: 'defillama', chainId: 59144, address: '0xB5beDd42000b71FddE22D3eE8a79Bd49A568fC8F', poolId: '747c1d2a-c668-4682-b9f9-296708a3dd90' },
  { provider: 'defillama', chainId: 59144, address: '0xD2671165570f41BBB3B0097893300b6EB6101E6C', poolId: '33c732f6-a78d-41da-af5b-ccd9fa5e52d5' },

  // DefiLlama pools — BOB (60808)
  { provider: 'defillama', chainId: 60808, address: '0x85008aE6198BC91aC0735CB5497CF125ddAAc528', poolId: 'e28e32b5-e356-41d9-8dc7-a376ece56619' },
  { provider: 'defillama', chainId: 60808, address: '0x96147A9Ae9a42d7Da551fD2322ca15B71032F342', poolId: 'e28e32b5-e356-41d9-8dc7-a376ece56619' },
  { provider: 'defillama', chainId: 60808, address: '0xB5686c4f60904Ec2BDA6277d6FE1F7cAa8D1b41a', poolId: 'd4b3c522-6127-4b89-bedf-83641cdcd2eb' },

  // DefiLlama pools — Berachain (80094)
  { provider: 'defillama', chainId: 80094, address: '0x211Cc4DD073734DA055fbF44a2b4667d5E5fE5d2', poolId: '66985a81-9c51-46ca-9977-42b4fe7bc6df' },
  { provider: 'defillama', chainId: 80094, address: '0x1d22592F66Fc92e0a64eE9300eAeca548cd466c5', poolId: '30dd2264-82da-40d1-b28d-87e94fc9c2e7' },
  { provider: 'defillama', chainId: 80094, address: '0x5475611Dffb8ef4d697Ae39df9395513b6E947d7', poolId: '402b0554-9525-40af-8703-3c59b0aa863c' },
  { provider: 'defillama', chainId: 80094, address: '0x69f1E971257419B1E9C405A553f252c64A29A30a', poolId: '9b8da01e-a2d6-427b-95ef-96df8de8d32f' },
  { provider: 'defillama', chainId: 80094, address: '0xEc901DA9c68E90798BbBb74c11406A32A70652C3', poolId: 'e28e32b5-e356-41d9-8dc7-a376ece56619' },
  { provider: 'defillama', chainId: 80094, address: '0xFace73a169e2CA2934036C8Af9f464b5De9eF0ca', poolId: '9ccbebab-a66d-4b9e-bf6a-47ea1d638874' },

  // Pendle PTs — Ethereum (1)
  { provider: 'pendle', address: '0x9Bf45ab47747F4B4dD09B3C2c73953484b4eB375', chainId: 1, pendleMarket: '0xAFB7d6d1e9BcA5B675aDC9b4f52F0CDfDdec9654' }, // PT-srUSDe-2APR2026
  { provider: 'pendle', address: '0xd0609Ac13000d88B0BEbf5Bb21074916eDd92Bb1', chainId: 1, pendleMarket: '0xfAbEEFC5369aA5270B401f4Ee062D17fb5f1EC2A' }, // PT-jrUSDe-2APR2026
  { provider: 'pendle', address: '0xB1e926428ebEc4421cCE1eC6d9ff65d27F4b4bB6', chainId: 1, pendleMarket: '0x0e3735d5Ee96d21426Ee40e7Dcb623513e0b6876' }, // PT-fxSAVE-30APR2026
  { provider: 'pendle', address: '0x67aEeEd39C1675e0Df93Ad8BaB543b17992d433B', chainId: 1, pendleMarket: '0xcd9573442af27a2d050dc6ee199A6b2F98354907' }, // PT-cUSDO-28MAY2026
  { provider: 'pendle', address: '0x5b1578E2604B91bd7b24F86F0E5EF6C024bB3a14', chainId: 1, pendleMarket: '0x7da97FbFAA3020f856C60EB4EF068079A9023Aca' }, // PT-hgETH-25JUN2026
  { provider: 'pendle', address: '0x928FB6ED39100a92B2480f5cbB93453f98D9F4cE', chainId: 1, pendleMarket: '0x9EaAedA23177B7168c55a3A0F937f67919733449' }, // PT-cUSD-23JUL2026
  { provider: 'pendle', address: '0x2d3C279E5FcDF5b793c0a75ed90738D7369B0b83', chainId: 1, pendleMarket: '0xaC24A6f0068d9701EAEa76AB0B418021017F8D59' }, // PT-stcUSD-23JUL2026
  { provider: 'pendle', address: '0x3de0ff76E8b528C092d47b9DaC775931cef80F49', chainId: 1, pendleMarket: '0x8dAe8ECe668cf80d348873F23D456448E8694883' }, // PT-sUSDE-7MAY2026

  // Pendle PTs — Arbitrum (42161)
  { provider: 'pendle', address: '0x1cdDE40e29dA213f42a7fa109ccadca372d9ee1b', chainId: 42161, pendleMarket: '0x8A8A557b90eC79496a18a1f9C9DA8Bbd7DB86Fd3' }, // PT-USDai-18JUN2026
  { provider: 'pendle', address: '0x07bc5bD6cE9A17f0e7aa91e0adbc9070dcb1d1de', chainId: 42161, pendleMarket: '0x299674F6Da858f903D77486FBA50Bc9F2e0Db24D' }, // PT-sUSDai-18JUN2026
  { provider: 'pendle', address: '0xE46271ecb1d5c7c5134868760f10c18b03021ef1', chainId: 42161, pendleMarket: '0x22d95cEC2b962C142FfF9BE88CfC7eF15043419F' }, // PT-thBILL-18JUN2026
  { provider: 'pendle', address: '0xC9d24aD0bB25f34098e226a8c5192dea7bacccae', chainId: 42161, pendleMarket: '0xA8a0DEA40174CfC30fEA9e3A77f182aB33f46E25' }, // PT-USDai-15OCT2026
  { provider: 'pendle', address: '0xB459dB106f645d698e74027eef6019a26a0675cc', chainId: 42161, pendleMarket: '0xcbF629C8d396b1261F81F55175Afa010E94787d8' }, // PT-sUSDai-15OCT2026

  // Pendle PTs — Plasma (9745)
  { provider: 'pendle', address: '0xab509448ad489e2e1341e25cc500f2596464cc82', chainId: 9745, pendleMarket: '0x5Fa69163085efd4767f24639eB1fB87Ed34bBB12' }, // PT-sUSDE-9APR2026
  { provider: 'pendle', address: '0x34C772F9B78590f5AB324be11d87885e36878eee', chainId: 9745, pendleMarket: '0x5F6b7F7105340Ce6e7c8844279f33776262B5180' }, // PT-syrupUSDT-30APR2026

  // Securitize tokens — Ethereum (1)
  { provider: 'securitize', chainId: 1, address: '0x17418038ecF73BA4026c4f428547BF099706F27B', symbol: 'ACRED', yieldField: 'nav_yield_30d' },
  { provider: 'securitize', chainId: 1, address: '0x2255718832bC9fD3bE1CaF75084F4803DA14FF01', symbol: 'VBILL', yieldField: 'distribution_yield' },
  { provider: 'securitize', chainId: 1, address: '0x51C2d74017390CbBd30550179A16A1c28F7210fc', symbol: 'STAC', yieldField: 'nav_yield_30d' },

  // Stablewatch tokens — Ethereum (1)
  { provider: 'stablewatch', chainId: 1, address: '0x89E93172AEF8261Db8437b90c3dCb61545a05317' },

  // Stablewatch tokens — Sonic (146)
  { provider: 'stablewatch', chainId: 146, address: '0x3D75F2BB8aBcDBd1e27443cB5CBCE8A668046C81' },
  { provider: 'stablewatch', chainId: 146, address: '0x9fb76f7ce5FCeAA2C42887ff441D46095E494206' },

  // Stablewatch tokens — TAC (239)
  { provider: 'stablewatch', chainId: 239, address: '0x35533f54740F1F1aA4179E57bA37039dfa16868B' },
  { provider: 'stablewatch', chainId: 239, address: '0x5Ced7F73B76A555CCB372cc0F0137bEc5665F81E' },

  // Stablewatch tokens — Plasma (9745)
  { provider: 'stablewatch', chainId: 9745, address: '0x2a52B289bA68bBd02676640aA9F605700c9e5699' },
  { provider: 'stablewatch', chainId: 9745, address: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2' },
  { provider: 'stablewatch', chainId: 9745, address: '0x0B2b2B2076d95dda7817e785989fE353fe955ef9' },
  { provider: 'stablewatch', chainId: 9745, address: '0x35533f54740F1F1aA4179E57bA37039dfa16868B' },
  { provider: 'stablewatch', chainId: 9745, address: '0xC8A8DF9B210243c55D31c73090F06787aD0A1Bf6' },
  { provider: 'stablewatch', chainId: 9745, address: '0xEbFC8C2Fe73C431Ef2A371AeA9132110aaB50DCa' },
  { provider: 'stablewatch', chainId: 9745, address: '0xfDD22Ce6D1F66bc0Ec89b20BF16CcB6670F55A5a' },

  // Stablewatch tokens — Arbitrum (42161)
  { provider: 'stablewatch', chainId: 42161, address: '0xfDD22Ce6D1F66bc0Ec89b20BF16CcB6670F55A5a' },
  { provider: 'stablewatch', chainId: 42161, address: '0x0B2b2B2076d95dda7817e785989fE353fe955ef9' },

  // Ether.fi — weETH
  { provider: 'etherfi', chainId: 1, address: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee' },
  { provider: 'etherfi', chainId: 130, address: '0x7DCC39B4d1C53CB31e1aBc0e358b43987FEF80f7' },
  { provider: 'etherfi', chainId: 1923, address: '0xA6cB988942610f6731e664379D15fFcfBf282b44' },
  { provider: 'etherfi', chainId: 8453, address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A' },
  { provider: 'etherfi', chainId: 9745, address: '0xA3D68b74bF0528fdD07263c60d6488749044914b' },
  { provider: 'etherfi', chainId: 42161, address: '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe' },
  { provider: 'etherfi', chainId: 43114, address: '0xA3D68b74bF0528fdD07263c60d6488749044914b' },
  { provider: 'etherfi', chainId: 59144, address: '0x1Bf74C010E6320bab11e2e5A532b5AC15e0b8aA6' },

  // Renzo — ezETH / pzETH
  { provider: 'renzo', chainId: 1, address: '0xbf5495Efe5DB9ce00f80364C8B423567e58d2110', renzoVariant: 'ezETH' },
  { provider: 'renzo', chainId: 1, address: '0x8c9532a60E0E7C6BbD2B2c1303F63aCE1c3E9811', renzoVariant: 'pzETH' },
  { provider: 'renzo', chainId: 130, address: '0x2416092f143378750bb29b79eD961ab195CcEea5', renzoVariant: 'ezETH' },
  { provider: 'renzo', chainId: 1923, address: '0x2416092f143378750bb29b79eD961ab195CcEea5', renzoVariant: 'ezETH' },
  { provider: 'renzo', chainId: 1923, address: '0x9cb41CD74D01ae4b4f640EC40f7A60cA1bCF83E7', renzoVariant: 'pzETH' },
  { provider: 'renzo', chainId: 8453, address: '0x2416092f143378750bb29b79eD961ab195CcEea5', renzoVariant: 'ezETH' },
  { provider: 'renzo', chainId: 42161, address: '0x2416092f143378750bb29b79eD961ab195CcEea5', renzoVariant: 'ezETH' },
  { provider: 'renzo', chainId: 59144, address: '0x2416092f143378750bb29b79eD961ab195CcEea5', renzoVariant: 'ezETH' },

  // Midas — mTBILL, mRe7, mHYPER, mAPOLLO, mFONE, mevBTC
  { provider: 'midas', chainId: 1, address: '0xDD629E5241CbC5919847783e6C96B2De4754e438', midasKey: 'mtbill' },
  { provider: 'midas', chainId: 1, address: '0x87C9053C819bB28e0D73d33059E1b3DA80AFb0cf', midasKey: 'mre7' },
  { provider: 'midas', chainId: 1, address: '0x9b5528528656DBC094765E2abB79F293c21191B9', midasKey: 'mhyper' },
  { provider: 'midas', chainId: 1, address: '0x7CF9DEC92ca9FD46f8d86e7798B72624Bc116C05', midasKey: 'mapollo' },
  { provider: 'midas', chainId: 1, address: '0x238a700eD6165261Cf8b2e544ba797BC11e466Ba', midasKey: 'mfone' },
  { provider: 'midas', chainId: 1, address: '0xb64C014307622eB15046C66fF71D04258F5963DC', midasKey: 'mevbtc' },
  { provider: 'midas', chainId: 9745, address: '0xb31BeA5c2a43f942a3800558B1aa25978da75F8a', midasKey: 'mhyper' },

  // YO — yoUSD, yoETH, yoBTC
  { provider: 'yo', chainId: 1, address: '0x0000000f2eB9f69274678c76222B35eEc7588a65' },
  { provider: 'yo', chainId: 1, address: '0x3A43AEC53490CB9Fa922847385D82fe25d0E9De7' },
  { provider: 'yo', chainId: 1, address: '0xbCbc8cb4D1e8ED048a6276a5E94A3e952660BcbC' },
  { provider: 'yo', chainId: 8453, address: '0x0000000f2eB9f69274678c76222B35eEc7588a65' },
  { provider: 'yo', chainId: 8453, address: '0x3A43AEC53490CB9Fa922847385D82fe25d0E9De7' },
  { provider: 'yo', chainId: 8453, address: '0xbCbc8cb4D1e8ED048a6276a5E94A3e952660BcbC' },

  // Spark — sUSDS / sUSDC
  { provider: 'spark', chainId: 1, address: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD' },
  { provider: 'spark', chainId: 130, address: '0x14d9143BEcC348920b68D123687045db49a016C6' },
  { provider: 'spark', chainId: 8453, address: '0x5875eEE11Cf8398102FdAd704C9E96607675467a' },
  { provider: 'spark', chainId: 42161, address: '0x940098b108fB7D0a7E374f6eDED7760787464609' },

  // Puffer — pufETH / xPufETH
  { provider: 'puffer', chainId: 1, address: '0xD7D2802f6b19843ac4DfE25022771FD83b5A7464' },
  { provider: 'puffer', chainId: 1, address: '0xD9A442856C234a39a81a089C06451EBAa4306a72' },

  // Treehouse — tETH
  { provider: 'treehouse', chainId: 1, address: '0xD11c452fc99cF405034ee446803b6F6c1F6d5ED8' },
  { provider: 'treehouse', chainId: 42161, address: '0xd09ACb80C1E8f2291862c4978A008791c9167003' },

  // Ondo — USDY
  { provider: 'ondo', chainId: 1, address: '0x96F6eF951840721AdBF46Ac996b59E0235CB985C' },

  // Benqi — sAVAX
  { provider: 'benqi', chainId: 43114, address: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE' },

  // Avant — savUSD
  { provider: 'avant', chainId: 43114, address: '0x06d47F3fb376649c3A9Dafe069B3D6E35572219E' },

  // InfiniFi — 4w locked, 13w locked, siUSD staked
  { provider: 'infinifi', chainId: 1, address: '0x66bCF6151D5558AfB47c38B20663589843156078', infinifiVariant: 'locked', infinifiLockedKey: '0x66bCF6151D5558AfB47c38B20663589843156078' },
  { provider: 'infinifi', chainId: 1, address: '0xbd3f9814eB946E617f1d774A6762cDbec0bf087A', infinifiVariant: 'locked', infinifiLockedKey: '0xbd3f9814eB946E617f1d774A6762cDbec0bf087A' },
  { provider: 'infinifi', chainId: 1, address: '0xDBDC1Ef57537E34680B898E1FEBD3D68c7389bCB', infinifiVariant: 'staked' },
]
