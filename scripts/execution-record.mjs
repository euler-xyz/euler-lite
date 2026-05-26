#!/usr/bin/env node
/**
 * Records fork-backed transaction executions through the real Lite UI.
 *
 * The runner expects a Lite app already running (default http://localhost:3000)
 * and an Anvil mainnet fork (default http://127.0.0.1:8545). It injects an
 * EIP-1193 wallet stub, seeds the fork from fixture token whales, records SDK
 * query* calls via utils/sdk-query-cache.ts, captures swap/API traffic, and
 * writes a replayable JSON artifact, per-scenario videos, and markdown/HTML
 * reports.
 */
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  parseEther,
  parseUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { installSdkQueryRecorder } from '../tests/execution/sdk-query-recorder.mjs'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_FIXTURE = path.join(ROOT_DIR, 'tests/execution/anvil-mainnet.fixture.json')
const DEFAULT_SCENARIOS = path.join(ROOT_DIR, 'tests/execution/scenarios.json')
const DEFAULT_APP_URL = 'http://localhost:3000'
const DEFAULT_ANVIL_RPC_URL = 'http://127.0.0.1:8545'
const MAX_CAPTURED_SWAP_BODY_CHARS = 1_500_000
const MAX_CAPTURED_API_BODY_CHARS = 250_000
const MAX_CAPTURED_RPC_BODY_CHARS = 20_000
const DEFAULT_VIDEO_TAIL_MS = 2_500
const EVaultDepositAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [
      { name: 'shares', type: 'uint256' },
    ],
  },
]

const args = parseArgs(process.argv.slice(2))

void main().catch((err) => {
  console.error('[execution-record]', err?.stack || err?.message || err)
  process.exit(1)
})

async function main() {
  const fixturePath = path.resolve(ROOT_DIR, args.fixture ?? DEFAULT_FIXTURE)
  const scenariosPath = path.resolve(ROOT_DIR, args.scenarios ?? DEFAULT_SCENARIOS)
  const fixture = await readJson(fixturePath)
  const scenarioFile = await readJson(scenariosPath)
  const vaultSnapshotPath = args['vault-snapshot'] ? path.resolve(ROOT_DIR, args['vault-snapshot']) : null
  const vaultSnapshot = vaultSnapshotPath ? await readJson(vaultSnapshotPath) : null
  const appUrl = cleanBaseUrl(args.url ?? DEFAULT_APP_URL)
  const swapApiUrl = args['swap-api-url'] ? cleanBaseUrl(args['swap-api-url']) : null
  const anvilRpcUrl = String(args['anvil-rpc'] ?? fixture.anvil?.rpcUrl ?? DEFAULT_ANVIL_RPC_URL)
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const outputDir = path.resolve(ROOT_DIR, args['output-dir'] ?? path.join('artifacts/execution-recordings', runId))
  const scenarioIds = args.scenario ? String(args.scenario).split(',').map(s => s.trim()).filter(Boolean) : null
  const scenarioById = new Map((scenarioFile.scenarios ?? []).map(scenario => [scenario.id, scenario]))
  const scenarios = scenarioIds
    ? scenarioIds.map((id) => {
        const scenario = scenarioById.get(id)
        if (!scenario) {
          throw new Error(`Scenario "${id}" is not defined in ${path.relative(ROOT_DIR, scenariosPath)}`)
        }
        return scenario
      })
    : (scenarioFile.scenarios ?? [])

  if (!scenarios.length) {
    throw new Error(`No scenarios matched filter=${args.scenario ?? '*'}`)
  }

  if (args['dry-run']) {
    printDryRunSummary({ fixture, scenarioFile, fixturePath, scenariosPath, scenarios, appUrl, anvilRpcUrl })
    return
  }

  await mkdirp(outputDir)
  if (args['v3-preflight'] && !args['skip-v3-preflight']) {
    await preflightV3Proxy({ appUrl, fixture })
  }
  if (swapApiUrl) {
    await preflightSwapApi({ swapApiUrl, chainId: fixture.chainId })
  }

  const run = {
    version: 1,
    startedAt: new Date().toISOString(),
    fixturePath: path.relative(ROOT_DIR, fixturePath),
    scenariosPath: path.relative(ROOT_DIR, scenariosPath),
    vaultSnapshotPath: vaultSnapshotPath ? path.relative(ROOT_DIR, vaultSnapshotPath) : null,
    swapApiUrl,
    appUrl,
    anvilRpcUrl,
    fork: {
      chainId: fixture.chainId,
      forkBlockNumber: fixture.forkBlockNumber ?? null,
      observedBlockNumber: null,
    },
    wallet: {
      address: getAddress(fixture.wallet.address),
    },
    requiredTransactionTypes: scenarioFile.requiredTransactionTypes ?? [],
    unsupportedTransactionTypes: scenarioFile.unsupportedTransactionTypes ?? [],
    scenarios: [],
    sdkQueries: [],
    sdkQueryEvents: 0,
    network: [],
    console: [],
    walletRequests: [],
    variables: {},
    setup: {
      skipped: Boolean(args['skip-fork-setup']),
      transfers: [],
    },
    errors: [],
  }

  if (!args['skip-fork-setup']) {
    run.setup = await setupFork(fixture, anvilRpcUrl)
  }
  run.fork.observedBlockNumber = await rpc(anvilRpcUrl, 'eth_blockNumber', [])

  const browser = await chromium.launch({
    headless: Boolean(args.headless),
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const sdkQueryRecordIndex = new Map()
  const viewport = scenarioFile.defaults?.viewport ?? { width: 1440, height: 1000 }
  const videoDir = args['no-video'] ? null : path.join(outputDir, 'videos')
  const videoTailMs = videoDir ? parseVideoTailMs(args['video-tail-ms'], scenarioFile.defaults?.videoTailMs) : 0
  if (videoDir) {
    await mkdirp(videoDir)
  }

  try {
    const context = await browser.newContext({
      viewport,
      ...(videoDir
        ? {
            recordVideo: {
              dir: videoDir,
              size: videoSizeForViewport(viewport),
            },
          }
        : {}),
    })
    const activeScenarioState = {
      scenario: null,
      successfulWalletTransactions: 0,
    }

    await context.addInitScript(installSdkQueryRecorder)
    await installWalletStub(context, fixture, anvilRpcUrl, run.walletRequests, () => {
      activeScenarioState.successfulWalletTransactions += 1
    }, () => activeScenarioState)
    await installVaultSnapshotRoute(context, vaultSnapshot)
    await installV3VaultResolveRoute(context, vaultSnapshot)
    await installSwapApiRoute(context, swapApiUrl)
    await installScenarioSubgraphDiscoveryRoute(context, fixture, () => activeScenarioState)
    await context.route('**/api/screen-address', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ addressIsSuspicious: false }),
    }))

    for (const scenario of scenarios) {
      activeScenarioState.scenario = scenario
      activeScenarioState.successfulWalletTransactions = 0
      console.log(`[execution-record] ▶ ${scenario.id} — ${scenario.label ?? ''}`)
      const page = await context.newPage()
      attachNetworkRecorder(page, run.network)
      attachConsoleRecorder(page, run.console, scenario.id)
      await page.exposeBinding('__EULER_EXECUTION_RECORDER__', async (_source, record) => {
        run.sdkQueryEvents += 1
        recordSdkQuery(run.sdkQueries, sdkQueryRecordIndex, {
          recordedAt: new Date().toISOString(),
          scenarioId: scenario.id,
          ...record,
        })
      })

      const scenarioResult = await runScenario({
        page,
        appUrl,
        defaults: scenarioFile.defaults ?? {},
        scenario,
        outputDir,
        variables: run.variables,
        videoTailMs,
        fixture,
      })

      if (!args['keep-open']) {
        await closePageAndAttachVideo({
          page,
          scenario,
          outputDir,
          result: scenarioResult,
          enabled: Boolean(videoDir),
        })
      }
      else if (videoDir) {
        scenarioResult.video = {
          status: 'not-finalized',
          reason: '--keep-open leaves the page open, so Playwright cannot finalize the video file',
        }
      }

      const walletErrors = walletErrorsForScenario(run.walletRequests, scenarioResult)
      if (scenarioResult.status === 'passed' && walletErrors.length) {
        scenarioResult.status = 'failed'
        scenarioResult.error = {
          name: 'WalletTransactionError',
          message: `${walletErrors.length} wallet transaction request${walletErrors.length === 1 ? '' : 's'} failed`,
          walletErrors,
        }
      }

      run.scenarios.push(scenarioResult)
    }
    activeScenarioState.scenario = null
    activeScenarioState.successfulWalletTransactions = 0
  }
  finally {
    if (!args['keep-open']) {
      await browser.close()
    }
  }

  run.finishedAt = new Date().toISOString()
  const runJson = await writeRecordArtifacts(outputDir, run)
  await writeJson(path.join(outputDir, 'run.json'), runJson)
  await fs.writeFile(path.join(outputDir, 'report.md'), renderReport(run), 'utf8')
  await fs.writeFile(path.join(outputDir, 'report.html'), renderHtmlReport(run, outputDir), 'utf8')
  console.log(`[execution-record] wrote ${path.relative(ROOT_DIR, outputDir)}`)

  const failed = run.scenarios.filter(s => s.status !== 'passed').length
  if (failed) {
    throw new Error(`${failed} execution scenario${failed === 1 ? '' : 's'} failed; see ${path.relative(ROOT_DIR, path.join(outputDir, 'report.md'))}`)
  }
}

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      flags[key] = true
    }
    else {
      flags[key] = next
      i++
    }
  }
  return flags
}

function printDryRunSummary({ fixture, scenarioFile, fixturePath, scenariosPath, scenarios, appUrl, anvilRpcUrl }) {
  const covered = new Set(scenarios.flatMap(scenario => scenario.covers ?? []))
  const required = scenarioFile.requiredTransactionTypes ?? []
  const unsupported = scenarioFile.unsupportedTransactionTypes ?? []
  const unsupportedSet = new Set(unsupported)
  const missing = required.filter(item => !covered.has(item) && !unsupportedSet.has(item))

  console.log('[execution-record] dry run')
  console.log(`  fixture: ${path.relative(ROOT_DIR, fixturePath)}`)
  console.log(`  scenarios: ${path.relative(ROOT_DIR, scenariosPath)}`)
  console.log(`  app url: ${appUrl}`)
  console.log(`  anvil rpc: ${anvilRpcUrl}`)
  console.log(`  fork block: ${fixture.forkBlockNumber ?? 'not pinned'}`)
  console.log(`  wallet: ${fixture.wallet?.address ?? 'missing'}`)
  console.log(`  selected scenarios: ${scenarios.map(s => s.id).join(', ')}`)
  console.log(`  covered transaction types: ${covered.size ? [...covered].join(', ') : 'none'}`)
  console.log(`  unsupported transaction types: ${unsupported.length ? unsupported.join(', ') : 'none'}`)
  console.log(`  missing transaction types: ${missing.length ? missing.join(', ') : 'none'}`)
}

function cleanBaseUrl(value) {
  return String(value).trim().replace(/\/+$/, '')
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function writeJson(file, data) {
  await mkdirp(path.dirname(file))
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

async function writeJsonl(file, records) {
  await mkdirp(path.dirname(file))
  const handle = await fs.open(file, 'w')
  try {
    for (const record of records) {
      await handle.write(`${JSON.stringify(record)}\n`, undefined, 'utf8')
    }
  }
  finally {
    await handle.close()
  }
}

async function writeRecordArtifacts(outputDir, run) {
  const files = {
    sdkQueries: 'sdk-queries.jsonl',
    network: 'network.jsonl',
    console: 'console.jsonl',
    walletRequests: 'wallet-requests.jsonl',
  }

  await writeJsonl(path.join(outputDir, files.sdkQueries), run.sdkQueries)
  await writeJsonl(path.join(outputDir, files.network), run.network)
  await writeJsonl(path.join(outputDir, files.console), run.console ?? [])
  await writeJsonl(path.join(outputDir, files.walletRequests), run.walletRequests)

  return {
    ...run,
    sdkQueries: {
      file: files.sdkQueries,
      count: run.sdkQueries.length,
      eventCount: run.sdkQueryEvents ?? run.sdkQueries.length,
    },
    network: {
      file: files.network,
      count: run.network.length,
    },
    console: {
      file: files.console,
      count: run.console?.length ?? 0,
    },
    walletRequests: {
      file: files.walletRequests,
      count: run.walletRequests.length,
    },
  }
}

function recordSdkQuery(records, index, record) {
  const key = sdkQueryRecordKey(record)
  const existingIndex = index.get(key)
  if (existingIndex !== undefined) {
    const existing = records[existingIndex]
    existing.count = Number(existing.count ?? 1) + 1
    existing.lastRecordedAt = record.recordedAt
    return
  }

  records.push({
    ...record,
    count: 1,
  })
  index.set(key, records.length - 1)
}

function sdkQueryRecordKey(record) {
  const response = record.status === 'error' ? record.error : record.result
  const hash = createHash('sha256')
    .update(JSON.stringify(response ?? null))
    .digest('hex')

  return JSON.stringify([
    record.scenarioId,
    record.queryName,
    record.serializedArgs,
    record.status,
    hash,
  ])
}

async function mkdirp(dir) {
  await fs.mkdir(dir, { recursive: true })
}

function videoSizeForViewport(viewport) {
  const width = Number(viewport?.width ?? 1440)
  const height = Number(viewport?.height ?? 1000)
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 1440,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 1000,
  }
}

function parseVideoTailMs(cliValue, defaultValue) {
  const raw = cliValue ?? defaultValue ?? DEFAULT_VIDEO_TAIL_MS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--video-tail-ms must be a non-negative number, got ${JSON.stringify(raw)}`)
  }
  return Math.round(value)
}

async function closePageAndAttachVideo({ page, scenario, outputDir, result, enabled }) {
  const video = enabled ? page.video() : null
  await page.close()

  if (!enabled) return
  if (!video) {
    throw new Error(`Video recording was enabled, but Playwright did not create a video for ${scenario.id}`)
  }

  const source = await video.path()
  const target = path.join(outputDir, 'videos', `${safeFileName(scenario.id)}.webm`)
  await mkdirp(path.dirname(target))
  await fs.rm(target, { force: true }).catch(() => null)
  await moveFile(source, target)
  const stat = await fs.stat(target)
  result.video = {
    file: path.relative(ROOT_DIR, target),
    contentType: 'video/webm',
    sizeBytes: stat.size,
  }
}

async function moveFile(source, target) {
  try {
    await fs.rename(source, target)
  }
  catch {
    await fs.copyFile(source, target)
    await fs.rm(source, { force: true }).catch(() => null)
  }
}

function safeFileName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'scenario'
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  const json = await response.json()
  if (json.error) {
    throw new Error(`${method} failed: ${json.error.message ?? JSON.stringify(json.error)}`)
  }
  return json.result
}

async function setupFork(fixture, anvilRpcUrl) {
  const setup = { skipped: false, transfers: [] }
  const wallet = getAddress(fixture.wallet.address)
  const ethBalance = fixture.wallet.ethBalance ?? '1000'
  await rpc(anvilRpcUrl, 'anvil_setBalance', [wallet, toQuantity(parseEther(ethBalance))])

  for (const token of fixture.tokens ?? []) {
    if (!token.amount || !token.whale) continue
    const tokenAddress = getAddress(token.address)
    const whale = getAddress(token.whale)
    const amount = parseUnits(String(token.amount), Number(token.decimals))
    await rpc(anvilRpcUrl, 'anvil_setBalance', [whale, toQuantity(parseEther('10'))])
    await rpc(anvilRpcUrl, 'anvil_impersonateAccount', [whale]).catch(() => null)
    const hash = await rpc(anvilRpcUrl, 'eth_sendTransaction', [{
      from: whale,
      to: tokenAddress,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [wallet, amount],
      }),
      gas: toQuantity(200_000n),
    }])
    const receipt = await waitForReceipt(anvilRpcUrl, hash)
    if (receipt.status !== '0x1') {
      throw new Error(`Seed transfer failed for ${token.symbol} from ${whale}: ${hash}`)
    }
    await rpc(anvilRpcUrl, 'anvil_stopImpersonatingAccount', [whale]).catch(() => null)
    setup.transfers.push({
      token: token.symbol,
      tokenAddress,
      whale,
      recipient: wallet,
      amount: String(token.amount),
      hash,
    })
  }

  return setup
}

async function preflightV3Proxy({ appUrl, fixture }) {
  const address = Object.values(fixture.vaults ?? {}).find(Boolean)
  if (!address) return

  const endpoint = `${appUrl}/api/v3/v3/resolve/vaults`
  let response
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chainId: Number(fixture.chainId),
          addresses: [address],
        }),
      })
      if (response.ok || response.status === 401) break
      lastError = new Error(`${response.status} ${response.statusText}: ${(await response.clone().text().catch(() => '')).slice(0, 200)}`)
    }
    catch (error) {
      lastError = error
    }

    await sleep(1000 * attempt)
  }

  if (!response) {
    throw new Error(`Lite app V3 proxy preflight failed: ${String(lastError?.message ?? lastError)}`)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const stagingHint = response.status === 401
      ? ' If this run points at v3staging.eul.dev, start Nuxt with V3_API_KEY= so a production key from .env is not forwarded to staging.'
      : ''
    throw new Error(`Lite app V3 proxy preflight failed: POST /api/v3/v3/resolve/vaults returned ${response.status} ${response.statusText}.${stagingHint}${body ? ` Body: ${body.slice(0, 500)}` : ''}`)
  }

  const json = await response.json().catch(() => null)
  if (!json?.data?.some?.(item => String(item.address).toLowerCase() === String(address).toLowerCase())) {
    throw new Error(`Lite app V3 proxy preflight failed: resolve/vaults did not return ${address}`)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function preflightSwapApi({ swapApiUrl, chainId }) {
  const endpoint = `${swapApiUrl}/providers?chainId=${encodeURIComponent(String(chainId))}`
  let response
  try {
    response = await fetch(endpoint)
  }
  catch (error) {
    throw new Error(`Swap API preflight failed: ${String(error?.message ?? error)}`)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Swap API preflight failed: GET /providers returned ${response.status} ${response.statusText}.${body ? ` Body: ${body.slice(0, 500)}` : ''}`)
  }
}

async function waitForReceipt(anvilRpcUrl, hash) {
  for (let i = 0; i < 120; i++) {
    const receipt = await rpc(anvilRpcUrl, 'eth_getTransactionReceipt', [hash])
    if (receipt) return receipt
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for receipt ${hash}`)
}

async function collectRevertDiagnostics({ anvilRpcUrl, hash, receipt, tx }) {
  const callTx = {
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? '0x0',
  }
  const blockTag = receipt?.blockNumber ?? 'latest'

  const [ethCall, trace] = await Promise.all([
    rpcDiagnostic(anvilRpcUrl, 'eth_call', [callTx, blockTag]),
    rpcDiagnostic(anvilRpcUrl, 'debug_traceTransaction', [
      hash,
      {
        tracer: 'callTracer',
        tracerConfig: {
          onlyTopCall: false,
        },
      },
    ]),
  ])

  return {
    ethCall,
    trace: summarizeCallTrace(trace),
  }
}

async function rpcDiagnostic(url, method, params) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    })
    const json = await response.json()
    if (json.error) {
      return { ok: false, error: sanitizeForJson(json.error) }
    }
    return { ok: true, result: sanitizeForJson(json.result) }
  }
  catch (error) {
    return { ok: false, error: sanitizeForJson(error) }
  }
}

function summarizeCallTrace(trace) {
  if (!trace?.ok) return trace
  return {
    ok: true,
    result: summarizeCallTraceNode(trace.result),
  }
}

function summarizeCallTraceNode(node, depth = 0) {
  if (!node || typeof node !== 'object') return node
  const summarized = {
    type: node.type,
    from: node.from,
    to: node.to,
    value: node.value,
    gas: node.gas,
    gasUsed: node.gasUsed,
    error: node.error,
    revertReason: node.revertReason,
    input: typeof node.input === 'string' ? `${node.input.slice(0, 138)}${node.input.length > 138 ? '...' : ''}` : node.input,
    output: typeof node.output === 'string' ? `${node.output.slice(0, 514)}${node.output.length > 514 ? '...' : ''}` : node.output,
  }
  const calls = Array.isArray(node.calls) ? node.calls : []
  if (calls.length && depth < 4) {
    summarized.calls = calls.slice(0, 12).map(call => summarizeCallTraceNode(call, depth + 1))
    if (calls.length > 12) summarized.callsTruncated = calls.length - 12
  }
  return summarized
}

function toQuantity(value) {
  const bigint = typeof value === 'bigint' ? value : BigInt(value)
  return `0x${bigint.toString(16)}`
}

async function installWalletStub(context, fixture, anvilRpcUrl, walletRequests, onTransactionSuccess, getActiveState) {
  const chainId = Number(fixture.chainId)
  const account = privateKeyToAccount(fixture.wallet.privateKey)
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http(anvilRpcUrl) })
  const fundedImpersonations = new Set()

  if (getAddress(account.address) !== getAddress(fixture.wallet.address)) {
    throw new Error(`Fixture wallet address ${fixture.wallet.address} does not match private key ${account.address}`)
  }

  await context.exposeBinding('__EULER_STUB_WALLET_RPC__', async (_source, payload) => {
    const method = payload?.method
    // Scenarios may connect AS an existing on-chain holder instead of the
    // fixture wallet (e.g. to exercise rEUL unlock against real locks). Anvil
    // runs with --auto-impersonate, so transactions from that holder execute
    // without its private key. Resolve the active address per request because a
    // single wallet stub is shared across every scenario in the run.
    const impersonate = getActiveState?.()?.scenario?.impersonate
      ? getAddress(getActiveState().scenario.impersonate)
      : null
    const record = {
      recordedAt: new Date().toISOString(),
      method,
      params: sanitizeForJson(payload?.params),
    }
    try {
      if (impersonate && method === 'eth_sendTransaction' && !fundedImpersonations.has(impersonate)) {
        // Ensure the impersonated holder can cover gas on the fork.
        await rpc(anvilRpcUrl, 'anvil_setBalance', [impersonate, toQuantity(parseEther('1000'))]).catch(() => null)
        fundedImpersonations.add(impersonate)
      }
      const result = await handleWalletRpc({ payload, chainId, account, walletClient, anvilRpcUrl, impersonate })
      if (method === 'eth_sendTransaction') {
        const receipt = await waitForReceipt(anvilRpcUrl, result)
        if (receipt.status !== '0x1') {
          const error = new Error(`Transaction ${result} reverted with receipt status ${receipt.status}`)
          const diagnostics = await collectRevertDiagnostics({
            anvilRpcUrl,
            hash: result,
            receipt,
            tx: payload?.params?.[0] ?? {},
          })
          walletRequests.push({
            ...record,
            status: 'error',
            result: sanitizeForJson(result),
            receipt: sanitizeForJson(receipt),
            diagnostics: sanitizeForJson(diagnostics),
            error: sanitizeForJson(error),
          })
          throw error
        }
        walletRequests.push({
          ...record,
          status: 'success',
          result: sanitizeForJson(result),
          receipt: sanitizeForJson(receipt),
        })
        onTransactionSuccess?.({ hash: result, receipt })
        return result
      }

      walletRequests.push({ ...record, status: 'success', result: sanitizeForJson(result) })
      return result
    }
    catch (error) {
      walletRequests.push({ ...record, status: 'error', error: sanitizeForJson(error) })
      throw error
    }
  })

  await context.addInitScript(({ address, chainIdHex }) => {
    const listeners = new Map()
    const emit = (event, value) => {
      for (const cb of listeners.get(event) ?? []) {
        try {
          cb(value)
        }
        catch { /* ignore wallet listener errors */ }
      }
    }
    const provider = {
      isBase: true,
      isCoinbaseWallet: true,
      isEulerExecutionStub: true,
      request: async ({ method, params }) => {
        const result = await window.__EULER_STUB_WALLET_RPC__({ method, params: params ?? [] })
        if (method === 'wallet_switchEthereumChain') {
          emit('chainChanged', params?.[0]?.chainId ?? chainIdHex)
        }
        if (method === 'eth_requestAccounts') {
          emit('accountsChanged', Array.isArray(result) && result.length ? result : [address])
        }
        return result
      },
      on: (event, cb) => {
        const list = listeners.get(event) ?? []
        list.push(cb)
        listeners.set(event, list)
      },
      removeListener: (event, cb) => {
        const list = listeners.get(event) ?? []
        listeners.set(event, list.filter(item => item !== cb))
      },
    }

    Object.defineProperty(window, 'ethereum', {
      value: provider,
      configurable: true,
    })

    const detail = {
      info: {
        uuid: 'euler-execution-stub-wallet',
        name: 'Euler Execution Stub',
        icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32"%3E%3Crect width="32" height="32" rx="8" fill="%23111"/%3E%3Ctext x="16" y="21" text-anchor="middle" fill="white" font-size="14"%3EE%3C/text%3E%3C/svg%3E',
        rdns: 'finance.euler.execution-stub',
      },
      provider,
    }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
    window.addEventListener('eip6963:requestProvider', announce)
    setTimeout(announce, 0)
  }, {
    address: getAddress(fixture.wallet.address),
    chainIdHex: toQuantity(BigInt(chainId)),
  })
}

async function installVaultSnapshotRoute(context, vaultSnapshot) {
  if (!vaultSnapshot) return
  const chainId = String(vaultSnapshot.chainId)

  await context.route(/\/api\/vaults(?:\?|$)/, (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('chainId') !== chainId) {
      return route.fallback()
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'cache-control': 'public, max-age=30',
      },
      body: JSON.stringify({
        ...vaultSnapshot,
        fetchedAt: Date.now(),
      }),
    })
  })
}

async function installV3VaultResolveRoute(context, vaultSnapshot) {
  if (!vaultSnapshot) return

  const chainId = String(vaultSnapshot.chainId)
  const vaultIndex = buildV3VaultResolveIndex(vaultSnapshot)

  await context.route(/\/api\/v3\/v3\/resolve\/vaults(?:\?|$)/, async (route) => {
    const request = route.request()
    if (request.method().toUpperCase() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': '*',
        },
      })
    }

    if (request.method().toUpperCase() !== 'POST') {
      return route.fallback()
    }

    let body
    try {
      body = request.postDataJSON()
    }
    catch {
      return route.fallback()
    }

    if (String(body?.chainId) !== chainId || !Array.isArray(body?.addresses)) {
      return route.fallback()
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'cache-control': 'no-store',
      },
      body: JSON.stringify({
        data: body.addresses.map(address => resolveSnapshotVault(address, chainId, vaultIndex)),
      }),
    })
  })
}

function buildV3VaultResolveIndex(vaultSnapshot) {
  const index = new Map()
  const groups = [
    ['evkVaults', 'evk'],
    ['earnVaults', 'earn'],
    ['securitizeVaults', 'securitize'],
    ['escrowVaults', 'escrow'],
  ]

  for (const [key, vaultType] of groups) {
    for (const entry of vaultSnapshot[key] ?? []) {
      const data = entry?.data ?? entry
      if (!data?.address) continue
      const address = getAddress(data.address)
      const chainId = Number(data.chainId ?? vaultSnapshot.chainId)
      index.set(address.toLowerCase(), {
        address,
        chainId,
        vaultType: entry?.kind ?? data.type ?? vaultType,
        factory: data.factory ?? null,
        resource: resolveSnapshotVaultResource(entry?.kind ?? data.type ?? vaultType, chainId, address),
      })
    }
  }

  return index
}

function resolveSnapshotVault(address, chainId, vaultIndex) {
  let normalizedAddress
  try {
    normalizedAddress = getAddress(address)
  }
  catch {
    normalizedAddress = String(address)
  }

  const snapshotVault = vaultIndex.get(normalizedAddress.toLowerCase())
  if (!snapshotVault) {
    return {
      chainId: Number(chainId),
      address: normalizedAddress,
      found: false,
      vaultType: null,
      factory: null,
      resource: null,
    }
  }

  return {
    chainId: snapshotVault.chainId,
    address: snapshotVault.address,
    found: true,
    vaultType: snapshotVault.vaultType,
    factory: snapshotVault.factory,
    resource: snapshotVault.resource,
  }
}

function resolveSnapshotVaultResource(vaultType, chainId, address) {
  const normalizedAddress = address.toLowerCase()
  if (vaultType === 'earn') return `/v3/earn/vaults/${chainId}/${normalizedAddress}`
  if (vaultType === 'evk' || vaultType === 'escrow') return `/v3/evk/vaults/${chainId}/${normalizedAddress}`
  return null
}

async function installSwapApiRoute(context, swapApiUrl) {
  if (!swapApiUrl) return

  await context.route(/\/(?:providers|swaps)(?:\?|$)/, async (route) => {
    const request = route.request()
    const incoming = new URL(request.url())
    if (incoming.pathname !== '/providers' && incoming.pathname !== '/swaps') {
      return route.fallback()
    }

    if (request.method().toUpperCase() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': '*',
        },
      })
    }

    const upstream = await fetch(`${swapApiUrl}${incoming.pathname}${incoming.search}`, {
      method: request.method(),
      body: request.postData() ?? undefined,
    })
    const body = await upstream.text()
    return route.fulfill({
      status: upstream.status,
      contentType: upstream.headers.get('content-type') ?? 'application/json',
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
      },
      body,
    })
  })
}

async function installScenarioSubgraphDiscoveryRoute(context, fixture, getScenario) {
  await context.route(/\/api\/proxy\/subgraph\/\d+(?:\?|$)/, async (route) => {
    const scenarioState = getScenario()
    const scenario = scenarioState?.scenario ?? scenarioState
    if (!isScenarioSubgraphDiscoveryActive(scenarioState)) {
      return route.fallback()
    }
    const mocks = scenarioSubgraphAccounts(scenario, fixture)
    if (!mocks.length) {
      return route.fallback()
    }

    const request = route.request()
    if (request.method().toUpperCase() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': '*',
        },
      })
    }

    if (request.method().toUpperCase() !== 'POST') {
      return route.fallback()
    }

    const url = new URL(request.url())
    const chainId = Number(url.pathname.match(/\/api\/proxy\/subgraph\/(\d+)/)?.[1])
    if (!Number.isInteger(chainId)) {
      return route.fallback()
    }

    let body
    try {
      body = request.postDataJSON()
    }
    catch {
      return route.fallback()
    }

    const response = buildSubgraphDiscoveryMockResponse({ body, chainId, mocks })
    if (!response) {
      return route.fallback()
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'x-execution-mock': 'subgraph-discovery',
      },
      body: JSON.stringify(response),
    })
  })
}

function isScenarioSubgraphDiscoveryActive(scenarioState) {
  const scenario = scenarioState?.scenario ?? scenarioState
  const activation = scenario?.discoveryMocks?.activation
  if (activation === 'afterFirstTransaction') {
    return Number(scenarioState?.successfulWalletTransactions ?? 0) > 0
  }
  return true
}

function scenarioSubgraphAccounts(scenario, fixture) {
  const configured = scenario?.discoveryMocks?.subgraph?.accounts
    ?? scenario?.subgraphMocks
    ?? []
  if (!Array.isArray(configured) || configured.length === 0) return []

  const fixtureWallet = fixture?.wallet?.address ? getAddress(fixture.wallet.address) : undefined
  return configured.map((item) => {
    const account = item.account ? getAddress(item.account) : fixtureWallet
    if (!account && !item.id) {
      throw new Error(`Subgraph discovery mock in ${scenario.id} requires account or id`)
    }
    const defaultSubAccount = resolveMockSubAccount(item, account)
    return {
      chainId: Number(item.chainId ?? fixture.chainId),
      id: String(item.id ?? addressPrefix(account)).toLowerCase(),
      deposits: encodeTrackingEntries(item.deposits ?? [], defaultSubAccount),
      borrows: encodeTrackingEntries(item.borrows ?? [], defaultSubAccount),
    }
  })
}

function buildSubgraphDiscoveryMockResponse({ body, chainId, mocks }) {
  const query = String(body?.query ?? '')
  if (query.includes('_meta')) {
    return {
      data: {
        _meta: {
          block: {
            number: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    }
  }

  const index = new Map(
    mocks
      .filter(item => item.chainId === chainId)
      .map(item => [item.id, item]),
  )

  if (body?.operationName === 'AccountVaults' || query.includes('trackingActiveAccounts')) {
    const ids = Array.isArray(body?.variables?.ids) ? body.variables.ids : []
    return {
      data: {
        trackingActiveAccounts: ids
          .map(id => index.get(String(id).toLowerCase()))
          .filter(Boolean)
          .map(item => ({
            id: item.id,
            deposits: item.deposits,
            borrows: item.borrows,
          })),
      },
    }
  }

  if (body?.operationName === 'AccountPositions' || query.includes('trackingActiveAccount')) {
    const id = String(body?.variables?.id ?? query.match(/trackingActiveAccount\s*\(\s*id:\s*"([^"]+)"/)?.[1] ?? '').toLowerCase()
    const item = id ? index.get(id) : undefined
    return {
      data: {
        trackingActiveAccount: item
          ? {
              id: item.id,
              deposits: item.deposits,
              borrows: item.borrows,
            }
          : null,
      },
    }
  }

  return null
}

function encodeTrackingEntries(entries, defaultSubAccount) {
  return entries.map((entry) => {
    if (typeof entry === 'string') return entry.toLowerCase()
    const subAccount = resolveMockSubAccount(entry, defaultSubAccount)
    const vault = getAddress(entry.vault ?? entry.vaultAddress)
    return `${subAccount.toLowerCase()}${vault.toLowerCase().slice(2)}`
  })
}

function resolveMockSubAccount(item, fallback) {
  if (item?.subAccount) return getAddress(item.subAccount)
  if (item?.account) return getAddress(item.account)
  if (item?.subAccountIndex !== undefined) {
    const index = BigInt(item.subAccountIndex)
    return getAddress(`0x${(BigInt(getAddress(fallback)) ^ index).toString(16).padStart(40, '0')}`)
  }
  return getAddress(fallback)
}

function addressPrefix(address) {
  return getAddress(address).toLowerCase().slice(0, 40)
}

async function handleWalletRpc({ payload, chainId, account, walletClient, anvilRpcUrl, impersonate }) {
  const method = payload?.method
  const params = payload?.params ?? []
  switch (method) {
    case 'eth_accounts':
    case 'eth_requestAccounts':
      return [impersonate ?? account.address]
    case 'eth_chainId':
      return toQuantity(BigInt(chainId))
    case 'net_version':
      return String(chainId)
    case 'wallet_switchEthereumChain':
      if (Number(params?.[0]?.chainId) !== chainId && BigInt(params?.[0]?.chainId ?? 0) !== BigInt(chainId)) {
        throw Object.assign(new Error(`Unsupported chain ${params?.[0]?.chainId}`), { code: 4902 })
      }
      return null
    case 'wallet_addEthereumChain':
      return null
    case 'wallet_getPermissions':
      return [{ parentCapability: 'eth_accounts' }]
    case 'wallet_requestPermissions':
      return [{ parentCapability: 'eth_accounts' }]
    case 'eth_sendTransaction':
      // When impersonating, send the raw transaction straight to anvil with the
      // holder as `from`; --auto-impersonate executes it without a signature.
      if (impersonate) {
        return rpc(anvilRpcUrl, 'eth_sendTransaction', [{ ...(params?.[0] ?? {}), from: impersonate }])
      }
      return sendTransaction(walletClient, params?.[0] ?? {})
    case 'eth_signTypedData_v4':
      if (impersonate) {
        throw new Error(`Cannot sign typed data while impersonating ${impersonate}: this flow requires a private key the harness does not hold`)
      }
      return signTypedData(account, params?.[1])
    case 'personal_sign':
    case 'eth_sign':
      if (impersonate) {
        throw new Error(`Cannot sign messages while impersonating ${impersonate}: this flow requires a private key the harness does not hold`)
      }
      return signMessage(account, params)
    default:
      return rpc(anvilRpcUrl, method, params)
  }
}

async function sendTransaction(walletClient, tx) {
  return walletClient.sendTransaction({
    account: walletClient.account,
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : 0n,
    gas: tx.gas ? BigInt(tx.gas) : undefined,
    maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined,
    nonce: tx.nonce ? Number(BigInt(tx.nonce)) : undefined,
  })
}

async function signTypedData(account, payload) {
  const typedData = typeof payload === 'string' ? JSON.parse(payload) : payload
  const types = { ...(typedData.types ?? {}) }
  delete types.EIP712Domain
  return account.signTypedData({
    domain: typedData.domain,
    message: typedData.message,
    primaryType: typedData.primaryType,
    types,
  })
}

async function signMessage(account, params) {
  const first = params?.[0]
  const second = params?.[1]
  const message = typeof first === 'string' && first.startsWith('0x') && first.length === 42
    ? second
    : first
  return account.signMessage({ message: { raw: message } })
}

function attachNetworkRecorder(page, network) {
  const ids = new WeakMap()
  let nextId = 1

  page.on('request', (request) => {
    if (!shouldCaptureUrl(request.url())) return
    const id = nextId++
    ids.set(request, id)
    network.push({
      id,
      type: 'request',
      recordedAt: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      postData: parseCapturedBody(request.postData(), request.url()),
    })
  })

  page.on('response', async (response) => {
    const request = response.request()
    if (!shouldCaptureUrl(response.url()) && !ids.has(request)) return
    const id = ids.get(request) ?? nextId++
    let body = null
    try {
      const text = await response.text()
      body = parseCapturedBody(text, response.url())
    }
    catch (error) {
      body = { unreadable: true, error: String(error?.message ?? error) }
    }
    network.push({
      id,
      type: 'response',
      recordedAt: new Date().toISOString(),
      status: response.status(),
      url: response.url(),
      headers: response.headers(),
      body,
    })
  })
}

function attachConsoleRecorder(page, records, scenarioId) {
  page.on('console', (message) => {
    records.push({
      scenarioId,
      type: 'console',
      level: message.type(),
      recordedAt: new Date().toISOString(),
      text: message.text(),
      location: message.location(),
    })
  })

  page.on('pageerror', (error) => {
    records.push({
      scenarioId,
      type: 'pageerror',
      level: 'error',
      recordedAt: new Date().toISOString(),
      error: sanitizeForJson(error),
    })
  })
}

function parseCapturedBody(text, rawUrl) {
  if (text === null || text === undefined) return null
  const limit = getCapturedBodyLimit(rawUrl)
  if (String(text).length > limit) {
    return {
      truncated: true,
      chars: String(text).length,
      prefix: String(text).slice(0, limit),
    }
  }
  return safeParseJson(text)
}

function getCapturedBodyLimit(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.pathname.startsWith('/api/rpc')) return MAX_CAPTURED_RPC_BODY_CHARS
    if (url.hostname.includes('swap')) return MAX_CAPTURED_SWAP_BODY_CHARS
    return MAX_CAPTURED_API_BODY_CHARS
  }
  catch {
    if (String(rawUrl).includes('/api/rpc')) return MAX_CAPTURED_RPC_BODY_CHARS
    if (String(rawUrl).includes('swap')) return MAX_CAPTURED_SWAP_BODY_CHARS
    return MAX_CAPTURED_API_BODY_CHARS
  }
}

function shouldCaptureUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    const pathName = url.pathname
    return pathName.startsWith('/api/v3')
      || pathName.startsWith('/api/proxy')
      || pathName.startsWith('/api/pyth')
      || pathName.startsWith('/api/rpc')
      || pathName.startsWith('/api/euler-chains')
      || pathName.startsWith('/api/labels')
      || pathName.startsWith('/api/vaults')
      || pathName.startsWith('/api/oracle-adapters')
      || pathName.startsWith('/api/token-list')
      || url.hostname.includes('swap')
  }
  catch {
    return rawUrl.includes('/api/') || rawUrl.includes('swap')
  }
}

async function runScenario({ page, appUrl, defaults, scenario, outputDir, variables, videoTailMs, fixture }) {
  const result = {
    id: scenario.id,
    label: scenario.label,
    covers: scenario.covers ?? [],
    startedAt: new Date().toISOString(),
    actions: [],
    captures: [],
    status: 'passed',
  }
  try {
    await applyLocalStorage(page, appUrl, { ...(defaults.localStorage ?? {}), ...(scenario.localStorage ?? {}) })
    await gotoScenarioPath(page, appUrl, interpolateValue(scenario.path, variables))
    await waitForSelectors(page, scenario.waitFor ?? defaults.waitFor, scenario.timeoutMs ?? defaults.timeoutMs)
    if (scenario.settleMs ?? defaults.settleMs) {
      await page.waitForTimeout(Number(scenario.settleMs ?? defaults.settleMs))
    }

    for (const action of scenario.actions ?? []) {
      const actionResult = await performAction(page, action, variables, defaults, fixture)
      result.actions.push(actionResult)
      if (action.captureTagsAfter) {
        result.captures.push({
          id: `${action.label ?? action.type}:after`,
          url: page.url(),
          tags: await captureVisibleTags(page),
        })
      }
    }

    result.captures.push({
      id: 'final',
      url: page.url(),
      tags: await captureVisibleTags(page),
    })

    for (const capture of scenario.postCaptures ?? []) {
      await gotoScenarioPath(page, appUrl, interpolateValue(capture.path, variables))
      await waitForSelectors(page, capture.waitFor, capture.timeoutMs)
      if (capture.settleMs) await page.waitForTimeout(Number(capture.settleMs))
      result.captures.push({
        id: capture.id,
        url: page.url(),
        tags: await captureVisibleTags(page),
      })
    }

    if (videoTailMs > 0) {
      await page.waitForTimeout(videoTailMs)
      result.videoTailMs = videoTailMs
    }
  }
  catch (error) {
    result.status = 'failed'
    result.error = sanitizeForJson(error)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const screenshot = path.join(outputDir, `${scenario.id}-${stamp}.png`)
    const html = path.join(outputDir, `${scenario.id}-${stamp}.html`)
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => null)
    await fs.writeFile(html, await page.content().catch(() => ''), 'utf8').catch(() => null)
    result.failureArtifacts = {
      screenshot: path.relative(ROOT_DIR, screenshot),
      html: path.relative(ROOT_DIR, html),
    }
  }
  finally {
    result.finishedAt = new Date().toISOString()
  }
  return result
}

async function applyLocalStorage(page, appUrl, entries) {
  if (!Object.keys(entries).length) return
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.evaluate((items) => {
    for (const [key, value] of Object.entries(items)) {
      window.localStorage.setItem(key, String(value))
    }
  }, entries)
}

async function gotoScenarioPath(page, appUrl, pathName) {
  const url = appUrl + (String(pathName).startsWith('/') ? pathName : `/${pathName}`)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
}

function interpolateValue(value, variables) {
  if (typeof value !== 'string') return value
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const replacement = variables?.[name]
    if (replacement === undefined) {
      throw new Error(`Missing execution recorder variable: ${name}`)
    }
    return String(replacement)
  })
}

async function waitForSelectors(page, selectors, timeoutMs = 30_000) {
  for (const selector of selectors ?? []) {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: Number(timeoutMs) })
  }
}

async function performAction(page, action, variables, defaults = {}, fixture) {
  const startedAt = Date.now()
  const label = action.label ?? action.type
  const timeout = Number(action.timeoutMs ?? defaults.actionTimeoutMs ?? 30_000)
  try {
    if (action.type === 'wait') {
      await page.waitForTimeout(Number(action.ms ?? 0))
    }
    else if (action.type === 'waitFor') {
      await page.locator(action.selector).first().waitFor({ state: 'visible', timeout })
    }
    else if (action.type === 'click') {
      const locator = page.locator(action.selector).nth(Number(action.index ?? 0))
      await waitForOptional(locator, action)
      await locator.click({ timeout })
      await waitForSelectors(page, action.waitFor, timeout)
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
    }
    else if (action.type === 'clickButton') {
      const locator = page.getByRole('button', { name: action.text, exact: action.exact ?? true }).nth(Number(action.index ?? 0))
      await waitForOptional(locator, action)
      await locator.click({ timeout })
      await waitForSelectors(page, action.waitFor, timeout)
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
    }
    else if (action.type === 'clickTab') {
      const tabLabel = action.tab ?? action.text
      if (!tabLabel) {
        throw new Error('clickTab requires tab')
      }
      const locator = page.locator(`[data-id="tab"][data-value=${cssString(tabLabel)}] button`).nth(Number(action.index ?? 0))
      await waitForOptional(locator, action)
      await locator.click({ timeout })
      await waitForSelectors(page, action.waitFor, timeout)
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
    }
    else if (action.type === 'fill') {
      const locator = page.locator(action.selector).nth(Number(action.index ?? 0))
      await waitForOptional(locator, action)
      await locator.click({ timeout })
      await locator.fill('', { timeout }).catch(() => null)
      await locator.type(String(action.value ?? ''), { delay: Number(action.delayMs ?? 30), timeout })
      await waitForSelectors(page, action.waitFor, timeout)
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
    }
    else if (action.type === 'fillAsset') {
      const assetLabel = action.assetLabel ?? action.field
      if (!assetLabel) {
        throw new Error('fillAsset requires assetLabel')
      }
      const selector = `[data-id="asset-input"][data-label=${cssString(assetLabel)}] [data-id="asset-input-field"]`
      const locator = page.locator(selector).nth(Number(action.index ?? 0))
      await waitForOptional(locator, action)
      await locator.click({ timeout })
      await locator.fill('', { timeout }).catch(() => null)
      await locator.type(String(action.value ?? ''), { delay: Number(action.delayMs ?? 30), timeout })
      await waitForSelectors(page, action.waitFor, timeout)
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
    }
    else if (action.type === 'clickAssetMax') {
      const assetLabel = action.assetLabel ?? action.field
      if (!assetLabel) {
        throw new Error('clickAssetMax requires assetLabel')
      }
      const selector = `[data-id="asset-input"][data-label=${cssString(assetLabel)}] [data-id="asset-input-max"]`
      const locator = page.locator(selector).nth(Number(action.index ?? 0))
      await waitForOptional(locator, action)
      await locator.click({ timeout })
      await waitForSelectors(page, action.waitFor, timeout)
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
    }
    else if (action.type === 'clickRangeStep') {
      const rangeLabel = action.rangeLabel ?? action.field
      if (!rangeLabel) {
        throw new Error('clickRangeStep requires rangeLabel')
      }
      const range = page.locator(`[data-id="ui-range"][data-label=${cssString(rangeLabel)}]`).nth(Number(action.rangeIndex ?? 0))
      await waitForOptional(range, action)
      const track = range.locator('[data-id="ui-range-track"]').first()
      await track.waitFor({ state: 'visible', timeout })
      const min = Number(await range.getAttribute('data-min') ?? 0)
      const max = Number(await range.getAttribute('data-max') ?? 100)
      const targetValue = action.value === undefined
        ? Number(await range.locator('[data-id="ui-range-step"]').nth(Number(action.index ?? 0)).getAttribute('data-value'))
        : Number(action.value)
      if (!Number.isFinite(targetValue) || max <= min) {
        throw new Error(`Invalid range target for ${rangeLabel}`)
      }
      const box = await track.boundingBox()
      if (!box) {
        throw new Error(`Range track for ${rangeLabel} has no bounding box`)
      }
      const ratio = Math.max(0, Math.min(1, (targetValue - min) / (max - min)))
      await page.mouse.click(box.x + box.width * ratio, box.y + box.height / 2)
      await waitForSelectors(page, action.waitFor, timeout)
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
    }
    else if (action.type === 'seedVaultDeposit') {
      await seedVaultDeposit(page, action, fixture)
      await waitForSelectors(page, action.waitFor, timeout)
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
    }
    else if (action.type === 'selectSwapToken') {
      const trigger = action.triggerSelector
        ? page.locator(action.triggerSelector).nth(Number(action.triggerIndex ?? 0))
        : page.locator(`xpath=//span[normalize-space()=${xpathString(action.triggerLabel ?? 'Pay with')}]/following-sibling::button[1]`).nth(Number(action.triggerIndex ?? 0))
      await waitForOptional(trigger, action)
      await trigger.click({ timeout })

      const search = action.search ?? action.address ?? action.symbol
      const searchInput = page.locator('input[placeholder="Search by name, symbol, or address"]').first()
      await searchInput.waitFor({ state: 'visible', timeout })
      if (search) {
        await searchInput.fill('', { timeout }).catch(() => null)
        await searchInput.type(String(search), { delay: Number(action.delayMs ?? 20), timeout })
      }

      const tokenSelector = getSwapTokenSelector(action)
      const option = page.locator(`${tokenSelector}:not([data-token-disabled="true"])`).nth(Number(action.index ?? 0))
      await option.waitFor({ state: 'visible', timeout })
      await option.click({ timeout })
      await waitForSelectors(page, action.waitFor, timeout)
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
    }
    else if (action.type === 'selectCollateralOption') {
      const assetLabel = action.assetLabel ?? action.field
      if (!assetLabel) {
        throw new Error('selectCollateralOption requires assetLabel')
      }
      const trigger = page.locator(`[data-id="asset-input"][data-label=${cssString(assetLabel)}] [data-id="asset-input-asset-selector"]`).nth(Number(action.triggerIndex ?? 0))
      await waitForOptional(trigger, action)

      const search = action.search ?? action.vaultAddress ?? action.assetAddress ?? action.symbol
      const searchInput = page.locator('input[placeholder="Search by name or symbol"]').first()
      await clickUntilVisible(page, trigger, searchInput, timeout, Number(action.modalProbeMs ?? 1500))
      if (search && !String(search).startsWith('0x')) {
        await searchInput.fill('', { timeout }).catch(() => null)
        await searchInput.type(String(search), { delay: Number(action.delayMs ?? 20), timeout })
      }

      const optionSelector = getCollateralOptionSelector(action)
      const option = page.locator(`${optionSelector}:not([data-option-disabled="true"])`).nth(Number(action.index ?? 0))
      await option.waitFor({ state: 'visible', timeout })
      await option.click({ timeout })
      await waitForSelectors(page, action.waitFor, timeout)
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
    }
    else if (action.type === 'expectText') {
      await page.getByText(action.text, { exact: Boolean(action.exact) }).first().waitFor({ state: 'visible', timeout })
    }
    else if (action.type === 'rememberPath') {
      const variable = action.variable
      if (!variable) {
        throw new Error('rememberPath requires variable')
      }
      const current = new URL(page.url())
      variables[variable] = `${current.pathname}${current.search}`
      if (action.settleMs) await page.waitForTimeout(Number(action.settleMs))
      return {
        type: action.type,
        label,
        status: 'passed',
        durationMs: Date.now() - startedAt,
        variable,
        value: variables[variable],
      }
    }
    else {
      throw new Error(`Unsupported action type: ${action.type}`)
    }
    return { type: action.type, label, status: 'passed', durationMs: Date.now() - startedAt }
  }
  catch (error) {
    if (action.optional) {
      return { type: action.type, label, status: 'skipped', durationMs: Date.now() - startedAt, reason: String(error?.message ?? error) }
    }
    throw error
  }
}

function cssString(value) {
  return JSON.stringify(String(value))
}

function xpathString(value) {
  const text = String(value)
  const singleQuote = String.fromCharCode(39)
  const doubleQuote = String.fromCharCode(34)
  if (!text.includes(singleQuote)) {
    return `${singleQuote}${text}${singleQuote}`
  }
  if (!text.includes(doubleQuote)) {
    return `${doubleQuote}${text}${doubleQuote}`
  }
  const quotedParts = text.split(singleQuote).map(part => `${singleQuote}${part}${singleQuote}`)
  return `concat(${quotedParts.join(`, ${doubleQuote}${singleQuote}${doubleQuote}, `)})`
}

function getSwapTokenSelector(action) {
  if (action.address) {
    return `[data-id="swap-token-option"][data-token-address=${cssString(String(action.address).toLowerCase())}]`
  }
  if (action.symbol) {
    return `[data-id="swap-token-option"][data-token-symbol=${cssString(action.symbol)}]`
  }
  throw new Error('selectSwapToken requires address or symbol')
}

function getCollateralOptionSelector(action) {
  let selector = '[data-id="collateral-option"]'
  if (action.vaultAddress) {
    selector += `[data-option-vault-address=${cssString(String(action.vaultAddress).toLowerCase())}]`
  }
  if (action.assetAddress) {
    selector += `[data-option-asset-address=${cssString(String(action.assetAddress).toLowerCase())}]`
  }
  if (action.symbol) {
    selector += `[data-option-symbol=${cssString(action.symbol)}]`
  }
  if (action.optionType) {
    selector += `[data-option-type=${cssString(action.optionType)}]`
  }
  return selector
}

async function waitForOptional(locator, action) {
  try {
    await locator.waitFor({ state: 'visible', timeout: Number(action.optional ? action.probeMs ?? 2_500 : action.timeoutMs ?? 30_000) })
  }
  catch (error) {
    if (action.optional) throw error
    throw error
  }
}

async function seedVaultDeposit(page, action, fixture) {
  if (!fixture?.wallet?.address) {
    throw new Error('seedVaultDeposit requires a fixture wallet')
  }

  const wallet = getAddress(fixture.wallet.address)
  const assetAddress = getAddress(action.assetAddress)
  const vaultAddress = getAddress(action.vaultAddress)
  const amount = parseUnits(String(action.amount), Number(action.decimals ?? 18))
  const receiver = resolveMockSubAccount(
    { subAccount: action.subAccount, subAccountIndex: action.subAccountIndex },
    wallet,
  )
  const resetApprovalData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [vaultAddress, 0n],
  })
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [vaultAddress, amount],
  })
  const depositData = encodeFunctionData({
    abi: EVaultDepositAbi,
    functionName: 'deposit',
    args: [amount, receiver],
  })

  await page.evaluate(async ({ assetAddress, vaultAddress, resetApprovalData, approveData, depositData }) => {
    if (!window.ethereum?.request) {
      throw new Error('Stub wallet unavailable')
    }

    await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ to: assetAddress, data: resetApprovalData, value: '0x0' }],
    })
    await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ to: assetAddress, data: approveData, value: '0x0' }],
    })
    await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ to: vaultAddress, data: depositData, value: '0x0' }],
    })
  }, { assetAddress, vaultAddress, resetApprovalData, approveData, depositData })
}

async function clickUntilVisible(page, trigger, target, timeout, probeMs) {
  const startedAt = Date.now()
  let lastError

  while (Date.now() - startedAt < timeout) {
    try {
      if (await target.isVisible().catch(() => false)) return
      const remaining = Math.max(1, timeout - (Date.now() - startedAt))
      await trigger.click({ timeout: Math.min(5000, remaining) })
      await target.waitFor({ state: 'visible', timeout: Math.min(probeMs, Math.max(1, timeout - (Date.now() - startedAt))) })
      return
    }
    catch (error) {
      lastError = error
      if (Date.now() - startedAt >= timeout) break
      await page.waitForTimeout(Math.min(500, Math.max(1, timeout - (Date.now() - startedAt))))
    }
  }

  if (lastError) throw lastError
  await target.waitFor({ state: 'visible', timeout: 1 })
}

async function captureVisibleTags(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number(style.opacity || '1') > 0
    }

    return Array.from(document.querySelectorAll('[data-id], [data-label], [data-parity-key], [data-list]'))
      .filter(isVisible)
      .map((el) => {
        const attrs = {}
        for (const attr of Array.from(el.attributes)) {
          if (attr.name.startsWith('data-') || attr.name === 'aria-label' || attr.name === 'role') {
            attrs[attr.name] = attr.value
          }
        }
        const rect = el.getBoundingClientRect()
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          attrs,
          box: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        }
      })
  })
}

function safeParseJson(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return sanitizeForJson(value)
  try {
    return JSON.parse(value)
  }
  catch {
    return value
  }
}

function sanitizeForJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return { __bi: value.toString() }
  if (typeof value === 'undefined') return '[undefined]'
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (Array.isArray(value)) return value.map(item => sanitizeForJson(item, seen))
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = sanitizeForJson(child, seen)
  }
  return out
}

function renderReport(run) {
  const passed = run.scenarios.filter(s => s.status === 'passed').length
  const failed = run.scenarios.filter(s => s.status !== 'passed').length
  const passedScenarios = run.scenarios.filter(s => s.status === 'passed')
  const txHashes = run.walletRequests
    .filter(item => item.method === 'eth_sendTransaction' && item.status === 'success')
    .map(item => item.result)
  const covered = [...new Set(passedScenarios.flatMap(s => s.covers ?? []))]
  const unsupported = run.unsupportedTransactionTypes ?? []
  return [
    '# Execution Recording Report',
    '',
    `- App URL: ${run.appUrl}`,
    `- Anvil RPC: ${run.anvilRpcUrl}`,
    `- Vault snapshot: ${run.vaultSnapshotPath ?? 'live app endpoint'}`,
    `- Fork block: ${run.fork.forkBlockNumber ?? 'not pinned'}; observed ${run.fork.observedBlockNumber ?? 'unknown'}`,
    `- Wallet: ${run.wallet.address}`,
    `- Scenarios: ${passed} passed, ${failed} failed`,
    `- Covered transaction types: ${covered.length ? covered.join(', ') : 'none'}`,
    `- Unsupported transaction types: ${unsupported.length ? unsupported.join(', ') : 'none'}`,
    `- SDK query records: ${run.sdkQueries.length} unique (${run.sdkQueryEvents ?? run.sdkQueries.length} events)`,
    `- Network records: ${run.network.length}`,
    `- Console records: ${run.console?.length ?? 0}`,
    `- Transactions sent: ${txHashes.length}`,
    '',
    '## Transactions',
    '',
    ...(txHashes.length ? txHashes.map(hash => `- ${hash}`) : ['- none']),
    '',
    '## Scenarios',
    '',
    ...run.scenarios.map(s => `- ${s.status === 'passed' ? 'PASS' : 'FAIL'} ${s.id}${s.error ? `: ${s.error.message ?? s.error}` : ''}`),
    '',
  ].join('\n')
}

function renderHtmlReport(run, outputDir) {
  const passed = run.scenarios.filter(s => s.status === 'passed').length
  const failed = run.scenarios.filter(s => s.status !== 'passed').length
  const passedScenarios = run.scenarios.filter(s => s.status === 'passed')
  const txHashes = run.walletRequests
    .filter(item => item.method === 'eth_sendTransaction' && item.status === 'success')
    .map(item => item.result)
  const covered = [...new Set(passedScenarios.flatMap(s => s.covers ?? []))]
  const unsupported = run.unsupportedTransactionTypes ?? []
  const videoCount = run.scenarios.filter(s => s.video?.file).length

  return htmlPage('Execution Recording Report', `
    <header>
      <p class="eyebrow">Forked execution recording</p>
      <h1>Execution Recording Report</h1>
      <p class="muted">${escapeHtml(run.startedAt)}${run.finishedAt ? ` to ${escapeHtml(run.finishedAt)}` : ''}</p>
    </header>

    <section class="summary-grid">
      ${summaryCard('Scenarios', `${passed} passed / ${failed} failed`, failed ? 'bad' : 'good')}
      ${summaryCard('Videos', `${videoCount} recorded`, videoCount === run.scenarios.length ? 'good' : 'warn')}
      ${summaryCard('Transactions', String(txHashes.length), txHashes.length ? 'good' : 'warn')}
      ${summaryCard('Coverage', covered.length ? `${covered.length} types` : 'none', covered.length ? 'good' : 'warn')}
      ${summaryCard('Unsupported', unsupported.length ? String(unsupported.length) : 'none', unsupported.length ? 'warn' : 'good')}
    </section>

    <section>
      <h2>Run</h2>
      <dl class="metadata">
        <div><dt>App URL</dt><dd>${escapeHtml(run.appUrl)}</dd></div>
        <div><dt>Anvil RPC</dt><dd>${escapeHtml(run.anvilRpcUrl)}</dd></div>
        <div><dt>Vault snapshot</dt><dd>${escapeHtml(run.vaultSnapshotPath ?? 'live app endpoint')}</dd></div>
        <div><dt>Fork block</dt><dd>${escapeHtml(run.fork.forkBlockNumber ?? 'not pinned')} / observed ${escapeHtml(run.fork.observedBlockNumber ?? 'unknown')}</dd></div>
        <div><dt>Wallet</dt><dd><code>${escapeHtml(run.wallet.address)}</code></dd></div>
        <div><dt>SDK query records</dt><dd>${run.sdkQueries.length} unique / ${run.sdkQueryEvents ?? run.sdkQueries.length} events</dd></div>
        <div><dt>Network records</dt><dd>${run.network.length}</dd></div>
        <div><dt>Console records</dt><dd>${run.console?.length ?? 0}</dd></div>
      </dl>
    </section>

    <section>
      <h2>Coverage</h2>
      <div class="pills">${covered.length ? covered.map(type => `<span>${escapeHtml(type)}</span>`).join('') : '<span class="warn">none</span>'}</div>
      ${unsupported.length ? `<p class="muted">Unsupported: ${escapeHtml(unsupported.join(', '))}</p>` : ''}
    </section>

    <section>
      <h2>Tests</h2>
      <div class="test-list">
        ${run.scenarios.map(scenario => renderScenarioHtml({
          scenario,
          outputDir,
          transactions: transactionsForScenario(run.walletRequests, scenario),
        })).join('')}
      </div>
    </section>

    <section>
      <h2>Sidecars</h2>
      <ul class="links">
        <li><a href="run.json">run.json</a></li>
        <li><a href="sdk-queries.jsonl">sdk-queries.jsonl</a></li>
        <li><a href="network.jsonl">network.jsonl</a></li>
        <li><a href="console.jsonl">console.jsonl</a></li>
        <li><a href="wallet-requests.jsonl">wallet-requests.jsonl</a></li>
        <li><a href="report.md">report.md</a></li>
      </ul>
    </section>
  `)
}

function renderScenarioHtml({ scenario, outputDir, transactions }) {
  const status = scenario.status === 'passed' ? 'passed' : 'failed'
  return `
    <details class="test-card ${status}">
      <summary>
        <span class="status ${status}">${escapeHtml(status.toUpperCase())}</span>
        <span class="test-title">${escapeHtml(scenario.id)}</span>
        <span class="test-meta">${escapeHtml(scenario.label ?? '')}</span>
      </summary>
      <div class="test-body">
        <div class="scenario-grid">
          <div>
            <h3>Details</h3>
            <dl class="metadata compact">
              <div><dt>Started</dt><dd>${escapeHtml(scenario.startedAt)}</dd></div>
              <div><dt>Finished</dt><dd>${escapeHtml(scenario.finishedAt ?? '')}</dd></div>
              <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(scenario.startedAt, scenario.finishedAt))}</dd></div>
              <div><dt>Transactions</dt><dd>${transactions.length}</dd></div>
              <div><dt>Captures</dt><dd>${scenario.captures?.length ?? 0}</dd></div>
            </dl>
            <div class="pills">${(scenario.covers ?? []).map(type => `<span>${escapeHtml(type)}</span>`).join('') || '<span>none</span>'}</div>
          </div>
          <div>
            <h3>Recording</h3>
            ${renderVideo(scenario.video, outputDir)}
          </div>
        </div>

        ${scenario.error ? `<section class="error"><h3>Error</h3><pre>${escapeHtml(scenario.error.message ?? JSON.stringify(scenario.error, null, 2))}</pre></section>` : ''}
        ${scenario.failureArtifacts ? renderFailureArtifacts(scenario.failureArtifacts, outputDir) : ''}
        ${renderActions(scenario.actions ?? [])}
        ${renderTransactions(transactions)}
        ${renderCaptureSummary(scenario.captures ?? [])}
      </div>
    </details>
  `
}

function renderVideo(video, outputDir) {
  if (video?.file) {
    const href = artifactHref(outputDir, video.file)
    return `
      <video controls preload="metadata" src="${escapeAttr(href)}"></video>
      <p class="muted"><a href="${escapeAttr(href)}">${escapeHtml(path.basename(video.file))}</a> (${escapeHtml(formatBytes(video.sizeBytes))})</p>
    `
  }
  if (video?.status) {
    return `<p class="muted">${escapeHtml(video.status)}${video.reason ? `: ${escapeHtml(video.reason)}` : ''}</p>`
  }
  return '<p class="muted">No video recorded.</p>'
}

function renderFailureArtifacts(artifacts, outputDir) {
  const screenshot = artifacts.screenshot ? artifactHref(outputDir, artifacts.screenshot) : null
  const html = artifacts.html ? artifactHref(outputDir, artifacts.html) : null
  return `
    <section>
      <h3>Failure Artifacts</h3>
      <ul class="links">
        ${screenshot ? `<li><a href="${escapeAttr(screenshot)}">screenshot</a></li>` : ''}
        ${html ? `<li><a href="${escapeAttr(html)}">html snapshot</a></li>` : ''}
      </ul>
    </section>
  `
}

function renderActions(actions) {
  if (!actions.length) return ''
  return `
    <section>
      <h3>Actions</h3>
      <table>
        <thead><tr><th>Action</th><th>Status</th><th>Duration</th></tr></thead>
        <tbody>
          ${actions.map(action => `
            <tr>
              <td>${escapeHtml(action.label ?? action.type)}</td>
              <td>${escapeHtml(action.status ?? '')}</td>
              <td>${escapeHtml(action.durationMs === undefined ? '' : `${action.durationMs} ms`)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `
}

function renderTransactions(transactions) {
  if (!transactions.length) return ''
  return `
    <section>
      <h3>Transactions</h3>
      <ul class="hash-list">
        ${transactions.map(hash => `<li><code>${escapeHtml(hash)}</code></li>`).join('')}
      </ul>
    </section>
  `
}

function renderCaptureSummary(captures) {
  if (!captures.length) return ''
  return `
    <section>
      <h3>Visible Data Captures</h3>
      ${captures.map(capture => `
        <details class="capture">
          <summary>${escapeHtml(capture.id)} - ${capture.tags?.length ?? 0} visible tagged elements</summary>
          <p class="muted">${escapeHtml(capture.url ?? '')}</p>
          ${renderTagSample(capture.tags ?? [])}
        </details>
      `).join('')}
    </section>
  `
}

function renderTagSample(tags) {
  if (!tags.length) return '<p class="muted">No visible tags captured.</p>'
  const sample = tags.slice(0, 20)
  return `
    <table>
      <thead><tr><th>Element</th><th>Data</th><th>Text</th></tr></thead>
      <tbody>
        ${sample.map(tag => `
          <tr>
            <td>${escapeHtml(tag.tag)}</td>
            <td><code>${escapeHtml(JSON.stringify(tag.attrs ?? {}))}</code></td>
            <td>${escapeHtml(tag.text ?? '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${tags.length > sample.length ? `<p class="muted">Showing ${sample.length} of ${tags.length}. Full capture is in run.json.</p>` : ''}
  `
}

function transactionsForScenario(walletRequests, scenario) {
  const started = Date.parse(scenario.startedAt)
  const finished = Date.parse(scenario.finishedAt ?? scenario.startedAt)
  return walletRequests
    .filter(item => item.method === 'eth_sendTransaction' && item.status === 'success')
    .filter((item) => {
      const recorded = Date.parse(item.recordedAt)
      return Number.isFinite(recorded)
        && Number.isFinite(started)
        && Number.isFinite(finished)
        && recorded >= started
        && recorded <= finished
    })
    .map(item => item.result)
}

function walletErrorsForScenario(walletRequests, scenario) {
  const started = Date.parse(scenario.startedAt)
  const finished = Date.parse(scenario.finishedAt ?? scenario.startedAt)
  return walletRequests
    .filter(item => item.method === 'eth_sendTransaction' && item.status === 'error')
    .filter((item) => {
      const recorded = Date.parse(item.recordedAt)
      return Number.isFinite(recorded)
        && Number.isFinite(started)
        && Number.isFinite(finished)
        && recorded >= started
        && recorded <= finished
    })
    .map(item => ({
      recordedAt: item.recordedAt,
      result: item.result,
      receiptStatus: item.receipt?.status,
      diagnostics: item.diagnostics,
      error: item.error?.message ?? item.error,
    }))
}

function summaryCard(label, value, tone) {
  return `<div class="summary-card ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
}

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --surface: #ffffff;
      --text: #17202a;
      --muted: #667085;
      --line: #d9dee7;
      --good: #177245;
      --good-bg: #eaf7ef;
      --bad: #b42318;
      --bad-bg: #fdeceb;
      --warn: #946200;
      --warn-bg: #fff4d6;
      --accent: #2259c7;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    header { margin-bottom: 24px; }
    h1 { margin: 0 0 6px; font-size: 32px; line-height: 1.15; }
    h2 { margin: 28px 0 12px; font-size: 20px; }
    h3 { margin: 18px 0 10px; font-size: 15px; }
    a { color: var(--accent); }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    pre { overflow: auto; margin: 0; padding: 12px; border-radius: 8px; background: #101828; color: #f2f4f7; }
    video { width: 100%; max-height: 520px; border: 1px solid var(--line); border-radius: 8px; background: #000; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    .eyebrow { margin: 0 0 8px; color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: .08em; }
    .muted { color: var(--muted); }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .summary-card, section, .test-card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
    section { padding: 16px; }
    .summary-card { padding: 14px 16px; }
    .summary-card span { display: block; color: var(--muted); font-size: 13px; }
    .summary-card strong { display: block; margin-top: 4px; font-size: 22px; }
    .summary-card.good { border-color: #9ad8b5; }
    .summary-card.bad { border-color: #f5a6a0; }
    .summary-card.warn { border-color: #f0cf75; }
    .metadata { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px 16px; margin: 0; }
    .metadata.compact { grid-template-columns: 1fr; }
    .metadata div { min-width: 0; }
    .metadata dt { color: var(--muted); font-size: 12px; }
    .metadata dd { margin: 2px 0 0; overflow-wrap: anywhere; }
    .pills { display: flex; flex-wrap: wrap; gap: 8px; }
    .pills span, .status { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .pills span { background: #eef2ff; color: #273e8a; }
    .pills .warn { background: var(--warn-bg); color: var(--warn); }
    .test-list { display: grid; gap: 12px; }
    .test-card { overflow: hidden; }
    .test-card summary { display: grid; grid-template-columns: auto minmax(220px, 1fr) minmax(180px, 1.2fr); gap: 12px; align-items: center; padding: 14px 16px; cursor: pointer; }
    .test-card.passed { border-color: #9ad8b5; }
    .test-card.failed { border-color: #f5a6a0; }
    .test-title { font-weight: 700; overflow-wrap: anywhere; }
    .test-meta { color: var(--muted); overflow-wrap: anywhere; }
    .status.passed { background: var(--good-bg); color: var(--good); }
    .status.failed { background: var(--bad-bg); color: var(--bad); }
    .test-body { border-top: 1px solid var(--line); padding: 16px; display: grid; gap: 16px; }
    .scenario-grid { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(320px, 1.2fr); gap: 16px; }
    .error { border-color: #f5a6a0; background: #fffafa; }
    .capture { border: 1px solid var(--line); border-radius: 8px; margin-top: 10px; padding: 10px; }
    .capture summary { cursor: pointer; font-weight: 600; }
    .links, .hash-list { margin: 0; padding-left: 20px; }
    .hash-list li { margin: 4px 0; overflow-wrap: anywhere; }
    @media (max-width: 760px) {
      main { width: min(100vw - 20px, 1180px); padding-top: 18px; }
      .test-card summary, .scenario-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>
`
}

function artifactHref(fromDir, rootRelativePath) {
  const absolute = path.resolve(ROOT_DIR, rootRelativePath)
  return pathToHref(path.relative(fromDir, absolute))
}

function pathToHref(value) {
  return normalizeWebPath(value || '.')
    .split('/')
    .map(part => (part === '..' || part === '.') ? part : encodeURIComponent(part))
    .join('/')
}

function normalizeWebPath(value) {
  return String(value).split(path.sep).join('/')
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

function escapeAttr(value) {
  return escapeHtml(value)
}

function formatDuration(startedAt, finishedAt) {
  const started = Date.parse(startedAt)
  const finished = Date.parse(finishedAt)
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return ''
  return `${finished - started} ms`
}

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}
