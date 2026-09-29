export const useDeployConfig = () => {
  const rc = useRuntimeConfig().public
  const envConfig = useEnvConfig()

  const isEnabled = (val: unknown) => {
    const s = String(val)
    return s !== 'false' && s !== '0'
  }
  return {
    // URLs (empty string = not configured, hide UI element)
    docsUrl: rc.configDocsUrl,
    stargateUrl: rc.configStargateUrl,
    tosUrl: rc.configTosUrl || 'https://www.euler.finance/terms',
    tosMdUrl: rc.configTosMdUrl,
    privacyPolicyUrl: rc.configPrivacyPolicyUrl || 'https://www.euler.finance/privacy-policy',
    riskDisclosuresUrl: rc.configRiskDisclosuresUrl || 'https://www.euler.finance/risk-disclosures',
    micaWhitepaperUrl: rc.configMicaWhitepaperUrl || 'https://www.euler.finance/MICA-Whitepaper.pdf',
    xUrl: rc.configXUrl,
    discordUrl: rc.configDiscordUrl,
    telegramUrl: rc.configTelegramUrl,
    githubUrl: rc.configGithubUrl,

    // Branding (from useEnvConfig, not runtimeConfig)
    appTitle: envConfig.appTitle,
    appDescription: envConfig.appDescription,
    logoUrl: envConfig.logoUrl,
    socialImageUrl: envConfig.socialImageUrl,

    // Feature flags: all enabled by default, set env var to 'false' to disable
    enableTosSignature: !!rc.configTosMdUrl,
    enableEntityBranding: isEnabled(rc.configEnableEntityBranding),
    enableVaultType: isEnabled(rc.configEnableVaultType),
    enableEarnPage: isEnabled(rc.configEnableEarnPage),
    enableLendPage: isEnabled(rc.configEnableLendPage),
    enableExplorePage: isEnabled(rc.configEnableExplorePage),
    enablePoweredByEuler: isEnabled(rc.configEnablePoweredByEuler),
    enableAppTitle: isEnabled(rc.configEnableAppTitle),
    enableMerkl: isEnabled(rc.configEnableMerkl),
    enableIncentra: isEnabled(rc.configEnableIncentra),
    enableFuul: isEnabled(rc.configEnableFuul),
    enableTurtle: isEnabled(rc.configEnableTurtle),
    announcement: envConfig.announcement,

    // External token lists (defaults in server/api/internal/token-list.get.ts)
    uniswapTokenListUrl: rc.configUniswapTokenListUrl || '',
    defillamaTokenListUrl: rc.configDefillamaTokenListUrl || '',

    // Chains (derived from env vars at runtime via useChainConfig)
    ...useChainConfig(),
  }
}
