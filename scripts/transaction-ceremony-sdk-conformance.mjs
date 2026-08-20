#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { EulerSDK, ExecutionService, PositionMigrationService } from '@eulerxyz/euler-v2-sdk'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const sdkManifestPath = require.resolve('@eulerxyz/euler-v2-sdk/package.json')
const sdkRoot = path.dirname(sdkManifestPath)
const sdkManifest = JSON.parse(fs.readFileSync(sdkManifestPath, 'utf8'))
const errors = []

const requireMethod = (prototype, method, owner) => {
  if (typeof prototype[method] !== 'function') errors.push(`${owner}.${method} is unavailable`)
}

if (fs.lstatSync(sdkRoot).isSymbolicLink()) errors.push('installed SDK is a local symlink')
if (appManifest.dependencies['@eulerxyz/euler-v2-sdk'] !== sdkManifest.version) {
  errors.push(`installed SDK ${sdkManifest.version} does not match the exact package pin ${appManifest.dependencies['@eulerxyz/euler-v2-sdk']}`)
}

requireMethod(ExecutionService.prototype, 'prefetchPluginDataForPlan', 'ExecutionService')
requireMethod(ExecutionService.prototype, 'processPlanPlugins', 'ExecutionService')
requireMethod(ExecutionService.prototype, 'encodeMigrationAuthorizationCall', 'ExecutionService')
requireMethod(ExecutionService.prototype, 'materializeExecution', 'ExecutionService')
requireMethod(ExecutionService.prototype, 'finalizeMaterializedExecution', 'ExecutionService')
requireMethod(ExecutionService.prototype, 'executeMaterialized', 'ExecutionService')
requireMethod(PositionMigrationService.prototype, 'prepareMigrationAuthorizationSlots', 'PositionMigrationService')
requireMethod(PositionMigrationService.prototype, 'planMigrationSimulation', 'PositionMigrationService')

const placeholder = {}
const requiredPluginError = new Error('required plugin failed')
const sdk = new EulerSDK({
  accountService: placeholder,
  portfolioService: placeholder,
  walletService: placeholder,
  eVaultService: placeholder,
  eulerEarnService: placeholder,
  securitizeVaultService: placeholder,
  vaultMetaService: placeholder,
  deploymentService: placeholder,
  providerService: placeholder,
  abiService: placeholder,
  eulerLabelsService: placeholder,
  tokenlistService: placeholder,
  swapService: placeholder,
  executionService: placeholder,
  priceService: placeholder,
  rewardsService: placeholder,
  intrinsicApyService: placeholder,
  oracleAdapterService: placeholder,
  feeFlowService: placeholder,
  reulLockService: placeholder,
  safeAccountService: placeholder,
  positionMigrationService: placeholder,
  plugins: [{ name: 'required-conformance-plugin', processPlan: async () => { throw requiredPluginError } }],
})
const originalWarn = console.warn
let rejectedRequiredPlugin = false
console.warn = () => {}
try {
  await sdk.processPlugins([], '0x1000000000000000000000000000000000000000', 1)
}
catch (error) {
  rejectedRequiredPlugin = error === requiredPluginError
}
finally {
  console.warn = originalWarn
}
if (!rejectedRequiredPlugin) errors.push('required plugin failure is swallowed instead of failing closed')

const pluginTypes = fs.readFileSync(path.join(sdkRoot, 'dist/src/plugins/types.d.ts'), 'utf8')
if (!/PythPluginPrefetch[\s\S]*publishTimes/.test(pluginTypes)) {
  errors.push('Pyth plugin prefetch does not expose publishTimes evidence')
}

const executionTypes = fs.readFileSync(path.join(sdkRoot, 'dist/src/services/executionService/executionService.d.ts'), 'utf8')
const simulationContractLinks = executionTypes.match(/simulations-and-state-overrides/gi)?.length ?? 0
if (simulationContractLinks < 4) {
  errors.push('public execution-service comments do not link the required simulation contract')
}
if (/errors are caught per-plugin/i.test(executionTypes)) {
  errors.push('public plugin documentation still describes fail-open processing')
}

if (errors.length) {
  console.error(`Transaction-ceremony SDK conformance failed for @eulerxyz/euler-v2-sdk ${sdkManifest.version}:`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Transaction-ceremony SDK conformance passed for @eulerxyz/euler-v2-sdk ${sdkManifest.version}.`)
