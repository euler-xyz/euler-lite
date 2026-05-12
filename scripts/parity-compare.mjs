import { spawn, execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const execFile = promisify(execFileCallback)
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SCENARIOS = path.join(ROOT_DIR, 'tests/parity/scenarios.json')
const DEFAULT_BASELINE_BRANCH = 'feature/parity-data-tags'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_READY_TIMEOUT_MS = 120_000

const args = parseArgs(process.argv.slice(2))

if (args.flags.help || args.flags.h) {
  printHelp()
  process.exit(0)
}

void main().catch((error) => {
  console.error('[parity-compare] ' + (error?.stack || error?.message || error))
  process.exit(1)
})

async function main() {
  const envFiles = await loadLocalEnvFiles()
  const config = await buildConfig()
  const run = {
    runId: config.runId,
    generatedAt: new Date().toISOString(),
    scenarioFile: config.scenarioFile,
    envFiles,
    baseline: await resolveApp('baseline', config),
    candidate: await resolveApp('candidate', config),
  }

  const state = {
    browser: null,
    apps: [],
  }

  const shutdown = async () => {
    if (state.browser?.isConnected()) {
      await state.browser.close().catch(() => {})
    }

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
      maxFollowItems: config.maxFollowItems,
      numericTolerance: config.numericTolerance,
      rateLimitRetries: config.rateLimitRetries,
      navigationRetries: config.navigationRetries,
      navigationTimeoutMs: config.navigationTimeoutMs,
      scenarioFilter: config.scenarioFilter,
    })

    state.browser = await launchBrowser(config.headless)
    const scenarios = await loadScenarios(config)
    let baselineSnapshots = []
    let candidateSnapshots = []
    let pageDiffs = []

    if (config.sequential) {
      const result = await runScenariosSequentialByPage({
        scenarios,
        config,
        browser: state.browser,
        baseline: run.baseline,
        candidate: run.candidate,
        state,
      })
      baselineSnapshots = result.baseline
      candidateSnapshots = result.candidate
      pageDiffs = result.diffs
    }
    else {
      state.apps = await Promise.all([
        startOrAttach(run.baseline, config),
        startOrAttach(run.candidate, config),
      ])

      for (const scenario of scenarios) {
        console.log('[parity-compare] Running ' + scenario.id)
        const result = await runScenario({
          scenario,
          config,
          browser: state.browser,
          baseline: state.apps[0],
          candidate: state.apps[1],
        })

        baselineSnapshots.push(...result.baseline)
        candidateSnapshots.push(...result.candidate)
        pageDiffs.push(...result.diffs)
      }
    }

    const diff = buildDiff({
      run,
      config,
      outputDir: config.outputDir,
      baselineSnapshots,
      candidateSnapshots,
      pageDiffs,
    })

    await writeJson(path.join(config.outputDir, 'baseline.json'), {
      app: run.baseline,
      snapshots: baselineSnapshots,
    })
    await writeJson(path.join(config.outputDir, 'candidate.json'), {
      app: run.candidate,
      snapshots: candidateSnapshots,
    })
    await writeJson(path.join(config.outputDir, 'diff.json'), diff)
    await fs.writeFile(path.join(config.outputDir, 'report.html'), renderHtmlReport(diff), 'utf8')
    await fs.writeFile(path.join(ROOT_DIR, 'artifacts/parity/latest-run.json'), JSON.stringify({
      runId: config.runId,
      outputDir: config.outputDir,
      diff: path.join(config.outputDir, 'diff.json'),
      report: path.join(config.outputDir, 'report.html'),
    }, null, 2) + '\n')

    printSummary(diff)

    if (diff.summary.failedPages > 0 && !config.noFail) {
      process.exitCode = 1
    }
  }
  finally {
    await shutdown()
  }
}

async function buildConfig() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const outputDir = path.resolve(
    valueOf('output-dir')
    || process.env.PARITY_OUTPUT_DIR
    || path.join(ROOT_DIR, 'artifacts/parity', runId),
  )

  return {
    runId,
    outputDir,
    scenarioFile: path.resolve(valueOf('scenarios') || process.env.PARITY_SCENARIOS || DEFAULT_SCENARIOS),
    scenarioFilter: valuesOf('scenario'),
    host: valueOf('host') || process.env.PARITY_HOST || DEFAULT_HOST,
    baselinePort: Number(valueOf('baseline-port') || process.env.PARITY_BASELINE_PORT || 3100),
    candidatePort: Number(valueOf('candidate-port') || process.env.PARITY_CANDIDATE_PORT || 3200),
    headless: !args.flags.headed && process.env.PARITY_HEADED !== '1',
    noFail: Boolean(args.flags.noFail || args.flags['no-fail']),
    skipInstall: Boolean(args.flags.skipInstall || args.flags['skip-install'] || process.env.PARITY_SKIP_INSTALL === '1'),
    maxFollowItems: numberOrNull(valueOf('max-follow-items') || process.env.PARITY_MAX_FOLLOW_ITEMS),
    readyTimeoutMs: Number(valueOf('ready-timeout-ms') || process.env.PARITY_READY_TIMEOUT_MS || DEFAULT_READY_TIMEOUT_MS),
    waitTimeoutMs: Number(valueOf('wait-timeout-ms') || process.env.PARITY_WAIT_TIMEOUT_MS || 45_000),
    navigationTimeoutMs: Number(valueOf('navigation-timeout-ms') || process.env.PARITY_NAVIGATION_TIMEOUT_MS || 45_000),
    navigationRetries: Number(valueOf('navigation-retries') || process.env.PARITY_NAVIGATION_RETRIES || 3),
    numericTolerance: parseNumericTolerance(valueOf('numeric-tolerance') || process.env.PARITY_NUMERIC_TOLERANCE || '1%'),
    rateLimitRetries: Number(valueOf('rate-limit-retries') || process.env.PARITY_RATE_LIMIT_RETRIES || 3),
    sequential: Boolean(args.flags.sequential || process.env.PARITY_SEQUENTIAL === '1'),
  }
}

async function loadLocalEnvFiles() {
  const requested = valueOf('env-file') || process.env.PARITY_ENV_FILE
  const envFiles = requested
    ? requested.split(',').map(item => item.trim()).filter(Boolean)
    : ['.env']

  if (envFiles.includes('none')) return []

  const loaded = []
  for (const envFile of envFiles) {
    const filePath = path.resolve(ROOT_DIR, envFile)
    let content = ''

    try {
      content = await fs.readFile(filePath, 'utf8')
    }
    catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }

    const entries = parseEnvFile(content)
    let applied = 0
    for (const [key, value] of Object.entries(entries)) {
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue
      process.env[key] = value
      applied += 1
    }

    loaded.push({ file: filePath, applied })
  }

  if (loaded.length) {
    console.log('[parity-compare] Loaded env files: ' + loaded.map(item => item.file + ' (' + item.applied + ' vars)').join(', '))
  }

  return loaded
}

function parseEnvFile(content) {
  const values = {}

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue

    const [, key, rawValue] = match
    values[key] = parseEnvValue(rawValue)
  }

  return values
}

function parseEnvValue(rawValue) {
  const value = String(rawValue ?? '').trim()
  if (!value) return ''

  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replaceAll('\\n', '\n')
      .replaceAll('\\r', '\r')
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\')
  }

  if (value.startsWith('\'') && value.endsWith('\'')) {
    return value.slice(1, -1)
  }

  return value.replace(/\s+#.*$/, '').trim()
}

async function resolveApp(name, config) {
  const upper = name.toUpperCase()
  const url = valueOf(name + '-url') || process.env['PARITY_' + upper + '_URL']

  if (url) {
    return {
      name,
      mode: 'url',
      url,
      baseUrl: originOf(url),
    }
  }

  let dir = valueOf(name + '-dir') || process.env['PARITY_' + upper + '_DIR']
  let branch = null

  if (!dir && name === 'baseline') {
    branch = valueOf('baseline-branch') || process.env.PARITY_BASELINE_BRANCH || DEFAULT_BASELINE_BRANCH
    dir = await ensureBranchWorktree(branch)
  }

  if (!dir && name === 'candidate') {
    dir = ROOT_DIR
  }

  if (!dir) {
    throw new Error('Missing ' + name + ' URL or directory.')
  }

  const resolvedDir = path.resolve(dir)
  await ensureDependencies(resolvedDir, config)

  return {
    name,
    mode: 'dir',
    dir: resolvedDir,
    branch,
  }
}

async function ensureBranchWorktree(branch) {
  const worktreeDir = path.join(ROOT_DIR, '.parity/worktrees', sanitizeFilePart(branch))
  await fs.mkdir(path.dirname(worktreeDir), { recursive: true })

  if (!existsSync(worktreeDir)) {
    console.log('[parity-compare] Creating baseline worktree for ' + branch)
    await execFile('git', ['worktree', 'add', '--detach', worktreeDir, branch], { cwd: ROOT_DIR })
    return worktreeDir
  }

  const status = await execFile('git', ['status', '--porcelain'], { cwd: worktreeDir })
  if (status.stdout.trim()) {
    throw new Error('Baseline worktree is dirty: ' + worktreeDir)
  }

  await execFile('git', ['checkout', '--detach', branch], { cwd: worktreeDir })
  return worktreeDir
}

async function ensureDependencies(dir, config) {
  if (existsSync(path.join(dir, 'node_modules/.bin/nuxt'))) return

  if (config.skipInstall) {
    throw new Error('Missing node_modules in ' + dir + '. Run npm ci there or omit --skip-install.')
  }

  console.log('[parity-compare] Installing dependencies in ' + dir)
  await runCommand('npm', ['ci'], { cwd: dir })
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
  const baseUrl = 'http://' + config.host + ':' + port

  console.log('[parity-compare] Starting ' + app.name + ' app in ' + app.dir + ' on ' + baseUrl)
  const serverProcess = startDevServer(app.dir, config.host, port)
  await waitForHttp(baseUrl, config.readyTimeoutMs, serverProcess)

  return {
    ...app,
    baseUrl,
    serverProcess,
  }
}

async function runScenario({ scenario, config, browser, baseline, candidate }) {
  const baselineContext = await createContext(browser, scenario)
  const candidateContext = await createContext(browser, scenario)

  const baselineSnapshots = []
  const candidateSnapshots = []
  const diffs = []

  try {
    const basePageResult = await openAndCapture({
      app: baseline,
      context: baselineContext,
      scenario,
      pageId: scenario.id,
      pathName: scenario.path,
      waitFor: scenario.waitFor,
      waitTimeoutMs: config.waitTimeoutMs,
      keepPage: true,
    })
    const candidatePageResult = await openAndCapture({
      app: candidate,
      context: candidateContext,
      scenario,
      pageId: scenario.id,
      pathName: scenario.path,
      waitFor: scenario.waitFor,
      waitTimeoutMs: config.waitTimeoutMs,
      keepPage: true,
    })

    baselineSnapshots.push(basePageResult.snapshot)
    candidateSnapshots.push(candidatePageResult.snapshot)
    diffs.push(compareSnapshots(basePageResult.snapshot, candidatePageResult.snapshot, config))

    for (const follow of scenario.follow || []) {
      const links = await extractFollowLinks(basePageResult.page, follow.selector)
      const limited = limitFollowLinks(links, follow, config)

      console.log('[parity-compare] ' + scenario.id + ' follow ' + follow.id + ': ' + limited.length + ' pages')

      for (let index = 0; index < limited.length; index += 1) {
        const link = limited[index]
        const detailPath = pathFromUrl(link.href)
        const pageId = scenario.id + '/' + follow.id + '/' + String(index + 1).padStart(4, '0') + '-' + sanitizeFilePart(link.key || 'item')
        const label = (follow.label || follow.id) + ' ' + (link.key || index + 1)

        const baseDetail = await openAndCapture({
          app: baseline,
          context: baselineContext,
          scenario: { ...scenario, label },
          pageId,
          pathName: detailPath,
          waitFor: follow.waitFor || scenario.waitFor,
          waitTimeoutMs: config.waitTimeoutMs,
        })
        const candidateDetail = await openAndCapture({
          app: candidate,
          context: candidateContext,
          scenario: { ...scenario, label },
          pageId,
          pathName: detailPath,
          waitFor: follow.waitFor || scenario.waitFor,
          waitTimeoutMs: config.waitTimeoutMs,
        })

        baselineSnapshots.push(baseDetail.snapshot)
        candidateSnapshots.push(candidateDetail.snapshot)
        diffs.push(compareSnapshots(baseDetail.snapshot, candidateDetail.snapshot, config))
      }
    }

    await basePageResult.page.close()
    await candidatePageResult.page.close()
  }
  finally {
    await baselineContext.close()
    await candidateContext.close()
  }

  return {
    baseline: baselineSnapshots,
    candidate: candidateSnapshots,
    diffs,
  }
}

async function runScenariosSequentialByPage({ scenarios, config, browser, baseline, candidate, state }) {
  const baselineSnapshots = []
  const candidateSnapshots = []
  const diffs = []
  const baselineApp = await startOrAttach(baseline, config)
  const candidateApp = await startOrAttach(candidate, config)
  state.apps = [baselineApp, candidateApp]

  try {
    for (const scenario of scenarios) {
      console.log('[parity-compare] Running ' + scenario.id + ' page-by-page')
      const mainPlan = {
        pageId: scenario.id,
        scenario,
        pathName: scenario.path,
        waitFor: scenario.waitFor,
      }
      const baselineResult = await capturePlanAndFollowPlans({
        appDefinition: baseline,
        app: baselineApp,
        config,
        browser,
        plan: mainPlan,
        follows: scenario.follow || [],
        state,
      })
      const candidateDetail = await capturePlanSequential({
        appDefinition: candidate,
        app: candidateApp,
        config,
        browser,
        plan: mainPlan,
        state,
      })

      baselineSnapshots.push(baselineResult.snapshot)
      candidateSnapshots.push(candidateDetail)
      diffs.push(compareSnapshots(baselineResult.snapshot, candidateDetail, config))

      for (let index = 0; index < baselineResult.modalPlans.length; index += 1) {
        const baselineModal = baselineResult.modalPlans[index]
        const candidateModal = await captureModalPlanSequential({
          appDefinition: candidate,
          app: candidateApp,
          config,
          browser,
          plan: baselineModal,
          state,
        })

        baselineSnapshots.push(baselineModal.snapshot)
        candidateSnapshots.push(candidateModal)
        diffs.push(compareSnapshots(baselineModal.snapshot, candidateModal, config))
      }

      for (const followPlan of baselineResult.followPlans) {
        const baselineDetail = await capturePlanWithModalsSequential({
          appDefinition: baseline,
          app: baselineApp,
          config,
          browser,
          plan: followPlan,
          state,
        })
        const candidateDetail = await capturePlanSequential({
          appDefinition: candidate,
          app: candidateApp,
          config,
          browser,
          plan: followPlan,
          state,
        })

        baselineSnapshots.push(baselineDetail.snapshot)
        candidateSnapshots.push(candidateDetail)
        diffs.push(compareSnapshots(baselineDetail.snapshot, candidateDetail, config))

        for (const baselineModal of baselineDetail.modalPlans) {
          const candidateModal = await captureModalPlanSequential({
            appDefinition: candidate,
            app: candidateApp,
            config,
            browser,
            plan: baselineModal,
            state,
          })

          baselineSnapshots.push(baselineModal.snapshot)
          candidateSnapshots.push(candidateModal)
          diffs.push(compareSnapshots(baselineModal.snapshot, candidateModal, config))
        }
      }
    }
  }
  finally {
    await Promise.all([
      stopServer(baselineApp.serverProcess),
      stopServer(candidateApp.serverProcess),
    ])
    state.apps = []
  }

  return {
    baseline: baselineSnapshots,
    candidate: candidateSnapshots,
    diffs,
  }
}

async function capturePlanAndFollowPlans({ appDefinition, app: startedApp = null, config, browser, plan, follows, state }) {
  const ownsApp = !startedApp
  const app = startedApp || await startOrAttach(appDefinition, config)
  if (ownsApp) state.apps = [app]
  const context = await createContext(browser, plan.scenario)
  let pageResult = null

  try {
    console.log('[parity-compare] Capturing ' + app.name + ' ' + plan.pageId)
    pageResult = await openAndCapture({
      app,
      context,
      scenario: plan.scenario,
      pageId: plan.pageId,
      pathName: plan.pathName,
      waitFor: plan.waitFor,
      waitTimeoutMs: config.waitTimeoutMs,
      keepPage: true,
    })

    const followPlans = []
    for (const follow of follows) {
      const links = await extractFollowLinks(pageResult.page, follow.selector)
      const limited = limitFollowLinks(links, follow, config)

      console.log('[parity-compare] ' + plan.pageId + ' follow ' + follow.id + ': ' + limited.length + ' pages')

      for (let index = 0; index < limited.length; index += 1) {
        const link = limited[index]
        const detailPath = pathFromUrl(link.href)
        const pageId = plan.pageId + '/' + follow.id + '/' + String(index + 1).padStart(4, '0') + '-' + sanitizeFilePart(link.key || 'item')
        const label = (follow.label || follow.id) + ' ' + (link.key || index + 1)

        followPlans.push({
          pageId,
          scenario: { ...plan.scenario, label },
          pathName: detailPath,
          waitFor: follow.waitFor || plan.waitFor,
        })
      }
    }

    const modalPlans = await captureModalPlansOnPage({
      page: pageResult.page,
      scenario: plan.scenario,
      pageId: plan.pageId,
      pathName: plan.pathName,
      appName: app.name,
      waitTimeoutMs: config.waitTimeoutMs,
    })

    return {
      snapshot: pageResult.snapshot,
      followPlans,
      modalPlans,
    }
  }
  finally {
    await pageResult?.page?.close().catch(() => {})
    await context.close()
    if (ownsApp) {
      await stopServer(app.serverProcess)
      state.apps = []
    }
  }
}

async function capturePlanWithModalsSequential({ appDefinition, app: startedApp = null, config, browser, plan, state }) {
  const ownsApp = !startedApp
  const app = startedApp || await startOrAttach(appDefinition, config)
  if (ownsApp) state.apps = [app]
  const context = await createContext(browser, plan.scenario)
  let pageResult = null

  try {
    console.log('[parity-compare] Capturing ' + app.name + ' ' + plan.pageId)
    pageResult = await openAndCapture({
      app,
      context,
      scenario: plan.scenario,
      pageId: plan.pageId,
      pathName: plan.pathName,
      waitFor: plan.waitFor,
      waitTimeoutMs: config.waitTimeoutMs,
      keepPage: true,
    })

    return {
      snapshot: pageResult.snapshot,
      modalPlans: await captureModalPlansOnPage({
        page: pageResult.page,
        scenario: plan.scenario,
        pageId: plan.pageId,
        pathName: plan.pathName,
        appName: app.name,
        waitTimeoutMs: config.waitTimeoutMs,
      }),
    }
  }
  finally {
    await pageResult?.page?.close().catch(() => {})
    await context.close()
    if (ownsApp) {
      await stopServer(app.serverProcess)
      state.apps = []
    }
  }
}

async function capturePlanSequential({ appDefinition, app: startedApp = null, config, browser, plan, state }) {
  const ownsApp = !startedApp
  const app = startedApp || await startOrAttach(appDefinition, config)
  if (ownsApp) state.apps = [app]
  const context = await createContext(browser, plan.scenario)

  try {
    console.log('[parity-compare] Capturing ' + app.name + ' ' + plan.pageId)
    const result = await openAndCapture({
      app,
      context,
      scenario: plan.scenario,
      pageId: plan.pageId,
      pathName: plan.pathName,
      waitFor: plan.waitFor,
      waitTimeoutMs: config.waitTimeoutMs,
    })

    return result.snapshot
  }
  finally {
    await context.close()
    if (ownsApp) {
      await stopServer(app.serverProcess)
      state.apps = []
    }
  }
}

async function captureModalPlanSequential({ appDefinition, app: startedApp = null, config, browser, plan, state }) {
  const ownsApp = !startedApp
  const app = startedApp || await startOrAttach(appDefinition, config)
  if (ownsApp) state.apps = [app]
  const context = await createContext(browser, plan.scenario)
  let pageResult = null

  try {
    console.log('[parity-compare] Capturing ' + app.name + ' ' + plan.pageId)
    pageResult = await openAndCapture({
      app,
      context,
      scenario: plan.scenario,
      pageId: plan.parentPageId,
      pathName: plan.pathName,
      waitFor: plan.parentWaitFor,
      waitTimeoutMs: config.waitTimeoutMs,
      keepPage: true,
    })

    const snapshots = await captureModalPlansOnPage({
      page: pageResult.page,
      scenario: plan.scenario,
      pageId: plan.parentPageId,
      pathName: plan.pathName,
      appName: app.name,
      waitTimeoutMs: config.waitTimeoutMs,
      onlyModalId: plan.modalId,
    })
    return snapshots[0]?.snapshot || {
      ...pageResult.snapshot,
      pageId: plan.pageId,
      label: plan.label,
      captureError: 'Modal capture not found for ' + plan.modalId,
    }
  }
  finally {
    await pageResult?.page?.close().catch(() => {})
    await context.close()
    if (ownsApp) {
      await stopServer(app.serverProcess)
      state.apps = []
    }
  }
}

async function createContext(browser, scenario) {
  const viewport = scenario.viewport || scenario.defaults?.viewport || { width: 1440, height: 1000 }
  const localStorage = scenario.localStorage || scenario.defaults?.localStorage || {}
  const context = await browser.newContext({ viewport })

  await context.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      window.localStorage.setItem(key, String(value))
    }
  }, localStorage)

  return context
}

async function openAndCapture({ app, context, scenario, pageId, pathName, waitFor, waitTimeoutMs, keepPage = false }) {
  const page = await context.newPage()
  const url = new URL(pathName, app.baseUrl)
  const consoleMessages = []
  const rateLimitResponses = []

  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location(),
    })
  })

  page.on('response', (response) => {
    if (response.status() !== 429) return
    rateLimitResponses.push({
      url: response.url(),
      status: response.status(),
    })
  })

  let waitError = null
  let navigationError = null
  const navigationTimeoutMs = Number(scenario.navigationTimeoutMs || waitTimeoutMs || 45_000)
  const maxAttempts = Math.max(
    1,
    Number(scenario.rateLimitRetries ?? 0) || 1,
    Number(scenario.navigationRetries ?? 0) || 1,
  )

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    waitError = null
    navigationError = null
    rateLimitResponses.length = 0

    try {
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs })
    }
    catch (error) {
      navigationError = error.message
    }

    if (!navigationError) {
      try {
        await waitForSelectors(page, waitFor, waitTimeoutMs)
      }
      catch (error) {
        waitError = error.message
      }
    }

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(scenario.settleMs ?? scenario.defaults?.settleMs ?? 0)

    if ((navigationError || rateLimitResponses.length) && attempt < maxAttempts) {
      const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1))
      const reason = navigationError
        ? 'navigation failed: ' + navigationError.split('\n')[0]
        : 'HTTP 429 while capturing ' + pageId
      console.warn('[parity-compare] ' + reason + '; backing off ' + delay + 'ms before retry ' + (attempt + 1) + '/' + maxAttempts)
      await page.waitForTimeout(delay)
      continue
    }

    break
  }

  const missingSelectors = waitError && !navigationError
    ? await missingWaitSelectors(page, waitFor)
    : []

  let snapshot = null
  try {
    snapshot = await page.evaluate(scrapePage, {
      pageId,
      scenarioId: scenario.id,
      label: scenario.label || scenario.id,
      appName: app.name,
    })
  }
  catch (error) {
    snapshot = createFailedSnapshot({
      pageId,
      scenarioId: scenario.id,
      label: scenario.label || scenario.id,
      appName: app.name,
      url: page.url() || url.href,
      pathName,
      error: 'Scrape failed: ' + (error?.message || error),
    })
  }

  snapshot.requestedPath = pathName
  snapshot.url = url.href
  snapshot.path = url.pathname + url.search
  snapshot.captureError = navigationError
    ? 'Navigation failed after ' + maxAttempts + ' attempt(s): ' + navigationError
    : missingSelectors.length
      ? waitError + '\nMissing after final scrape: ' + missingSelectors.join(', ')
      : rateLimitResponses.length
        ? 'HTTP 429 responses observed: ' + rateLimitResponses.map(item => item.url).join(', ')
        : snapshot.captureError || null
  snapshot.console = consoleMessages
  snapshot.rateLimitResponses = rateLimitResponses

  if (keepPage) {
    return { page, snapshot }
  }

  await page.close()
  return { page: null, snapshot }
}

function createFailedSnapshot({ pageId, scenarioId, label, appName, url, pathName, error }) {
  return {
    pageId,
    scenarioId,
    label,
    appName,
    capturedAt: new Date().toISOString(),
    title: '',
    url,
    path: pathName,
    counts: {
      tagged: 0,
      dataPoints: 0,
      lists: 0,
    },
    lists: {},
    elements: [],
    captureError: error,
  }
}

async function waitForSelectors(page, selectors = [], timeout = 45_000) {
  for (const selector of selectors || []) {
    await page.waitForSelector(selector, { state: 'attached', timeout })
  }
}

async function missingWaitSelectors(page, selectors = []) {
  return page.evaluate((items) => {
    return (items || []).filter(selector => !document.querySelector(selector))
  }, selectors || [])
}

async function captureModalPlansOnPage({
  page,
  scenario,
  pageId,
  pathName,
  appName,
  waitTimeoutMs,
  onlyModalId = null,
}) {
  const modalCaptures = scenario.modals || []
  const snapshots = []

  for (const modal of modalCaptures) {
    const locator = page.locator(modal.selector)
    const count = await locator.count().catch(() => 0)
    const maxItems = Math.min(count, modal.maxItems ?? 1)
    if (maxItems > 0) {
      console.log('[parity-compare] ' + pageId + ' modal ' + modal.id + ': ' + maxItems + ' capture(s)')
    }

    for (let index = 0; index < maxItems; index += 1) {
      const modalId = modal.id + '-' + String(index + 1).padStart(2, '0')
      if (onlyModalId && modalId !== onlyModalId) continue

      const modalPageId = pageId + '/modal/' + sanitizeFilePart(modalId)
      const label = (modal.label || modal.id) + ' ' + (index + 1)
      let captureError = null

      try {
        await locator.nth(index).click({ timeout: waitTimeoutMs })
        await waitForSelectors(page, modal.waitFor || ['[data-id="data-point"]'], waitTimeoutMs)
        await page.waitForTimeout(modal.settleMs ?? scenario.settleMs ?? 0)
      }
      catch (error) {
        captureError = error.message
      }

      const snapshot = await page.evaluate(scrapePage, {
        pageId: modalPageId,
        scenarioId: scenario.id,
        label,
        appName,
      })
      snapshot.requestedPath = pathName
      snapshot.path = new URL(page.url()).pathname + new URL(page.url()).search
      snapshot.captureError = captureError
      snapshot.console = []

      snapshots.push({
        modalId,
        pageId: modalPageId,
        parentPageId: pageId,
        pathName,
        parentWaitFor: scenario.waitFor,
        scenario: { ...scenario, label },
        label,
        snapshot,
      })

      await closeModal(page)
    }
  }

  return snapshots
}

async function closeModal(page) {
  const closeButton = page.locator('[data-modal-close]').last()
  if (await closeButton.count().catch(() => 0)) {
    await closeButton.click({ timeout: 5_000 }).catch(() => {})
  }
  else {
    await page.keyboard.press('Escape').catch(() => {})
  }

  await page.waitForTimeout(250)
}

async function extractFollowLinks(page, selector) {
  return page.evaluate((itemSelector) => {
    const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim()
    const isVisible = (element) => {
      const style = window.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    return Array.from(document.querySelectorAll(itemSelector))
      .filter(isVisible)
      .map((element, index) => {
        const anchor = element.closest('a') || (element.tagName === 'A' ? element : null)
        return {
          index,
          key: element.getAttribute('data-key') || '',
          text: normalize(element.innerText || element.textContent || ''),
          href: anchor?.href || '',
        }
      })
      .filter(item => item.href)
  }, selector)
}

function limitFollowLinks(links, follow, config) {
  const max = config.maxFollowItems ?? follow.maxItems ?? null
  if (!max || max < 0) return links
  return links.slice(0, max)
}

function scrapePage(meta) {
  const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim()
  const dataAttrs = (element) => {
    const attrs = {}
    for (const attr of Array.from(element.attributes)) {
      if (attr.name.startsWith('data-') && !attr.name.startsWith('data-parity-')) {
        attrs[attr.name.slice(5)] = attr.value
      }
    }
    return attrs
  }
  const isVisible = (element) => {
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const hrefFor = (element) => {
    const anchor = element.closest('a') || (element.tagName === 'A' ? element : null)
    return anchor?.href || ''
  }
  const baseKeyFor = attrs => [
    attrs.id || '',
    attrs.list || '',
    attrs.key || '',
    attrs.field || '',
  ].join('|')
  const occurrenceByBaseKey = new Map()

  const elements = Array.from(document.querySelectorAll('[data-id]'))
    .filter(isVisible)
    .map((element, index) => {
      const attrs = dataAttrs(element)
      const baseKey = baseKeyFor(attrs)
      const occurrence = occurrenceByBaseKey.get(baseKey) || 0
      occurrenceByBaseKey.set(baseKey, occurrence + 1)
      const text = normalize(element.innerText || element.textContent || '')
      const rect = element.getBoundingClientRect()
      const hasDataValue = Object.prototype.hasOwnProperty.call(attrs, 'value')

      return {
        key: baseKey + '#' + occurrence,
        baseKey,
        occurrence,
        index,
        tag: element.tagName.toLowerCase(),
        id: attrs.id || '',
        list: attrs.list || '',
        itemKey: attrs.key || '',
        field: attrs.field || '',
        value: hasDataValue ? attrs.value : '',
        compareValue: hasDataValue ? attrs.value : text,
        text,
        href: hrefFor(element),
        attrs,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }
    })

  const listItems = elements.filter(element => element.list && element.itemKey)
  const lists = {}

  for (const item of listItems) {
    lists[item.list] ||= {
      list: item.list,
      keys: [],
      count: 0,
      containers: [],
    }
    lists[item.list].keys.push(item.itemKey)
    lists[item.list].count += 1
  }

  for (const element of elements.filter(item => item.list && !item.itemKey)) {
    lists[element.list] ||= {
      list: element.list,
      keys: [],
      count: 0,
      containers: [],
    }
    lists[element.list].containers.push({
      id: element.id,
      dataCount: element.attrs.count || '',
      renderedCount: element.attrs['rendered-count'] || '',
    })
  }

  return {
    pageId: meta.pageId,
    scenarioId: meta.scenarioId,
    label: meta.label,
    appName: meta.appName,
    capturedAt: new Date().toISOString(),
    title: document.title,
    url: window.location.href,
    path: window.location.pathname + window.location.search,
    counts: {
      tagged: elements.length,
      dataPoints: elements.filter(element => element.id === 'data-point').length,
      lists: Object.keys(lists).length,
    },
    lists,
    elements,
  }
}

function compareSnapshots(baseline, candidate, config = {}) {
  if (!candidate) {
    return {
      pageId: baseline.pageId,
      scenarioId: baseline.scenarioId,
      label: baseline.label,
      path: baseline.path,
      baselineUrl: baseline.url,
      candidateUrl: '',
      status: 'fail',
      summary: {
        baselineTagged: baseline.counts.tagged,
        candidateTagged: 0,
        elementDiffs: baseline.elements.length,
        listDiffs: Object.keys(baseline.lists || {}).length,
        captureErrors: 1,
        consoleErrors: 0,
        missingInCandidate: baseline.elements.length,
        extraInCandidate: 0,
        valueMismatches: 0,
      },
      captureErrors: [{ side: 'candidate', message: 'Candidate snapshot missing for page plan.' }],
      consoleErrors: [],
      listDiffs: [],
      elementDiffs: baseline.elements.map(element => ({
        key: element.key,
        baseKey: element.baseKey,
        status: 'missing-in-candidate',
        baseline: summarizeElement(element),
      })),
    }
  }

  const listDiffs = compareLists(baseline, candidate)
  const elementDiffs = compareElements(baseline, candidate, config)
  const failedElements = elementDiffs.filter(diff => diff.status !== 'match')
  const failedLists = listDiffs.filter(diff => diff.status !== 'match')
  const captureErrors = [
    baseline.captureError ? { side: 'baseline', message: baseline.captureError } : null,
    candidate.captureError ? { side: 'candidate', message: candidate.captureError } : null,
  ].filter(Boolean)
  const consoleErrors = [
    ...((baseline.console || [])
      .filter(message => message.type === 'error' && !isIgnoredConsoleError(message))
      .map(message => ({ side: 'baseline', message: message.text, location: message.location }))),
    ...((candidate.console || [])
      .filter(message => message.type === 'error' && !isIgnoredConsoleError(message))
      .map(message => ({ side: 'candidate', message: message.text, location: message.location }))),
  ]

  return {
    pageId: baseline.pageId,
    scenarioId: baseline.scenarioId,
    label: baseline.label,
    path: baseline.path,
    baselineUrl: baseline.url,
    candidateUrl: candidate.url,
    status: failedElements.length || failedLists.length || captureErrors.length || consoleErrors.length ? 'fail' : 'pass',
    summary: {
      baselineTagged: baseline.counts.tagged,
      candidateTagged: candidate.counts.tagged,
      elementDiffs: failedElements.length,
      listDiffs: failedLists.length,
      captureErrors: captureErrors.length,
      consoleErrors: consoleErrors.length,
      missingInCandidate: elementDiffs.filter(diff => diff.status === 'missing-in-candidate').length,
      extraInCandidate: elementDiffs.filter(diff => diff.status === 'extra-in-candidate').length,
      valueMismatches: elementDiffs.filter(diff => diff.status === 'value-mismatch').length,
    },
    captureErrors,
    consoleErrors,
    listDiffs,
    elementDiffs,
  }
}

function isIgnoredConsoleError(message) {
  const text = String(message?.text || '')
  if (!text.startsWith('Failed to load resource:')) return false
  return text.includes('net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin')
    || text.includes('the server responded with a status of 404')
}

function compareLists(baseline, candidate) {
  const baselineLists = baseline.lists || {}
  const candidateLists = candidate.lists || {}
  const listNames = Array.from(new Set([...Object.keys(baselineLists), ...Object.keys(candidateLists)])).sort()

  return listNames.map((list) => {
    const base = baselineLists[list] || { keys: [], count: 0, containers: [] }
    const cand = candidateLists[list] || { keys: [], count: 0, containers: [] }
    const missingKeys = base.keys.filter(key => !cand.keys.includes(key))
    const extraKeys = cand.keys.filter(key => !base.keys.includes(key))
    const orderMismatch = !sameArray(base.keys, cand.keys)
    const containerMismatch = JSON.stringify(base.containers) !== JSON.stringify(cand.containers)
    const status = missingKeys.length || extraKeys.length || orderMismatch || containerMismatch ? 'list-mismatch' : 'match'

    return {
      list,
      status,
      baselineCount: base.count,
      candidateCount: cand.count,
      baselineKeys: base.keys,
      candidateKeys: cand.keys,
      missingKeys,
      extraKeys,
      orderMismatch,
      baselineContainers: base.containers,
      candidateContainers: cand.containers,
    }
  })
}

function compareElements(baseline, candidate, config = {}) {
  const baselineMap = new Map(baseline.elements.map(element => [element.key, element]))
  const candidateMap = new Map(candidate.elements.map(element => [element.key, element]))
  const keys = Array.from(new Set([...baselineMap.keys(), ...candidateMap.keys()])).sort()
  const numericTolerance = config.numericTolerance ?? 0.01

  return keys.map((key) => {
    const base = baselineMap.get(key)
    const cand = candidateMap.get(key)

    if (!base) {
      return {
        key,
        baseKey: cand.baseKey,
        status: 'extra-in-candidate',
        candidate: summarizeElement(cand),
      }
    }

    if (!cand) {
      return {
        key,
        baseKey: base.baseKey,
        status: 'missing-in-candidate',
        baseline: summarizeElement(base),
      }
    }

    if (isStructuralListElement(base) && isStructuralListElement(cand)) {
      return {
        key,
        baseKey: base.baseKey,
        status: 'match',
        baseline: summarizeElement(base),
        candidate: summarizeElement(cand),
        mismatch: null,
      }
    }

    const valueComparison = compareComparableValues(base.compareValue, cand.compareValue, numericTolerance)
    const textComparison = compareComparableValues(base.text, cand.text, numericTolerance)
    const status = valueComparison.matches && textComparison.matches ? 'match' : 'value-mismatch'
    const mismatch = status === 'match'
      ? null
      : {
          value: buildMismatchEntry(valueComparison, base.compareValue, cand.compareValue),
          text: buildMismatchEntry(textComparison, base.text, cand.text),
        }

    return {
      key,
      baseKey: base.baseKey,
      status,
      baseline: summarizeElement(base),
      candidate: summarizeElement(cand),
      mismatch,
    }
  })
}

function isStructuralListElement(element) {
  return Boolean(
    element?.list
    && element.id !== 'data-point'
    && !element.field
    && !Object.prototype.hasOwnProperty.call(element.attrs || {}, 'value'),
  )
}

function buildMismatchEntry(comparison, baseline, candidate) {
  if (comparison.matches) return null

  return {
    baseline,
    candidate,
    comparison,
  }
}

function compareComparableValues(baseline, candidate, numericTolerance) {
  if (baseline === candidate) {
    return { matches: true, mode: 'exact' }
  }

  const baselineNumber = parseDisplayNumber(baseline)
  const candidateNumber = parseDisplayNumber(candidate)
  if (baselineNumber && candidateNumber) {
    const difference = Math.abs(baselineNumber.value - candidateNumber.value)
    const denominator = Math.max(Math.abs(baselineNumber.value), Math.abs(candidateNumber.value), Number.EPSILON)
    const allowedDifference = denominator * numericTolerance

    return {
      matches: difference <= allowedDifference,
      mode: 'numeric',
      tolerance: numericTolerance,
      baselineNumber: baselineNumber.value,
      candidateNumber: candidateNumber.value,
      difference,
      allowedDifference,
    }
  }

  return { matches: false, mode: 'exact' }
}

function parseDisplayNumber(value) {
  const text = String(value ?? '').trim()
  if (!text || /^[-–—]+$/.test(text) || /^n\/?a$/i.test(text)) return null

  const normalized = text.replace(/\u00a0/g, ' ').replaceAll(',', '')
  const matches = Array.from(normalized.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi))
  if (matches.length !== 1) return null

  const match = matches[0]
  const before = normalized.slice(0, match.index)
  const after = normalized.slice((match.index || 0) + match[0].length)
  if (!/^[\s$€£¥₿~≈<>+-]*$/.test(before)) return null

  const suffixMatch = after.match(/^\s*([kKmMbBtT])?([xX])?\s*%?\s*$/)
  if (!suffixMatch || (suffixMatch[1] && suffixMatch[2])) return null

  const parsed = Number(match[0])
  if (!Number.isFinite(parsed)) return null

  const suffix = suffixMatch[1]?.toLowerCase()
  const multiplier = suffix === 'k'
    ? 1_000
    : suffix === 'm'
      ? 1_000_000
      : suffix === 'b'
        ? 1_000_000_000
        : suffix === 't'
          ? 1_000_000_000_000
          : 1

  return { value: parsed * multiplier }
}

function summarizeElement(element) {
  return {
    id: element.id,
    list: element.list,
    itemKey: element.itemKey,
    field: element.field,
    value: element.value,
    compareValue: element.compareValue,
    text: element.text,
    href: element.href,
    attrs: element.attrs,
  }
}

function buildDiff({ run, config, outputDir, baselineSnapshots, candidateSnapshots, pageDiffs }) {
  const failedPages = pageDiffs.filter(page => page.status !== 'pass')

  return {
    runId: run.runId,
    generatedAt: new Date().toISOString(),
    outputDir,
    baseline: run.baseline,
    candidate: run.candidate,
    artifacts: {
      baseline: path.join(outputDir, 'baseline.json'),
      candidate: path.join(outputDir, 'candidate.json'),
      diff: path.join(outputDir, 'diff.json'),
      report: path.join(outputDir, 'report.html'),
    },
    summary: {
      pages: pageDiffs.length,
      failedPages: failedPages.length,
      baselineSnapshots: baselineSnapshots.length,
      candidateSnapshots: candidateSnapshots.length,
      elementDiffs: pageDiffs.reduce((total, page) => total + page.summary.elementDiffs, 0),
      listDiffs: pageDiffs.reduce((total, page) => total + page.summary.listDiffs, 0),
      captureErrors: pageDiffs.reduce((total, page) => total + page.summary.captureErrors, 0),
      consoleErrors: pageDiffs.reduce((total, page) => total + page.summary.consoleErrors, 0),
      missingInCandidate: pageDiffs.reduce((total, page) => total + page.summary.missingInCandidate, 0),
      extraInCandidate: pageDiffs.reduce((total, page) => total + page.summary.extraInCandidate, 0),
      valueMismatches: pageDiffs.reduce((total, page) => total + page.summary.valueMismatches, 0),
      numericTolerance: config.numericTolerance,
    },
    pages: pageDiffs,
    pagesWithDiscrepancies: failedPages.map(page => ({
      pageId: page.pageId,
      scenarioId: page.scenarioId,
      label: page.label,
      path: page.path,
      baselineUrl: page.baselineUrl,
      candidateUrl: page.candidateUrl,
      summary: page.summary,
      captureErrors: page.captureErrors,
      consoleErrors: page.consoleErrors,
    })),
  }
}

function renderHtmlReport(diff) {
  const rows = diff.pages.map((page) => {
    const cls = page.status === 'pass' ? 'pass' : 'fail'
    return [
      '<tr class="' + cls + '">',
      '<td>' + escapeHtml(page.status) + '</td>',
      '<td><code>' + escapeHtml(page.pageId) + '</code><br>' + escapeHtml(page.label) + '</td>',
      '<td><a href="' + escapeAttr(page.baselineUrl) + '">baseline</a> | <a href="' + escapeAttr(page.candidateUrl) + '">candidate</a></td>',
      '<td>' + page.summary.listDiffs + '</td>',
      '<td>' + page.summary.elementDiffs + '</td>',
      '<td>' + page.summary.captureErrors + '</td>',
      '<td>' + page.summary.consoleErrors + '</td>',
      '<td>' + page.summary.missingInCandidate + '</td>',
      '<td>' + page.summary.extraInCandidate + '</td>',
      '<td>' + page.summary.valueMismatches + '</td>',
      '</tr>',
    ].join('')
  }).join('\n')

  const problemLinks = diff.pagesWithDiscrepancies.map(page =>
    '<li><code>' + escapeHtml(page.pageId) + '</code> '
    + '<a href="' + escapeAttr(page.baselineUrl) + '">baseline</a> '
    + '<a href="' + escapeAttr(page.candidateUrl) + '">candidate</a></li>',
  ).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Parity report ${escapeHtml(diff.runId)}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; margin: 24px; color: #111827; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border: 1px solid #d1d5db; padding: 8px; vertical-align: top; text-align: left; }
    th { background: #f3f4f6; }
    tr.pass td:first-child { color: #047857; font-weight: 700; }
    tr.fail td:first-child { color: #b91c1c; font-weight: 700; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Parity report ${escapeHtml(diff.runId)}</h1>
  <p>${diff.summary.failedPages} failed pages out of ${diff.summary.pages}. Element diffs: ${diff.summary.elementDiffs}. List diffs: ${diff.summary.listDiffs}.</p>
  <h2>Discrepancy links</h2>
  <ul>${problemLinks || '<li>None</li>'}</ul>
  <h2>Pages</h2>
  <table>
    <thead>
      <tr>
        <th>Status</th>
        <th>Page</th>
        <th>Links</th>
        <th>List diffs</th>
        <th>Element diffs</th>
        <th>Capture errors</th>
        <th>Console errors</th>
        <th>Missing</th>
        <th>Extra</th>
        <th>Value</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`
}

function printSummary(diff) {
  console.log('[parity-compare] Wrote artifacts to ' + diff.outputDir)
  console.log('[parity-compare] baseline.json: ' + diff.artifacts.baseline)
  console.log('[parity-compare] candidate.json: ' + diff.artifacts.candidate)
  console.log('[parity-compare] diff.json: ' + diff.artifacts.diff)
  console.log('[parity-compare] report.html: ' + diff.artifacts.report)
  console.log('[parity-compare] failed pages: ' + diff.summary.failedPages + '/' + diff.summary.pages)

  if (diff.pagesWithDiscrepancies.length) {
    console.log('[parity-compare] pages with discrepancies:')
    for (const page of diff.pagesWithDiscrepancies) {
      console.log('  ' + page.pageId)
      console.log('    baseline:  ' + page.baselineUrl)
      console.log('    candidate: ' + page.candidateUrl)
    }
  }
}

async function loadScenarios(config) {
  const file = JSON.parse(await fs.readFile(config.scenarioFile, 'utf8'))
  const defaults = file.defaults || {}
  const scenarios = file.scenarios || []
  const filtered = config.scenarioFilter.length
    ? scenarios.filter(scenario => config.scenarioFilter.includes(scenario.id))
    : scenarios

  return filtered
    .filter((scenario) => {
      if (!scenario.skipUnlessEnv) return true
      return Boolean(process.env[scenario.skipUnlessEnv])
    })
    .map(scenario => substituteEnv({
      ...scenario,
      defaults,
      viewport: scenario.viewport || defaults.viewport,
      localStorage: { ...(defaults.localStorage || {}), ...(scenario.localStorage || {}) },
      waitFor: scenario.waitFor || defaults.waitFor || [],
      settleMs: scenario.settleMs ?? defaults.settleMs ?? 0,
      rateLimitRetries: scenario.rateLimitRetries ?? defaults.rateLimitRetries ?? config.rateLimitRetries,
      navigationRetries: scenario.navigationRetries ?? defaults.navigationRetries ?? config.navigationRetries,
      navigationTimeoutMs: scenario.navigationTimeoutMs ?? defaults.navigationTimeoutMs ?? config.navigationTimeoutMs,
    }))
}

function substituteEnv(value) {
  if (Array.isArray(value)) return value.map(item => substituteEnv(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteEnv(item)]))
  }
  if (typeof value !== 'string') return value

  return value.replace(/\\$\\{([A-Z0-9_]+)\\}/g, (_, name) => process.env[name] || '')
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

function valuesOf(name) {
  const value = args.flags[name]
  if (!value) return []
  return Array.isArray(value) ? value : String(value).split(',').filter(Boolean)
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseNumericTolerance(value) {
  const raw = String(value ?? '').trim()
  const parsed = raw.endsWith('%')
    ? Number(raw.slice(0, -1)) / 100
    : Number(raw)

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Invalid numeric tolerance: ' + value)
  }

  return parsed
}

function startDevServer(dir, host, port) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(npmCommand, ['run', 'dev', '--', '--host', host, '--port', String(port)], {
    cwd: dir,
    env: {
      ...process.env,
      BROWSER: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', chunk => process.stdout.write('[' + path.basename(dir) + '] ' + chunk))
  child.stderr.on('data', chunk => process.stderr.write('[' + path.basename(dir) + '] ' + chunk))

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

async function launchBrowser(headless) {
  const channel = process.env.PARITY_BROWSER_CHANNEL === 'none'
    ? undefined
    : process.env.PARITY_BROWSER_CHANNEL || 'chrome'

  if (channel) {
    try {
      return await chromium.launch({ channel, headless })
    }
    catch (error) {
      console.warn('[parity-compare] Could not launch channel "' + channel + '": ' + error.message)
      console.warn('[parity-compare] Falling back to Playwright-managed Chromium.')
    }
  }

  return chromium.launch({ headless })
}

async function waitForHttp(url, timeoutMs, serverProcess) {
  const startedAt = Date.now()
  let lastError

  while (Date.now() - startedAt < timeoutMs) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error('Dev server exited before becoming ready.')
    }

    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (response.status === 429) {
        lastError = new Error('HTTP 429')
        await sleep(1_000)
        continue
      }
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

function pathFromUrl(value) {
  const url = new URL(value)
  return url.pathname + url.search
}

function originOf(value) {
  const url = new URL(value)
  return url.origin
}

function sameArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sanitizeFilePart(value) {
  return String(value || 'item').replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'item'
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('\'', '&#39;')
}

function printHelp() {
  console.log(`
Usage:
  npm run parity:compare
  npm run parity:compare -- --baseline-branch feature/parity-data-tags
  npm run parity:compare -- --baseline-dir ../euler-lite --candidate-dir .
  npm run parity:compare -- --baseline-url http://127.0.0.1:3100 --candidate-url http://127.0.0.1:3200

Options:
  --scenarios <file>          Scenario JSON file. Default: tests/parity/scenarios.json
  --scenario <id[,id]>        Only run selected scenarios.
  --baseline-branch <branch>  Create/reuse .parity worktree for this branch. Default: ${DEFAULT_BASELINE_BRANCH}
  --baseline-dir <dir>        Start baseline app from this checkout.
  --candidate-dir <dir>       Start candidate app from this checkout. Default: current repo.
  --baseline-url <url>        Attach to a running baseline app.
  --candidate-url <url>       Attach to a running candidate app.
  --output-dir <dir>          Artifact directory. Default: artifacts/parity/<timestamp>
  --env-file <file[,file]>    Load app env from root-relative file(s). Default: .env. Use "none" to disable.
  --max-follow-items <n>      Limit list item detail pages. Default: all.
  --ready-timeout-ms <n>      Dev server readiness timeout. Default: 120000.
  --wait-timeout-ms <n>       Per-selector wait timeout. Default: 45000.
  --navigation-timeout-ms <n> Per-page navigation timeout. Default: 45000.
  --navigation-retries <n>    Retry page navigations before recording a capture error. Default: 3.
  --numeric-tolerance <n|%>   Relative tolerance for numeric values. Default: 1%.
  --rate-limit-retries <n>    Retry page captures that observe HTTP 429. Default: 3.
  --sequential                Capture baseline/candidate page-by-page to avoid two dev watchers.
  --headed                    Show browser.
  --no-fail                   Exit 0 even when diffs are found.
  --skip-install              Do not run npm ci in missing-node_modules worktrees.

Artifacts:
  baseline.json               Recorded data from baseline pages.
  candidate.json              Recorded data from candidate pages.
  diff.json                   Machine-readable comparison and discrepancy links.
  report.html                 Human-readable report with discrepancy links.

Environment:
  PARITY_SPY_ADDRESS          Enables recorded portfolio spy scenarios.
  PARITY_BASELINE_BRANCH      Baseline branch when --baseline-* is omitted.
  PARITY_ENV_FILE             Same as --env-file.
  PARITY_NUMERIC_TOLERANCE    Same as --numeric-tolerance.
  PARITY_RATE_LIMIT_RETRIES   Same as --rate-limit-retries.
  PARITY_NAVIGATION_TIMEOUT_MS Same as --navigation-timeout-ms.
  PARITY_NAVIGATION_RETRIES   Same as --navigation-retries.
  PARITY_HEADED=1             Show browser.
`)
}
