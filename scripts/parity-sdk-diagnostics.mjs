#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEulerSDK, createPythPlugin } from '@eulerxyz/euler-v2-sdk'
import { formatUnits, getAddress } from 'viem'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const DEFAULT_DIFF = 'artifacts/parity/2026-05-11T12-37-06-444Z/diff.json'
const DEFAULT_V3_ENDPOINT = 'https://v3.euler.finance'
const DEFAULT_RPC_URLS = {
  1: 'https://ethereum-rpc.publicnode.com',
}
const FETCH_OPTIONS = {
  populateMarketPrices: true,
  populateCollaterals: true,
  populateRewards: true,
  eVaultFetchOptions: {
    populateMarketPrices: true,
    populateCollaterals: true,
    populateRewards: true,
  },
}
const TOLERANCE = 0.01

const args = parseArgs(process.argv.slice(2))
loadEnvFile(path.resolve(REPO_ROOT, '.env'))
loadEnvFile(path.resolve(REPO_ROOT, '../euler-sdks/packages/euler-v2-sdk/examples/.env'))

const diffPath = path.resolve(REPO_ROOT, args.diff || process.env.PARITY_DIFF || DEFAULT_DIFF)
const outputPath = path.resolve(
  REPO_ROOT,
  args.output || process.env.PARITY_SDK_DIAGNOSTICS_OUTPUT || path.join(path.dirname(diffPath), 'sdk-diagnostics.json'),
)

const diff = JSON.parse(await readFile(diffPath, 'utf8'))
const endpoint = cleanUrl(
  process.env.EULER_SDK_V3_API_URL
  || process.env.VITE_EULER_SDK_V3_API_URL
  || process.env.VITE_EULER_V3_ENDPOINT
  || process.env.V3_HOST,
) || DEFAULT_V3_ENDPOINT
const apiKey = process.env.EULER_SDK_V3_API_KEY
  || process.env.VITE_EULER_SDK_V3_API_KEY
  || process.env.VITE_EULER_V3_API_KEY
const rpcUrls = collectRpcUrls()
const observations = collectObservations(diff)
const vaultAddresses = [...new Set(observations.map(obs => obs.vaultAddress).filter(Boolean))]

if (!vaultAddresses.length) {
  throw new Error(`No vault-scoped observations found in ${diffPath}`)
}

console.log(`Reading diff: ${path.relative(REPO_ROOT, diffPath)}`)
console.log(`Checking ${vaultAddresses.length} vaults via SDK v3 and onchain adapters`)
console.log(`V3 endpoint: ${endpoint}`)

const [v3Snapshot, onchainSnapshot] = await Promise.all([
  fetchSnapshot('v3', vaultAddresses),
  fetchSnapshot('onchain', vaultAddresses),
])

const rows = observations.map((observation) => {
  const v3 = v3Snapshot.vaults[observation.vaultAddress]
  const onchain = onchainSnapshot.vaults[observation.vaultAddress]
  return analyzeObservation(observation, v3, onchain)
})

const summary = summarize(rows)
const report = {
  generatedAt: new Date().toISOString(),
  diffPath: path.relative(REPO_ROOT, diffPath),
  endpoint,
  rpcChainIds: Object.keys(rpcUrls).map(Number).sort((a, b) => a - b),
  fetchOptions: FETCH_OPTIONS,
  summary,
  sourceRule: 'If onchain matches the baseline while v3 differs, the V3 source or V3 adapter interpretation is the suspect.',
  observations: rows,
  adapterErrors: {
    v3: v3Snapshot.errors,
    onchain: onchainSnapshot.errors,
  },
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, bigintReplacer, 2)}\n`)
console.log(`Wrote ${path.relative(REPO_ROOT, outputPath)}`)
console.log(JSON.stringify(summary, null, 2))

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2)
    parsed[toCamel(rawKey)] = inlineValue ?? argv[++index]
  }
  return parsed
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_match, char) => char.toUpperCase())
}

function loadEnvFile(filePath) {
  readEnvFileSync(filePath).forEach(([key, value]) => {
    if (process.env[key] === undefined) process.env[key] = value
  })
}

function readEnvFileSync(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8')
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=')
        if (separator < 0) return null
        const key = line.slice(0, separator).trim().replace(/^export\s+/, '')
        const raw = line.slice(separator + 1).trim()
        return [key, stripQuotes(raw)]
      })
      .filter(Boolean)
  }
  catch {
    return []
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function cleanUrl(value) {
  return value?.trim().replace(/\/+$/, '') || undefined
}

function collectRpcUrls() {
  const rpcUrls = { ...DEFAULT_RPC_URLS }
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue
    const match = key.match(/^(?:RPC_URL|EULER_SDK_RPC_URL|VITE_RPC_URL)_(\d+)$/)
    if (!match) continue
    rpcUrls[Number(match[1])] = value
  }
  return rpcUrls
}

function noCacheBuildQuery(_queryName, fn) {
  return fn
}

async function buildSdk(adapter) {
  const v3AdapterConfig = { endpoint, ...(apiKey ? { apiKey } : {}) }
  return buildEulerSDK({
    config: {
      rpcUrls,
      ...(apiKey ? { v3ApiKey: apiKey } : {}),
      v3ApiUrl: endpoint,
    },
    buildQuery: noCacheBuildQuery,
    plugins: [createPythPlugin({ buildQuery: noCacheBuildQuery })],
    eVaultServiceConfig: adapter === 'onchain'
      ? { adapter: 'onchain' }
      : { adapter: 'v3', v3AdapterConfig },
    accountServiceConfig: adapter === 'onchain'
      ? { adapter: 'onchain' }
      : { adapter: 'v3', v3AdapterConfig },
    eulerEarnServiceConfig: adapter === 'onchain'
      ? { adapter: 'onchain' }
      : { adapter: 'v3', v3AdapterConfig },
    intrinsicApyServiceConfig: {
      adapter: 'v3',
      v3AdapterConfig,
    },
    rewardsServiceConfig: {
      v3AdapterConfig,
    },
    pricingServiceConfig: {
      endpoint,
      ...(apiKey ? { apiKey } : {}),
    },
    vaultTypeAdapterConfig: {
      endpoint,
      ...(apiKey ? { apiKey } : {}),
    },
  })
}

async function fetchSnapshot(adapter, vaultAddresses) {
  const sdk = await buildSdk(adapter)
  const normalized = vaultAddresses.map(addr => getAddress(addr))
  const result = await sdk.eVaultService.fetchVaults(1, normalized, FETCH_OPTIONS)
  const vaults = {}
  result.result.forEach((vault, index) => {
    const address = normalized[index].toLowerCase()
    vaults[address] = vault ? summarizeVault(vault) : null
  })
  return {
    adapter,
    vaults,
    errors: (result.errors || []).map(summarizeDataIssue),
  }
}

function summarizeVault(vault) {
  return {
    address: vault.address.toLowerCase(),
    asset: summarizeToken(vault.asset),
    shares: summarizeToken(vault.shares),
    totalAssets: vault.totalAssets,
    totalCash: vault.totalCash,
    totalBorrowed: vault.totalBorrowed,
    availableLiquidity: vault.availableLiquidity,
    utilization: vault.utilization,
    interestRates: { ...vault.interestRates },
    caps: {
      supplyCap: vault.caps.supplyCap,
      borrowCap: vault.caps.borrowCap,
      supplyCapUtilization: vault.caps.supplyCapUtilization,
      borrowCapUtilization: vault.caps.borrowCapUtilization,
    },
    shareTokenExchangeRate: safeConvertToAssets(vault),
    rewards: summarizeRewards(vault.rewards),
    intrinsicApy: vault.intrinsicApy ?? null,
    collaterals: vault.collaterals.map(collateral => ({
      address: collateral.address.toLowerCase(),
      assetAddress: collateral.vault?.asset?.address?.toLowerCase() ?? null,
      symbol: collateral.vault?.asset?.symbol ?? null,
      name: collateral.vault?.asset?.name ?? null,
      borrowLTV: collateral.borrowLTV,
      liquidationLTV: collateral.liquidationLTV,
      currentLiquidationLTV: collateral.currentLiquidationLTV,
      totalAssets: collateral.vault?.totalAssets ?? null,
      includeInAppExposure: collateral.borrowLTV > 0 && collateral.currentLiquidationLTV > 0,
    })),
    appCollateralDisplayAssets: computeAppCollateralDisplayAssets(vault),
  }
}

function summarizeToken(token) {
  return token
    ? {
        address: token.address?.toLowerCase(),
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
      }
    : null
}

function summarizeRewards(rewards) {
  const campaigns = rewards?.campaigns ?? []
  return {
    campaignCount: campaigns.length,
    supplyApr: campaigns
      .filter(campaign => campaign.action === 'LEND')
      .reduce((sum, campaign) => sum + Number(campaign.apr || 0) * 100, 0),
    campaigns: campaigns.map(campaign => ({
      source: campaign.source,
      action: campaign.action,
      apr: Number(campaign.apr || 0) * 100,
      rewardTokenSymbol: campaign.rewardTokenSymbol,
      endTimestamp: campaign.endTimestamp,
    })),
  }
}

function safeConvertToAssets(vault) {
  try {
    return vault.convertToAssets(10n ** BigInt(vault.shares.decimals))
  }
  catch {
    return null
  }
}

function computeAppCollateralDisplayAssets(vault) {
  const seen = new Set()
  const assets = []
  for (const collateral of vault.collaterals) {
    if (collateral.borrowLTV <= 0) continue
    if (collateral.currentLiquidationLTV <= 0) continue
    const asset = collateral.vault?.asset
    if (!asset?.address) continue
    const assetAddress = asset.address.toLowerCase()
    if (seen.has(assetAddress)) continue
    seen.add(assetAddress)
    assets.push({
      address: assetAddress,
      symbol: asset.symbol,
      collateralAddress: collateral.address.toLowerCase(),
    })
  }
  return assets.slice(0, 5)
}

function collectObservations(report) {
  const observations = []
  for (const page of report.pages || []) {
    for (const diff of page.elementDiffs || []) {
      if (diff.status === 'match') continue
      const field = diff.baseline?.field || diff.candidate?.field || fieldFromBaseKey(diff.baseKey)
      const vaultAddress = inferVaultAddress(page, diff)
      if (!vaultAddress) continue
      observations.push({
        pageId: page.pageId,
        label: page.label,
        status: diff.status,
        field,
        key: diff.key,
        baseKey: diff.baseKey,
        vaultAddress,
        baseline: diff.baseline ?? null,
        candidate: diff.candidate ?? null,
        mismatch: diff.mismatch ?? null,
      })
    }
  }
  return observations
}

function fieldFromBaseKey(baseKey) {
  if (typeof baseKey !== 'string') return ''
  return baseKey.split('|').at(-1) || ''
}

function inferVaultAddress(page, diff) {
  const candidates = [
    diff.baseline?.key,
    diff.candidate?.key,
    diff.baseKey,
    diff.key,
    page.pageId,
    page.path,
  ].filter(Boolean)

  for (const value of candidates) {
    const match = String(value).match(/0x[a-fA-F0-9]{40}/)
    if (match) return match[0].toLowerCase()
  }
  return null
}

function analyzeObservation(observation, v3, onchain) {
  const field = normalizeField(observation.field, observation)
  const v3Value = readField(v3, field, observation)
  const onchainValue = readField(onchain, field, observation)
  const baselineValue = extractBaselineComparable(observation)
  const candidateValue = extractCandidateComparable(observation)
  const adaptersMatch = comparableMatches(v3Value?.comparable, onchainValue?.comparable)
  const baselineMatchesV3 = comparableMatches(baselineValue, v3Value?.comparable)
  const baselineMatchesOnchain = comparableMatches(baselineValue, onchainValue?.comparable)
  const candidateMatchesV3 = comparableMatches(candidateValue, v3Value?.comparable)
  const candidateMatchesOnchain = comparableMatches(candidateValue, onchainValue?.comparable)
  const source = classifySource({
    adaptersMatch,
    baselineMatchesV3,
    baselineMatchesOnchain,
    candidateMatchesV3,
    candidateMatchesOnchain,
    field,
    observation,
    v3Value,
    onchainValue,
    baselineValue,
    candidateValue,
  })

  return {
    ...observation,
    normalizedField: field,
    baselineComparable: baselineValue,
    candidateComparable: candidateValue,
    v3: v3Value,
    onchain: onchainValue,
    diagnosis: {
      adaptersMatch,
      baselineMatchesV3,
      baselineMatchesOnchain,
      candidateMatchesV3,
      candidateMatchesOnchain,
      source,
    },
  }
}

function normalizeField(field, observation) {
  const normalized = field?.trim().toLowerCase()
  if (normalized) {
    const mapped = normalized.replace(/\s+/g, '-')
    if (mapped === 'supply-apy') return 'supply-apy'
    if (mapped === 'borrow-cap') return 'borrow-cap'
    if (mapped === 'supply-cap') return 'supply-cap'
    if (mapped === 'share-token-exchange-rate') return 'share-token-exchange-rate'
    return field
  }
  const text = [
    observation.baseline?.text,
    observation.candidate?.text,
    observation.mismatch?.text?.baseline,
    observation.mismatch?.text?.candidate,
  ].filter(Boolean).join('\n')
  if (/Share token exchange rate/i.test(text)) return 'share-token-exchange-rate'
  if (/Borrow cap/i.test(text)) return 'borrow-cap'
  if (/Supply cap/i.test(text)) return 'supply-cap'
  if (/Supply APY/i.test(text)) return 'supply-apy'
  return field
}

function readField(vault, field, observation) {
  if (!vault) return { comparable: null, raw: null }
  switch (field) {
    case 'supply-apy':
      return {
        comparable: vault.interestRates.supplyAPY + vault.rewards.supplyApr,
        raw: {
          baseSupplyAPY: vault.interestRates.supplyAPY,
          supplyRewardApr: vault.rewards.supplyApr,
          finalSupplyAPY: vault.interestRates.supplyAPY + vault.rewards.supplyApr,
          intrinsicApy: vault.intrinsicApy,
        },
      }
    case 'available-liquidity':
      return { comparable: vault.availableLiquidity, raw: { availableLiquidity: vault.availableLiquidity } }
    case 'utilization':
      return { comparable: vault.utilization, raw: { utilization: vault.utilization } }
    case 'supply-cap':
      return {
        comparable: vault.caps.supplyCap,
        raw: {
          supplyCap: vault.caps.supplyCap,
          supplyCapUtilization: vault.caps.supplyCapUtilization,
        },
      }
    case 'borrow-cap':
      return {
        comparable: vault.caps.borrowCap,
        raw: {
          borrowCap: vault.caps.borrowCap,
          borrowCapUtilization: vault.caps.borrowCapUtilization,
        },
      }
    case 'share-token-exchange-rate':
      return {
        comparable: vault.shareTokenExchangeRate === null
          ? null
          : Number(formatUnits(vault.shareTokenExchangeRate, vault.asset.decimals)),
        raw: { shareTokenExchangeRate: vault.shareTokenExchangeRate },
      }
    case 'collateral-exposure-asset': {
      const address = observation.baseline?.key || observation.candidate?.key || collateralAddressFromKey(observation.key)
      return {
        comparable: address ? vault.appCollateralDisplayAssets.some(asset => asset.address === address.toLowerCase()) : null,
        raw: {
          requestedAssetAddress: address,
          appCollateralDisplayAssets: vault.appCollateralDisplayAssets,
          collaterals: vault.collaterals,
        },
      }
    }
    case 'collateral-exposure-overflow':
      return {
        comparable: Math.max(0, computeExposureAssetCount(vault) - 5),
        raw: { exposureAssetCount: computeExposureAssetCount(vault) },
      }
    default:
      return { comparable: null, raw: { note: `No SDK reader for ${field}` } }
  }
}

function collateralAddressFromKey(key) {
  if (typeof key !== 'string') return null
  const matches = [...key.matchAll(/0x[a-fA-F0-9]{40}/g)].map(match => match[0].toLowerCase())
  return matches.at(-1) ?? null
}

function computeExposureAssetCount(vault) {
  const seen = new Set()
  for (const collateral of vault.collaterals) {
    if (collateral.borrowLTV <= 0) continue
    if (collateral.currentLiquidationLTV <= 0) continue
    const assetAddress = collateral.vault?.asset?.address?.toLowerCase()
    if (assetAddress) seen.add(assetAddress)
  }
  return seen.size
}

function extractBaselineComparable(observation) {
  return extractComparable(observation.baseline, observation.mismatch?.value?.baseline ?? observation.mismatch?.text?.baseline)
}

function extractCandidateComparable(observation) {
  return extractComparable(observation.candidate, observation.mismatch?.value?.candidate ?? observation.mismatch?.text?.candidate)
}

function extractComparable(summary, fallback) {
  if (summary?.attrs?.value !== undefined && !(summary.attrs.value === 'false' && fallback !== undefined)) {
    return normalizeComparable(summary.attrs.value)
  }
  if (summary?.value !== undefined && !(summary.value === 'false' && fallback !== undefined)) {
    return normalizeComparable(summary.value)
  }
  if (fallback !== undefined) return normalizeComparable(fallback)
  return null
}

function normalizeComparable(value) {
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value
  if (value === null || value === undefined) return null
  const str = String(value).trim()
  if (!str) return null
  const percent = str.match(/([-+]?(?:\d+\.?\d*|\.\d+))\s*%/)
  if (percent) return Number(percent[1])
  const plain = str.match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i)
  if (plain) return Number(str)
  return str
}

function comparableMatches(left, right) {
  if (left === undefined || right === undefined) return false
  if (left === null || right === null) return left === right
  if (typeof left === 'boolean' || typeof right === 'boolean') return left === right
  if (typeof left === 'bigint' || typeof right === 'bigint') {
    try {
      return bigintMatches(BigInt(left), BigInt(right))
    }
    catch {
      return false
    }
  }
  if (typeof left === 'number' && typeof right === 'number') {
    if (!Number.isFinite(left) || !Number.isFinite(right)) return left === right
    const denominator = Math.max(Math.abs(left), Math.abs(right), Number.EPSILON)
    return Math.abs(left - right) <= denominator * TOLERANCE
  }
  return String(left) === String(right)
}

function bigintMatches(left, right) {
  if (left === right) return true
  const diff = left > right ? left - right : right - left
  const denominator = left > right ? left : right
  if (denominator === 0n) return diff === 0n
  return diff * 10_000n <= denominator * BigInt(Math.round(TOLERANCE * 10_000))
}

function classifySource(matches) {
  if (matches.field === 'collateral-exposure-asset') {
    const v3HasAsset = matches.v3Value?.comparable === true
    const onchainHasAsset = matches.onchainValue?.comparable === true
    if (matches.observation.status === 'extra-in-candidate' && v3HasAsset && !onchainHasAsset) {
      return 'v3-diverges-from-onchain'
    }
    if (matches.observation.status === 'missing-in-candidate' && !v3HasAsset && onchainHasAsset) {
      return 'v3-diverges-from-onchain'
    }
  }

  if (matches.field === 'supply-apy') {
    const baselineMatchesBase = comparableMatches(matches.baselineValue, matches.v3Value?.raw?.baseSupplyAPY)
      || comparableMatches(matches.baselineValue, matches.onchainValue?.raw?.baseSupplyAPY)
    const candidateMatchesFinal = comparableMatches(matches.candidateValue, matches.v3Value?.raw?.finalSupplyAPY)
      || comparableMatches(matches.candidateValue, matches.onchainValue?.raw?.finalSupplyAPY)
    const rewardApr = Math.max(
      Number(matches.v3Value?.raw?.supplyRewardApr ?? 0),
      Number(matches.onchainValue?.raw?.supplyRewardApr ?? 0),
    )
    if (baselineMatchesBase && candidateMatchesFinal && rewardApr > 0) {
      return 'candidate-includes-sdk-rewards'
    }
  }

  if (matches.baselineMatchesOnchain && !matches.baselineMatchesV3) return 'v3-diverges-from-onchain'
  if (matches.adaptersMatch && !matches.baselineMatchesV3 && !matches.baselineMatchesOnchain) return 'sdk-adapters-match-but-baseline-differs'
  if (matches.baselineMatchesV3 && !matches.baselineMatchesOnchain) return 'onchain-diverges-from-v3'
  if (matches.candidateMatchesV3 && !matches.candidateMatchesOnchain) return 'candidate-render-follows-v3'
  if (!matches.adaptersMatch) return 'adapter-divergence'
  return 'inconclusive'
}

function summarize(rows) {
  const bySource = countBy(rows, row => row.diagnosis.source)
  const byField = countBy(rows, row => row.normalizedField || 'unknown')
  return {
    observations: rows.length,
    bySource,
    byField,
    v3LikelyWrong: rows.filter(row => row.diagnosis.source === 'v3-diverges-from-onchain').length,
    adapterDivergences: rows.filter(row => !row.diagnosis.adaptersMatch).length,
  }
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item)
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
}

function summarizeDataIssue(issue) {
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    source: issue.source,
    locations: issue.locations,
  }
}

function bigintReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value
}
