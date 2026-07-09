import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_SAMPLE_LIMIT = 25
const DEFAULT_CHAIN_ID = 1
const DEFAULT_GEO_COUNTRY = 'GB'
const DEFAULT_WORK_DIR = path.join('/tmp', 'euler-lite-public-endpoint-parity', sanitizeFilePart(ROOT_DIR))
const UNKNOWN_ADDRESS = '0x000000000000000000000000000000000000dEaD'

const args = parseArgs(process.argv.slice(2))

if (args.flags.help || args.flags.h) {
  printHelp()
  process.exit(0)
}

void main().catch((error) => {
  console.error('[public-endpoint-parity] ' + (error?.stack || error?.message || error))
  process.exit(1)
})

async function main() {
  const envFiles = await loadLocalEnvFiles()
  const config = buildConfig()
  const run = {
    runId: config.runId,
    generatedAt: new Date().toISOString(),
    envFiles,
    baseline: await resolveApp('baseline', config),
    candidate: await resolveApp('candidate', config),
  }
  const state = { apps: [] }

  const shutdown = async () => {
    await Promise.all(state.apps.map(app => stopServer(app.serverProcess)))
  }

  process.once('SIGINT', () => {
    void shutdown().then(() => process.exit(130))
  })
  process.once('SIGTERM', () => {
    void shutdown().then(() => process.exit(143))
  })

  try {
    await fs.mkdir(config.outputDir, { recursive: true })
    await writeJson(path.join(config.outputDir, 'run-config.json'), {
      ...run,
      outputDir: config.outputDir,
      chainId: config.chainId,
      geoCountry: config.geoCountry,
      sampleLimit: config.sampleLimit,
    })

    state.apps = await Promise.all([
      startOrAttach(run.baseline, config),
      startOrAttach(run.candidate, config),
    ])
    const [baseline, candidate] = state.apps

    const results = []
    const baseIsKnown = await compareEndpoint({
      id: 'is-known-list',
      pathName: `/api/public/is-known?chainId=${config.chainId}`,
      baseline,
      candidate,
      config,
      expectedStatus: 200,
      compareHeaders: ['cache-control'],
    })
    results.push(baseIsKnown)

    const metadataList = await compareEndpoint({
      id: 'metadata-list',
      pathName: `/api/public/metadata?chainId=${config.chainId}`,
      baseline,
      candidate,
      config,
      expectedStatus: 200,
      compareHeaders: ['cache-control'],
    })
    results.push(metadataList)

    const knownSample = sampleAddresses(Object.keys(asObject(baseIsKnown.baseline.body)), config.sampleLimit)
    const metadataAddresses = sampleAddresses(Object.keys(asObject(metadataList.baseline.body)), config.sampleLimit)
    const lookupAddresses = sampleAddresses([...new Set([...knownSample, ...metadataAddresses, UNKNOWN_ADDRESS])], config.sampleLimit + 1)
    if (lookupAddresses.length > 0) {
      results.push(await compareEndpoint({
        id: 'is-known-lookup',
        pathName: `/api/public/is-known?chainId=${config.chainId}&addresses=${lookupAddresses.join(',')}`,
        baseline,
        candidate,
        config,
        expectedStatus: 200,
        compareHeaders: ['cache-control'],
      }))
      results.push(await compareEndpoint({
        id: 'metadata-lookup',
        pathName: `/api/public/metadata?chainId=${config.chainId}&addresses=${lookupAddresses.join(',')}`,
        baseline,
        candidate,
        config,
        expectedStatus: 200,
        compareHeaders: ['cache-control'],
      }))
    }

    const productId = firstProductId(metadataList.baseline.body)
    if (productId) {
      results.push(await compareEndpoint({
        id: 'metadata-product-list',
        pathName: `/api/public/metadata?chainId=${config.chainId}&productId=${encodeURIComponent(productId)}`,
        baseline,
        candidate,
        config,
        expectedStatus: 200,
        compareHeaders: ['cache-control'],
      }))

      const productAddresses = sampleAddresses(
        Object.entries(asObject(metadataList.baseline.body))
          .filter(([, value]) => value?.productId === productId)
          .map(([address]) => address),
        config.sampleLimit,
      )
      if (productAddresses.length > 0) {
        results.push(await compareEndpoint({
          id: 'metadata-product-lookup',
          pathName: `/api/public/metadata?chainId=${config.chainId}&productId=${encodeURIComponent(productId)}&addresses=${productAddresses.join(',')}`,
          baseline,
          candidate,
          config,
          expectedStatus: 200,
          compareHeaders: ['cache-control'],
        }))
      }
    }

    results.push(await compareEndpoint({
      id: 'is-known-invalid-chain',
      pathName: '/api/public/is-known?chainId=0',
      baseline,
      candidate,
      config,
      expectedStatus: 400,
      compareBody: false,
    }))
    results.push(await compareEndpoint({
      id: 'metadata-invalid-address',
      pathName: `/api/public/metadata?chainId=${config.chainId}&addresses=not-an-address`,
      baseline,
      candidate,
      config,
      expectedStatus: 400,
      compareBody: false,
    }))

    const diff = buildRunDiff(results)
    await writeJson(path.join(config.outputDir, 'baseline.json'), {
      app: baseline,
      endpoints: Object.fromEntries(results.map(result => [result.id, result.baseline])),
    })
    await writeJson(path.join(config.outputDir, 'candidate.json'), {
      app: candidate,
      endpoints: Object.fromEntries(results.map(result => [result.id, result.candidate])),
    })
    await writeJson(path.join(config.outputDir, 'diff.json'), diff)
    await fs.mkdir(path.join(ROOT_DIR, 'artifacts/public-endpoint-parity'), { recursive: true })
    await writeJson(path.join(ROOT_DIR, 'artifacts/public-endpoint-parity/latest-run.json'), {
      runId: config.runId,
      outputDir: config.outputDir,
      diff: path.join(config.outputDir, 'diff.json'),
    })

    printSummary(diff, config)
    if (diff.summary.failedEndpoints > 0 && !config.noFail) process.exitCode = 1
  }
  finally {
    await shutdown()
  }
}

function buildConfig() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  return {
    runId,
    outputDir: path.resolve(valueOf('output-dir') || process.env.PUBLIC_ENDPOINT_PARITY_OUTPUT_DIR || path.join(ROOT_DIR, 'artifacts/public-endpoint-parity', runId)),
    host: valueOf('host') || process.env.PUBLIC_ENDPOINT_PARITY_HOST || DEFAULT_HOST,
    baselinePort: Number(valueOf('baseline-port') || process.env.PUBLIC_ENDPOINT_PARITY_BASELINE_PORT || 3300),
    candidatePort: Number(valueOf('candidate-port') || process.env.PUBLIC_ENDPOINT_PARITY_CANDIDATE_PORT || 3400),
    readyTimeoutMs: Number(valueOf('ready-timeout-ms') || process.env.PUBLIC_ENDPOINT_PARITY_READY_TIMEOUT_MS || DEFAULT_READY_TIMEOUT_MS),
    requestTimeoutMs: Number(valueOf('request-timeout-ms') || process.env.PUBLIC_ENDPOINT_PARITY_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS),
    chainId: Number(valueOf('chain-id') || process.env.PUBLIC_ENDPOINT_PARITY_CHAIN_ID || DEFAULT_CHAIN_ID),
    geoCountry: String(valueOf('geo-country') || process.env.PUBLIC_ENDPOINT_PARITY_GEO_COUNTRY || process.env.DEV_GEO_COUNTRY || DEFAULT_GEO_COUNTRY).toUpperCase(),
    sampleLimit: Number(valueOf('sample-limit') || process.env.PUBLIC_ENDPOINT_PARITY_SAMPLE_LIMIT || DEFAULT_SAMPLE_LIMIT),
    skipBuild: Boolean(args.flags.skipBuild || args.flags['skip-build'] || process.env.PUBLIC_ENDPOINT_PARITY_SKIP_BUILD === '1'),
    skipInstall: Boolean(args.flags.skipInstall || args.flags['skip-install'] || process.env.PUBLIC_ENDPOINT_PARITY_SKIP_INSTALL === '1'),
    noFail: Boolean(args.flags.noFail || args.flags['no-fail']),
    workDir: path.resolve(valueOf('work-dir') || process.env.PUBLIC_ENDPOINT_PARITY_WORK_DIR || DEFAULT_WORK_DIR),
  }
}

async function resolveApp(name, config) {
  const upper = name.toUpperCase()
  const url = valueOf(`${name}-url`) || process.env[`PUBLIC_ENDPOINT_PARITY_${upper}_URL`]
  if (url) {
    return {
      name,
      mode: 'url',
      url,
      baseUrl: originOf(url),
    }
  }

  let dir = valueOf(`${name}-dir`) || process.env[`PUBLIC_ENDPOINT_PARITY_${upper}_DIR`]
  if (!dir && name === 'baseline') dir = '/Users/dariusz/Euler/euler-lite'
  if (!dir && name === 'candidate') dir = ROOT_DIR
  if (!dir) throw new Error(`Missing ${name} URL or directory.`)

  const resolvedDir = path.resolve(dir)
  await ensureDependencies(resolvedDir, config)
  await ensureProductionBuild(resolvedDir, config)
  return {
    name,
    mode: 'dir',
    dir: resolvedDir,
  }
}

async function ensureDependencies(dir, config) {
  if (existsSync(path.join(dir, 'node_modules/.bin/nuxt'))) return
  if (config.skipInstall) {
    throw new Error('Missing node_modules in ' + dir + '. Run npm ci there or omit --skip-install.')
  }
  console.log('[public-endpoint-parity] Installing dependencies in ' + dir)
  await runCommand(npmCommand(), ['ci'], { cwd: dir })
}

async function ensureProductionBuild(dir, config) {
  if (config.skipBuild) {
    const outputServer = path.join(dir, '.output/server/index.mjs')
    if (!existsSync(outputServer)) {
      throw new Error('Missing production output in ' + dir + '. Run npm run build there or omit --skip-build.')
    }
    return
  }
  console.log('[public-endpoint-parity] Building production app in ' + dir)
  await fs.rm(path.join(dir, '.nuxt'), { recursive: true, force: true })
  await fs.rm(path.join(dir, '.output'), { recursive: true, force: true })
  await runCommand(npmCommand(), ['run', 'build'], { cwd: dir })
}

async function startOrAttach(app, config) {
  if (app.mode === 'url') {
    await waitForHttp(app.url, config.readyTimeoutMs)
    return {
      ...app,
      baseUrl: originOf(app.url),
      serverProcess: null,
    }
  }

  const startPort = app.name === 'baseline' ? config.baselinePort : config.candidatePort
  const port = await findFreePort(config.host, startPort)
  const baseUrl = `http://${config.host}:${port}`
  console.log(`[public-endpoint-parity] Starting ${app.name} app in ${app.dir} on ${baseUrl}`)
  const serverProcess = startProductionServer(app.dir, config.host, port)
  await waitForHttp(baseUrl, config.readyTimeoutMs, serverProcess)
  return {
    ...app,
    baseUrl,
    serverProcess,
  }
}

async function compareEndpoint({ id, pathName, baseline, candidate, config, expectedStatus, compareHeaders = [], compareBody = true }) {
  console.log(`[public-endpoint-parity] Fetching ${id}: ${pathName}`)
  const [baseResponse, candidateResponse] = await Promise.all([
    fetchEndpoint(baseline.baseUrl, pathName, config),
    fetchEndpoint(candidate.baseUrl, pathName, config),
  ])

  const differences = []
  if (baseResponse.status !== candidateResponse.status) {
    differences.push({
      kind: 'status',
      baseline: baseResponse.status,
      candidate: candidateResponse.status,
    })
  }
  if (expectedStatus !== undefined) {
    if (baseResponse.status !== expectedStatus) {
      differences.push({
        kind: 'expected-status',
        app: 'baseline',
        expected: expectedStatus,
        actual: baseResponse.status,
      })
    }
    if (candidateResponse.status !== expectedStatus) {
      differences.push({
        kind: 'expected-status',
        app: 'candidate',
        expected: expectedStatus,
        actual: candidateResponse.status,
      })
    }
  }

  for (const header of compareHeaders) {
    const baselineHeader = baseResponse.headers[header] ?? null
    const candidateHeader = candidateResponse.headers[header] ?? null
    if (baselineHeader !== candidateHeader) {
      differences.push({
        kind: 'header',
        header,
        baseline: baselineHeader,
        candidate: candidateHeader,
      })
    }
  }

  if (compareBody) {
    const bodyDiff = diffBodies(baseResponse.body, candidateResponse.body)
    if (bodyDiff) differences.push(bodyDiff)
  }

  return {
    id,
    path: pathName,
    ok: differences.length === 0,
    differences,
    baseline: baseResponse,
    candidate: candidateResponse,
  }
}

async function fetchEndpoint(baseUrl, pathName, config) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs)
  const url = baseUrl + pathName
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: requestHeaders(config),
    })
    const text = await response.text()
    return {
      url,
      status: response.status,
      statusText: response.statusText,
      headers: selectedHeaders(response.headers),
      body: normalizeResponseBody(parseBody(text), baseUrl),
    }
  }
  finally {
    clearTimeout(timeout)
  }
}

function requestHeaders(config) {
  const headers = { accept: 'application/json' }
  if (/^[A-Z]{2}$/.test(config.geoCountry)) headers['cf-ipcountry'] = config.geoCountry
  return headers
}

function diffBodies(baseline, candidate) {
  const normalizedBaseline = normalizeJson(baseline)
  const normalizedCandidate = normalizeJson(candidate)
  if (stableStringify(normalizedBaseline) === stableStringify(normalizedCandidate)) return null

  if (isPlainObject(normalizedBaseline) && isPlainObject(normalizedCandidate)) {
    const baselineKeys = Object.keys(normalizedBaseline).sort()
    const candidateKeys = Object.keys(normalizedCandidate).sort()
    const missing = baselineKeys.filter(key => !(key in normalizedCandidate))
    const extra = candidateKeys.filter(key => !(key in normalizedBaseline))
    const changed = baselineKeys
      .filter(key => key in normalizedCandidate)
      .filter(key => stableStringify(normalizedBaseline[key]) !== stableStringify(normalizedCandidate[key]))
    return {
      kind: 'body',
      summary: {
        baselineKeys: baselineKeys.length,
        candidateKeys: candidateKeys.length,
        missing: missing.length,
        extra: extra.length,
        changed: changed.length,
      },
      sample: {
        missing: missing.slice(0, 10),
        extra: extra.slice(0, 10),
        changed: changed.slice(0, 10).map(key => ({
          key,
          baseline: normalizedBaseline[key],
          candidate: normalizedCandidate[key],
        })),
      },
    }
  }

  return {
    kind: 'body',
    baseline: normalizedBaseline,
    candidate: normalizedCandidate,
  }
}

function buildRunDiff(results) {
  const endpoints = results.map(result => ({
    id: result.id,
    path: result.path,
    ok: result.ok,
    differences: result.differences,
  }))
  return {
    summary: {
      totalEndpoints: endpoints.length,
      passedEndpoints: endpoints.filter(result => result.ok).length,
      failedEndpoints: endpoints.filter(result => !result.ok).length,
    },
    endpoints,
  }
}

function selectedHeaders(headers) {
  return {
    'cache-control': headers.get('cache-control') ?? null,
    'content-type': headers.get('content-type') ?? null,
  }
}

function parseBody(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalizeJson(item)]),
    )
  }
  return value
}

function normalizeResponseBody(value, baseUrl) {
  if (
    isPlainObject(value)
    && typeof value.url === 'string'
    && value.url.startsWith(baseUrl)
    && typeof value.statusCode === 'number'
  ) {
    return {
      ...value,
      url: value.url.slice(baseUrl.length),
    }
  }
  return value
}

function stableStringify(value) {
  return JSON.stringify(normalizeJson(value))
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asObject(value) {
  return isPlainObject(value) ? value : {}
}

function sampleAddresses(addresses, limit) {
  return [...new Set(addresses)]
    .filter(address => /^0x[a-fA-F0-9]{40}$/.test(address))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .slice(0, limit)
}

function firstProductId(metadataBody) {
  return Object.values(asObject(metadataBody))
    .map(entry => entry?.productId)
    .find(value => typeof value === 'string' && value.length > 0) ?? null
}

async function loadLocalEnvFiles() {
  const requested = valueOf('env-file') || process.env.PUBLIC_ENDPOINT_PARITY_ENV_FILE
  const envFiles = requested
    ? requested.split(',').map(item => item.trim()).filter(Boolean)
    : ['.env']
  if (envFiles.includes('none')) return []

  const loaded = []
  for (const envFile of envFiles) {
    const filePath = path.resolve(ROOT_DIR, envFile)
    let content
    try {
      content = await fs.readFile(filePath, 'utf8')
    }
    catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }

    const entries = parseEnvFile(content)
    let applied = 0
    let aliases = 0
    for (const [key, value] of Object.entries(entries)) {
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue
      process.env[key] = value
      applied += 1
    }
    aliases += applyLegacyRpcAliases(entries)
    loaded.push({ file: filePath, applied, aliases })
  }
  if (loaded.length) {
    console.log('[public-endpoint-parity] Loaded env files: ' + loaded.map(item => `${item.file} (${item.applied} vars, ${item.aliases} aliases)`).join(', '))
  }
  return loaded
}

function applyLegacyRpcAliases(entries) {
  let aliases = 0
  for (const [key, value] of Object.entries(entries)) {
    const match = key.match(/^RPC_URL_HTTP_(\d+)$/)
    if (!match) continue
    const aliasKey = `RPC_URL_${match[1]}`
    if (Object.prototype.hasOwnProperty.call(process.env, aliasKey)) continue
    process.env[aliasKey] = value
    aliases += 1
  }
  return aliases
}

function parseEnvFile(content) {
  const values = {}
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    values[match[1]] = parseEnvValue(match[2])
  }
  return values
}

function parseEnvValue(rawValue) {
  let value = rawValue.trim()
  const hashIndex = value.search(/\s+#/)
  if (hashIndex >= 0) value = value.slice(0, hashIndex).trim()
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    value = value.slice(1, -1)
  }
  return value.replace(/\\n/g, '\n')
}

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }
    const trimmed = arg.replace(/^--?/, '')
    const [rawKey, inlineValue] = trimmed.split('=', 2)
    const next = argv[index + 1]
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue
    }
    else if (next && !next.startsWith('-')) {
      flags[rawKey] = next
      index += 1
    }
    else {
      flags[rawKey] = true
    }
  }
  return { flags, positionals }
}

function valueOf(name) {
  const value = args.flags[name]
  return typeof value === 'string' ? value : null
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function startProductionServer(dir, host, port) {
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: dir,
    env: {
      ...process.env,
      BROWSER: 'none',
      NODE_ENV: 'production',
      NITRO_HOST: host,
      NITRO_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => process.stdout.write(`[${path.basename(dir)}] ${chunk}`))
  child.stderr.on('data', chunk => process.stderr.write(`[${path.basename(dir)}] ${chunk}`))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.killed) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
      resolve()
    }, 4_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function waitForHttp(url, timeoutMs, serverProcess) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error('Production server exited before becoming ready.')
    }
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (response.status < 500) return
      lastError = new Error('HTTP ' + response.status)
    }
    catch (error) {
      lastError = error
    }
    await sleep(500)
  }
  throw new Error('Timed out waiting for ' + url + '. Last error: ' + (lastError?.message || lastError))
}

async function findFreePort(host, startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await isPortFree(host, port)) return port
  }
  throw new Error('No free port found between ' + startPort + ' and ' + (startPort + 99))
}

function isPortFree(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

async function runCommand(command, commandArgs, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      ...options,
      stdio: 'inherit',
    })
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(command + ' exited with code ' + code))
    })
  })
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function originOf(value) {
  return new URL(value).origin
}

function sanitizeFilePart(value) {
  return String(value || 'item').replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'item'
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function printSummary(diff, config) {
  console.log('[public-endpoint-parity] Output: ' + config.outputDir)
  console.log('[public-endpoint-parity] Passed ' + diff.summary.passedEndpoints + '/' + diff.summary.totalEndpoints + ' endpoints')
  for (const endpoint of diff.endpoints) {
    const status = endpoint.ok ? 'ok' : 'diff'
    console.log(`[public-endpoint-parity] ${status} ${endpoint.id}`)
    for (const difference of endpoint.differences) {
      console.log('  - ' + JSON.stringify(difference))
    }
  }
}

function printHelp() {
  console.log(`Usage:
  npm run parity:public-endpoints -- --baseline-dir ../euler-lite --candidate-dir .
  npm run parity:public-endpoints -- --baseline-url http://127.0.0.1:3300 --candidate-url http://127.0.0.1:3400

Options:
  --chain-id <id>          Chain to compare. Default: ${DEFAULT_CHAIN_ID}
  --geo-country <code>     CF-IPCountry header for local API access. Default: ${DEFAULT_GEO_COUNTRY}
  --sample-limit <n>       Lookup sample size. Default: ${DEFAULT_SAMPLE_LIMIT}
  --skip-build             Reuse existing .output builds
  --skip-install           Do not install missing dependencies
  --no-fail                Write diff artifacts but exit 0
  --output-dir <path>      Artifact directory
`)
}
