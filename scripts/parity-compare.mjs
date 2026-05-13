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
const DEFAULT_WAIT_TIMEOUT_MS = 6_000
const DEFAULT_DATA_READY_TIMEOUT_MS = 6_000
const DEFAULT_CAPTURE_BUDGET_MS = 6_000
const DEFAULT_PORTFOLIO_TIMEOUT_MS = 25_000
const DEFAULT_PORTFOLIO_CAPTURE_BUDGET_MS = 25_000
const DEFAULT_NETWORK_IDLE_TIMEOUT_MS = 0
const DEFAULT_NUMERIC_TOLERANCE = 0.02
const LIST_SHOW_ALL_MIN_CAPTURE_MS = 10_000
const LIST_SHOW_ALL_HYDRATION_TIMEOUT_MS = 20_000
const LIST_HYDRATION_SETTLE_ROUNDS = 2
const LIST_HYDRATION_SCROLL_SEGMENTS = 10
const LIST_HYDRATION_SCROLL_DELAY_MS = 75
const DEFAULT_PERSISTENCE_RECHECK_MAX_RATIO = 0.1
const DEFAULT_SCRAPE_FAILURE_LIMIT = 5
const DEFAULT_WORK_DIR = path.join('/tmp', 'euler-lite-parity', sanitizeFilePart(ROOT_DIR))

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
      captureBudgetMs: config.captureBudgetMs,
      portfolioTimeoutMs: config.portfolioTimeoutMs,
      portfolioCaptureBudgetMs: config.portfolioCaptureBudgetMs,
      dataReadyTimeoutMs: config.dataReadyTimeoutMs,
      networkIdleTimeoutMs: config.networkIdleTimeoutMs,
      persistenceRecheckMaxRatio: config.persistenceRecheckMaxRatio,
      scrapeFailureLimit: config.scrapeFailureLimit,
      scenarioFilter: config.scenarioFilter,
      appPhased: config.appPhased,
      alternating: config.sequential,
      parallel: config.parallel,
      workDir: config.workDir,
    })

    state.browser = await launchBrowser(config.headless)
    const scenarios = await loadScenarios(config)
    let baselineSnapshots = []
    let candidateSnapshots = []
    let pageDiffs = []
    const scrapeFailureGuard = createScrapeFailureGuard(config)

    if (config.appPhased) {
      const result = await runScenariosAppPhased({
        run,
        scenarios,
        config,
        browser: state.browser,
        baseline: run.baseline,
        candidate: run.candidate,
        state,
        scrapeFailureGuard,
      })
      baselineSnapshots = result.baseline
      candidateSnapshots = result.candidate
      pageDiffs = result.diffs
    }
    else if (config.sequential) {
      // Slow diagnostic mode: alternates baseline/candidate for every page and
      // modal. Keep this opt-in so normal runs reuse one session per app phase.
      const result = await runScenariosSequentialByPage({
        run,
        scenarios,
        config,
        browser: state.browser,
        baseline: run.baseline,
        candidate: run.candidate,
        state,
        scrapeFailureGuard,
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
          run,
          scenario,
          config,
          browser: state.browser,
          baseline: state.apps[0],
          candidate: state.apps[1],
          scrapeFailureGuard,
        })

        baselineSnapshots.push(...result.baseline)
        candidateSnapshots.push(...result.candidate)
        pageDiffs.push(...result.diffs)
        await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs })
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
    await verifyPersistentDiscrepancies({
      diff,
      run,
      config,
      browser: state.browser,
      scenarios,
      state,
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
  const alternating = Boolean(
    args.flags.alternating
    || args.flags.sequential
    || process.env.PARITY_ALTERNATING === '1'
    || process.env.PARITY_SEQUENTIAL === '1',
  )
  const parallel = Boolean(args.flags.parallel || process.env.PARITY_PARALLEL === '1')
  const appPhased = Boolean(
    args.flags.appPhased
    || args.flags['app-phased']
    || process.env.PARITY_APP_PHASED === '1'
    || (!alternating && !parallel),
  )

  if ([alternating, parallel, appPhased].filter(Boolean).length > 1) {
    throw new Error('Choose only one capture mode: default app-phased, --alternating, or --parallel')
  }

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
    waitTimeoutMs: Number(valueOf('wait-timeout-ms') || process.env.PARITY_WAIT_TIMEOUT_MS || DEFAULT_WAIT_TIMEOUT_MS),
    dataReadyTimeoutMs: Number(valueOf('data-ready-timeout-ms') || process.env.PARITY_DATA_READY_TIMEOUT_MS || DEFAULT_DATA_READY_TIMEOUT_MS),
    captureBudgetMs: Number(valueOf('capture-budget-ms') || process.env.PARITY_CAPTURE_BUDGET_MS || DEFAULT_CAPTURE_BUDGET_MS),
    portfolioTimeoutMs: Number(valueOf('portfolio-timeout-ms') || process.env.PARITY_PORTFOLIO_TIMEOUT_MS || DEFAULT_PORTFOLIO_TIMEOUT_MS),
    portfolioCaptureBudgetMs: Number(valueOf('portfolio-capture-budget-ms') || process.env.PARITY_PORTFOLIO_CAPTURE_BUDGET_MS || DEFAULT_PORTFOLIO_CAPTURE_BUDGET_MS),
    networkIdleTimeoutMs: Number(valueOf('network-idle-timeout-ms') || process.env.PARITY_NETWORK_IDLE_TIMEOUT_MS || DEFAULT_NETWORK_IDLE_TIMEOUT_MS),
    persistenceRecheckMaxRatio: Number(valueOf('persistence-recheck-max-ratio') || process.env.PARITY_PERSISTENCE_RECHECK_MAX_RATIO || DEFAULT_PERSISTENCE_RECHECK_MAX_RATIO),
    scrapeFailureLimit: Number(valueOf('scrape-failure-limit') || process.env.PARITY_SCRAPE_FAILURE_LIMIT || DEFAULT_SCRAPE_FAILURE_LIMIT),
    navigationTimeoutMs: Number(valueOf('navigation-timeout-ms') || process.env.PARITY_NAVIGATION_TIMEOUT_MS || 45_000),
    navigationRetries: Number(valueOf('navigation-retries') || process.env.PARITY_NAVIGATION_RETRIES || 3),
    numericTolerance: parseNumericTolerance(valueOf('numeric-tolerance') || process.env.PARITY_NUMERIC_TOLERANCE || DEFAULT_NUMERIC_TOLERANCE),
    rateLimitRetries: Number(valueOf('rate-limit-retries') || process.env.PARITY_RATE_LIMIT_RETRIES || 3),
    sequential: alternating,
    appPhased,
    parallel,
    skipBuild: Boolean(args.flags.skipBuild || args.flags['skip-build'] || process.env.PARITY_SKIP_BUILD === '1'),
    workDir: path.resolve(valueOf('work-dir') || process.env.PARITY_WORK_DIR || DEFAULT_WORK_DIR),
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
    dir = await ensureBranchWorktree(branch, config)
  }

  if (!dir && name === 'candidate') {
    dir = ROOT_DIR
  }

  if (!dir) {
    throw new Error('Missing ' + name + ' URL or directory.')
  }

  const resolvedDir = path.resolve(dir)
  await ensureDependencies(resolvedDir, config)
  await ensureProductionBuild(resolvedDir, config)

  return {
    name,
    mode: 'dir',
    dir: resolvedDir,
    branch,
  }
}

async function ensureProductionBuild(dir, config) {
  if (config.skipBuild) {
    const outputServer = path.join(dir, '.output/server/index.mjs')
    if (!existsSync(outputServer)) {
      throw new Error('Missing production output in ' + dir + '. Run npm run build there or omit --skip-build.')
    }
    return
  }

  console.log('[parity-compare] Building production app in ' + dir)
  // Nuxt can otherwise carry a stale dev client manifest from `.nuxt` into a
  // production build, causing the server to emit `/_nuxt/@vite/client` links.
  await fs.rm(path.join(dir, '.nuxt'), { recursive: true, force: true })
  await fs.rm(path.join(dir, '.output'), { recursive: true, force: true })
  await runCommand(npmCommand(), ['run', 'build'], { cwd: dir })
}

async function ensureBranchWorktree(branch, config) {
  const worktreeDir = path.join(config.workDir, 'worktrees', sanitizeFilePart(branch))
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

  console.log('[parity-compare] Starting ' + app.name + ' production app in ' + app.dir + ' on ' + baseUrl)
  const serverProcess = startProductionServer(app.dir, config.host, port)
  await waitForHttp(baseUrl, config.readyTimeoutMs, serverProcess)

  return {
    ...app,
    baseUrl,
    serverProcess,
  }
}

async function runScenario({ run, scenario, config, browser, baseline, candidate, scrapeFailureGuard }) {
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
      dataReadyTimeoutMs: config.dataReadyTimeoutMs,
      networkIdleTimeoutMs: config.networkIdleTimeoutMs,
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
      dataReadyTimeoutMs: config.dataReadyTimeoutMs,
      networkIdleTimeoutMs: config.networkIdleTimeoutMs,
      keepPage: true,
    })

    baselineSnapshots.push(basePageResult.snapshot)
    candidateSnapshots.push(candidatePageResult.snapshot)
    diffs.push(compareSnapshots(basePageResult.snapshot, candidatePageResult.snapshot, config))
    await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
    scrapeFailureGuard.observe(basePageResult.snapshot)
    scrapeFailureGuard.observe(candidatePageResult.snapshot)

    for (const follow of scenario.follow || []) {
      await waitForFollowLinks(basePageResult.page, follow.selector, follow.waitTimeoutMs || config.waitTimeoutMs)
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
          dataReadyTimeoutMs: config.dataReadyTimeoutMs,
          networkIdleTimeoutMs: config.networkIdleTimeoutMs,
        })
        const candidateDetail = await openAndCapture({
          app: candidate,
          context: candidateContext,
          scenario: { ...scenario, label },
          pageId,
          pathName: detailPath,
          waitFor: follow.waitFor || scenario.waitFor,
          waitTimeoutMs: config.waitTimeoutMs,
          dataReadyTimeoutMs: config.dataReadyTimeoutMs,
          networkIdleTimeoutMs: config.networkIdleTimeoutMs,
        })

        baselineSnapshots.push(baseDetail.snapshot)
        candidateSnapshots.push(candidateDetail.snapshot)
        diffs.push(compareSnapshots(baseDetail.snapshot, candidateDetail.snapshot, config))
        await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
        scrapeFailureGuard.observe(baseDetail.snapshot)
        scrapeFailureGuard.observe(candidateDetail.snapshot)
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

async function runScenariosSequentialByPage({ run, scenarios, config, browser, baseline, candidate, state, scrapeFailureGuard }) {
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
      await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
      scrapeFailureGuard.observe(baselineResult.snapshot)
      scrapeFailureGuard.observe(candidateDetail)

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
        await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
        scrapeFailureGuard.observe(baselineModal.snapshot)
        scrapeFailureGuard.observe(candidateModal)
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
        await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
        scrapeFailureGuard.observe(baselineDetail.snapshot)
        scrapeFailureGuard.observe(candidateDetail)

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
          await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
          scrapeFailureGuard.observe(baselineModal.snapshot)
          scrapeFailureGuard.observe(candidateModal)
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

async function runScenariosAppPhased({ run, scenarios, config, browser, baseline, candidate, state, scrapeFailureGuard }) {
  const baselineSnapshots = []
  const candidateSnapshots = []
  const diffs = []
  const candidateQueue = []

  // Default fast path: capture all baseline pages first, then all candidate
  // pages, reusing one browser page/context per app. This avoids the expensive
  // baseline/candidate/modal alternation used only by --alternating.
  const baselineApp = await startOrAttach(baseline, config)
  state.apps = [baselineApp]
  const baselineRuntime = await createAppPhaseRuntime(browser, scenarios[0])

  try {
    for (const scenario of scenarios) {
      console.log('[parity-compare] Running ' + scenario.id + ' baseline phase')
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
        runtime: baselineRuntime,
        plan: mainPlan,
        follows: scenario.follow || [],
        state,
      })

      baselineSnapshots.push(baselineResult.snapshot)
      candidateQueue.push({
        type: 'page',
        plan: mainPlan,
        baselineSnapshot: baselineResult.snapshot,
      })
      await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
      scrapeFailureGuard.observe(baselineResult.snapshot)

      for (const baselineModal of baselineResult.modalPlans) {
        baselineSnapshots.push(baselineModal.snapshot)
        candidateQueue.push({
          type: 'modal',
          plan: baselineModal,
          baselineSnapshot: baselineModal.snapshot,
        })
        await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
        scrapeFailureGuard.observe(baselineModal.snapshot)
      }

      for (const followPlan of baselineResult.followPlans) {
        const baselineDetail = await capturePlanWithModalsSequential({
          appDefinition: baseline,
          app: baselineApp,
          config,
          browser,
          runtime: baselineRuntime,
          plan: followPlan,
          state,
        })

        baselineSnapshots.push(baselineDetail.snapshot)
        candidateQueue.push({
          type: 'page',
          plan: followPlan,
          baselineSnapshot: baselineDetail.snapshot,
        })
        await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
        scrapeFailureGuard.observe(baselineDetail.snapshot)

        for (const baselineModal of baselineDetail.modalPlans) {
          baselineSnapshots.push(baselineModal.snapshot)
          candidateQueue.push({
            type: 'modal',
            plan: baselineModal,
            baselineSnapshot: baselineModal.snapshot,
          })
          await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
          scrapeFailureGuard.observe(baselineModal.snapshot)
        }
      }
    }
  }
  finally {
    await closeAppPhaseRuntime(baselineRuntime)
    await stopServer(baselineApp.serverProcess)
    state.apps = []
  }

  const candidateApp = await startOrAttach(candidate, config)
  state.apps = [candidateApp]
  const candidateRuntime = await createAppPhaseRuntime(browser, candidateQueue[0]?.plan?.scenario || scenarios[0])
  let currentCandidatePage = null

  try {
    console.log('[parity-compare] Running candidate phase: ' + candidateQueue.length + ' page/modal captures')
    for (const item of candidateQueue) {
      let candidateSnapshot = null

      if (
        item.type === 'modal'
        && currentCandidatePage
        && currentCandidatePage.pageId === item.plan.parentPageId
        && currentCandidatePage.pathName === item.plan.pathName
      ) {
        candidateSnapshot = await captureModalPlanOnCurrentPage({
          app: candidateApp,
          config,
          runtime: candidateRuntime,
          plan: item.plan,
        })
      }
      else if (item.type === 'modal') {
        candidateSnapshot = await captureModalPlanSequential({
          appDefinition: candidate,
          app: candidateApp,
          config,
          browser,
          runtime: candidateRuntime,
          plan: item.plan,
          state,
        })
        currentCandidatePage = {
          pageId: item.plan.parentPageId,
          pathName: item.plan.pathName,
        }
      }
      else {
        const result = await capturePlanSequential({
          appDefinition: candidate,
          app: candidateApp,
          config,
          browser,
          runtime: candidateRuntime,
          plan: item.plan,
          state,
          returnResult: true,
        })
        candidateSnapshot = result.snapshot
        currentCandidatePage = {
          pageId: item.plan.pageId,
          pathName: item.plan.pathName,
        }
      }

      candidateSnapshots.push(candidateSnapshot)
      diffs.push(compareSnapshots(item.baselineSnapshot, candidateSnapshot, config))
      await writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs: diffs })
      scrapeFailureGuard.observe(candidateSnapshot)
    }
  }
  finally {
    await closeAppPhaseRuntime(candidateRuntime)
    await stopServer(candidateApp.serverProcess)
    state.apps = []
  }

  return {
    baseline: baselineSnapshots,
    candidate: candidateSnapshots,
    diffs,
  }
}

async function createAppPhaseRuntime(browser, scenario) {
  const context = await createContext(browser, scenario || {})
  return {
    context,
    page: await context.newPage(),
    localStorageKeys: new Set(Object.keys(scenarioLocalStorage(scenario || {}))),
    forceDocumentNavigation: false,
  }
}

async function closeAppPhaseRuntime(runtime) {
  await runtime?.page?.close().catch(() => {})
  await runtime?.context?.close().catch(() => {})
}

async function verifyPersistentDiscrepancies({ diff, run, config, browser, scenarios, state }) {
  const failedPages = diff.pages.filter(page => page.status !== 'pass')
  if (!failedPages.length) {
    diff.persistenceSummary = { checked: 0, persistent: 0, resolved: 0, failed: 0, skipped: 0 }
    return
  }

  const failedRatio = failedPages.length / Math.max(diff.pages.length, 1)
  if (failedRatio > config.persistenceRecheckMaxRatio) {
    diff.persistenceSummary = {
      checked: 0,
      persistent: 0,
      resolved: 0,
      failed: 0,
      skipped: failedPages.length,
      reason: 'discrepancy-ratio-exceeded',
      failedRatio,
      maxRatio: config.persistenceRecheckMaxRatio,
    }
    console.log('[parity-compare] Skipping reload recheck: '
      + failedPages.length + '/' + diff.pages.length
      + ' discrepant captures exceeds '
      + Math.round(config.persistenceRecheckMaxRatio * 100)
      + '% threshold')
    return
  }

  console.log('[parity-compare] Rechecking ' + failedPages.length + ' discrepant page(s) after reload')
  const scenarioById = new Map(scenarios.map(scenario => [scenario.id, scenario]))
  const baselineApp = await startOrAttach(run.baseline, config)
  const candidateApp = await startOrAttach(run.candidate, config)
  state.apps = [baselineApp, candidateApp]

  const baselineRuntime = await createAppPhaseRuntime(browser, scenarios[0])
  const candidateRuntime = await createAppPhaseRuntime(browser, scenarios[0])

  const groups = groupPersistenceRecheckPages(failedPages, scenarioById, scenarios[0])
  const results = []
  try {
    for (const group of groups) {
      console.log('[parity-compare] Rechecking ' + group.parentPageId + (group.pages.length > 1 ? ' (' + group.pages.length + ' discrepant captures)' : ''))

      try {
        const baselineSnapshots = await recaptureDiffGroup({
          app: baselineApp,
          runtime: baselineRuntime,
          group,
          config,
        })
        const candidateSnapshots = await recaptureDiffGroup({
          app: candidateApp,
          runtime: candidateRuntime,
          group,
          config,
        })

        for (const pageDiff of group.pages) {
          const baselineSnapshot = baselineSnapshots.get(pageDiff.pageId)
          const candidateSnapshot = candidateSnapshots.get(pageDiff.pageId)
          const secondDiff = compareSnapshots(baselineSnapshot, candidateSnapshot, config)
          const result = {
            pageId: pageDiff.pageId,
            status: secondDiff.status === 'pass' ? 'resolved-after-reload' : 'persistent',
            summary: secondDiff.summary,
            captureErrors: secondDiff.captureErrors,
            consoleErrors: secondDiff.consoleErrors,
          }
          pageDiff.persistence = result
          results.push(result)
        }
      }
      catch (error) {
        for (const pageDiff of group.pages) {
          const result = {
            pageId: pageDiff.pageId,
            status: 'verification-failed',
            error: error?.message || String(error),
          }
          pageDiff.persistence = result
          results.push(result)
        }
      }
    }
  }
  finally {
    await Promise.all([
      closeAppPhaseRuntime(baselineRuntime),
      closeAppPhaseRuntime(candidateRuntime),
      stopServer(baselineApp.serverProcess),
      stopServer(candidateApp.serverProcess),
    ])
    state.apps = []
  }

  diff.persistenceSummary = {
    checked: results.length,
    persistent: results.filter(result => result.status === 'persistent').length,
    resolved: results.filter(result => result.status === 'resolved-after-reload').length,
    failed: results.filter(result => result.status === 'verification-failed').length,
    skipped: 0,
  }
  diff.pagesWithDiscrepancies = summarizeDiscrepantPages(diff.pages.filter(page => page.status !== 'pass'))
}

function groupPersistenceRecheckPages(pageDiffs, scenarioById, fallbackScenario) {
  const groups = new Map()

  for (const pageDiff of pageDiffs) {
    const scenario = scenarioById.get(pageDiff.scenarioId) || fallbackScenario
    const isModal = isModalPageId(pageDiff.pageId)
    const parentPageId = isModal ? parentPageIdForModal(pageDiff.pageId) : pageDiff.pageId
    const pathName = pageDiff.requestedPath || pathFromUrl(pageDiff.baselineUrl || pageDiff.candidateUrl)
    const parentWaitFor = pageDiff.parentWaitFor?.length
      ? pageDiff.parentWaitFor
      : (pageDiff.waitFor?.length ? pageDiff.waitFor : scenario.waitFor)
    const key = [
      scenario.id,
      parentPageId,
      pathName,
    ].join('|')

    if (!groups.has(key)) {
      groups.set(key, {
        scenario,
        parentPageId,
        pathName,
        parentWaitFor,
        pages: [],
      })
    }
    const group = groups.get(key)
    // Prefer the real parent page wait condition when both a parent and one or
    // more modal captures are discrepant. Older modal snapshots may have stored
    // the scenario list wait condition as parentWaitFor.
    if (!isModal || !group.parentWaitFor?.length) group.parentWaitFor = parentWaitFor
    group.pages.push(pageDiff)
  }

  return [...groups.values()]
}

function isModalPageId(pageId) {
  return pageId.includes('/modal/')
}

function parentPageIdForModal(pageId) {
  return pageId.split('/modal/')[0]
}

async function recaptureDiffGroup({ app, runtime, group, config }) {
  await prepareRuntimeForScenario(runtime, group.scenario)
  const snapshots = new Map()
  const pageResult = await openAndCapture({
    app,
    context: runtime.context,
    page: runtime.page,
    scenario: group.scenario,
    pageId: group.parentPageId,
    pathName: group.pathName,
    waitFor: group.parentWaitFor,
    waitTimeoutMs: config.waitTimeoutMs,
    dataReadyTimeoutMs: config.dataReadyTimeoutMs,
    networkIdleTimeoutMs: config.networkIdleTimeoutMs,
    keepPage: true,
  })

  for (const pageDiff of group.pages) {
    if (!isModalPageId(pageDiff.pageId)) {
      snapshots.set(pageDiff.pageId, pageResult.snapshot)
      continue
    }

    const modalId = pageDiff.pageId.split('/modal/')[1]
    const modalSnapshots = await captureModalPlansOnPage({
      page: pageResult.page,
      scenario: group.scenario,
      pageId: group.parentPageId,
      pathName: group.pathName,
      appName: app.name,
      waitTimeoutMs: effectiveWaitTimeout(group.scenario, group.pathName, config.waitTimeoutMs),
      dataReadyTimeoutMs: effectiveDataReadyTimeout(group.scenario, group.pathName, config.dataReadyTimeoutMs),
      networkIdleTimeoutMs: config.networkIdleTimeoutMs,
      parentWaitFor: group.parentWaitFor,
      onlyModalId: modalId,
    })

    snapshots.set(pageDiff.pageId, modalSnapshots[0]?.snapshot || {
      ...pageResult.snapshot,
      pageId: pageDiff.pageId,
      captureError: 'Modal capture not found during persistence recheck for ' + modalId,
    })
  }

  return snapshots
}

async function prepareRuntimeForScenario(runtime, scenario) {
  if (!runtime?.page) return

  const nextStorage = scenarioLocalStorage(scenario)
  const nextKeys = new Set(Object.keys(nextStorage))
  const keysToRemove = [...runtime.localStorageKeys].filter(key => !nextKeys.has(key))
  let storageChanged = false

  if (keysToRemove.length || nextKeys.size) {
    storageChanged = await runtime.page.evaluate(
      ({ remove, set }) => {
        let changed = false
        for (const key of remove) window.localStorage.removeItem(key)
        if (remove.length) changed = true
        for (const [key, value] of Object.entries(set)) {
          const nextValue = String(value)
          if (window.localStorage.getItem(key) !== nextValue) {
            window.localStorage.setItem(key, nextValue)
            changed = true
          }
        }
        return changed
      },
      { remove: keysToRemove, set: nextStorage },
    ).catch(() => true)
  }

  runtime.localStorageKeys = nextKeys
  runtime.forceDocumentNavigation = runtime.forceDocumentNavigation || storageChanged
  if (storageChanged) runtime.page._parityForceDocumentNavigation = true
}

function scenarioLocalStorage(scenario) {
  return scenario?.localStorage || scenario?.defaults?.localStorage || {}
}

async function capturePlanAndFollowPlans({ appDefinition, app: startedApp = null, config, browser, runtime = null, plan, follows, state }) {
  const ownsApp = !startedApp
  const app = startedApp || await startOrAttach(appDefinition, config)
  if (ownsApp) state.apps = [app]
  const ownsRuntime = !runtime
  const activeRuntime = runtime || await createAppPhaseRuntime(browser, plan.scenario)
  let pageResult = null

  try {
    await prepareRuntimeForScenario(activeRuntime, plan.scenario)
    console.log('[parity-compare] Capturing ' + app.name + ' ' + plan.pageId)
    pageResult = await openAndCapture({
      app,
      context: activeRuntime.context,
      page: activeRuntime.page,
      scenario: plan.scenario,
      pageId: plan.pageId,
      pathName: plan.pathName,
      waitFor: plan.waitFor,
      waitTimeoutMs: config.waitTimeoutMs,
      dataReadyTimeoutMs: config.dataReadyTimeoutMs,
      networkIdleTimeoutMs: config.networkIdleTimeoutMs,
      keepPage: true,
    })

    const followPlans = []
    for (const follow of follows) {
      await waitForFollowLinks(pageResult.page, follow.selector, follow.waitTimeoutMs || config.waitTimeoutMs)
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
      dataReadyTimeoutMs: config.dataReadyTimeoutMs,
      networkIdleTimeoutMs: config.networkIdleTimeoutMs,
      parentWaitFor: plan.waitFor,
    })

    return {
      snapshot: pageResult.snapshot,
      followPlans,
      modalPlans,
    }
  }
  finally {
    if (ownsRuntime) await closeAppPhaseRuntime(activeRuntime)
    if (ownsApp) {
      await stopServer(app.serverProcess)
      state.apps = []
    }
  }
}

async function capturePlanWithModalsSequential({ appDefinition, app: startedApp = null, config, browser, runtime = null, plan, state }) {
  const ownsApp = !startedApp
  const app = startedApp || await startOrAttach(appDefinition, config)
  if (ownsApp) state.apps = [app]
  const ownsRuntime = !runtime
  const activeRuntime = runtime || await createAppPhaseRuntime(browser, plan.scenario)
  let pageResult = null

  try {
    await prepareRuntimeForScenario(activeRuntime, plan.scenario)
    console.log('[parity-compare] Capturing ' + app.name + ' ' + plan.pageId)
    pageResult = await openAndCapture({
      app,
      context: activeRuntime.context,
      page: activeRuntime.page,
      scenario: plan.scenario,
      pageId: plan.pageId,
      pathName: plan.pathName,
      waitFor: plan.waitFor,
      waitTimeoutMs: config.waitTimeoutMs,
      dataReadyTimeoutMs: config.dataReadyTimeoutMs,
      networkIdleTimeoutMs: config.networkIdleTimeoutMs,
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
        dataReadyTimeoutMs: config.dataReadyTimeoutMs,
        networkIdleTimeoutMs: config.networkIdleTimeoutMs,
        parentWaitFor: plan.waitFor,
      }),
    }
  }
  finally {
    if (ownsRuntime) await closeAppPhaseRuntime(activeRuntime)
    if (ownsApp) {
      await stopServer(app.serverProcess)
      state.apps = []
    }
  }
}

async function capturePlanSequential({ appDefinition, app: startedApp = null, config, browser, runtime = null, plan, state, returnResult = false }) {
  const ownsApp = !startedApp
  const app = startedApp || await startOrAttach(appDefinition, config)
  if (ownsApp) state.apps = [app]
  const ownsRuntime = !runtime
  const activeRuntime = runtime || await createAppPhaseRuntime(browser, plan.scenario)

  try {
    await prepareRuntimeForScenario(activeRuntime, plan.scenario)
    console.log('[parity-compare] Capturing ' + app.name + ' ' + plan.pageId)
    const result = await openAndCapture({
      app,
      context: activeRuntime.context,
      page: activeRuntime.page,
      scenario: plan.scenario,
      pageId: plan.pageId,
      pathName: plan.pathName,
      waitFor: plan.waitFor,
      waitTimeoutMs: config.waitTimeoutMs,
      dataReadyTimeoutMs: config.dataReadyTimeoutMs,
      networkIdleTimeoutMs: config.networkIdleTimeoutMs,
    })

    return returnResult ? result : result.snapshot
  }
  finally {
    if (ownsRuntime) await closeAppPhaseRuntime(activeRuntime)
    if (ownsApp) {
      await stopServer(app.serverProcess)
      state.apps = []
    }
  }
}

async function captureModalPlanOnCurrentPage({ app, config, runtime, plan }) {
  console.log('[parity-compare] Capturing ' + app.name + ' ' + plan.pageId)
  const snapshots = await captureModalPlansOnPage({
    page: runtime.page,
    scenario: plan.scenario,
    pageId: plan.parentPageId,
    pathName: plan.pathName,
    appName: app.name,
    waitTimeoutMs: config.waitTimeoutMs,
    dataReadyTimeoutMs: config.dataReadyTimeoutMs,
    networkIdleTimeoutMs: config.networkIdleTimeoutMs,
    parentWaitFor: plan.parentWaitFor,
    onlyModalId: plan.modalId,
  })
  return snapshots[0]?.snapshot || {
    pageId: plan.pageId,
    scenarioId: plan.scenario.id,
    label: plan.label,
    appName: app.name,
    capturedAt: new Date().toISOString(),
    title: '',
    url: runtime.page.url(),
    path: pathFromUrl(runtime.page.url()),
    counts: { tagged: 0, dataPoints: 0, lists: 0 },
    lists: {},
    elements: [],
    captureError: 'Modal capture not found for ' + plan.modalId,
  }
}

async function captureModalPlanSequential({ appDefinition, app: startedApp = null, config, browser, runtime = null, plan, state }) {
  const ownsApp = !startedApp
  const app = startedApp || await startOrAttach(appDefinition, config)
  if (ownsApp) state.apps = [app]
  const ownsRuntime = !runtime
  const activeRuntime = runtime || await createAppPhaseRuntime(browser, plan.scenario)
  let pageResult = null

  try {
    await prepareRuntimeForScenario(activeRuntime, plan.scenario)
    console.log('[parity-compare] Capturing ' + app.name + ' ' + plan.pageId)
    pageResult = await openAndCapture({
      app,
      context: activeRuntime.context,
      page: activeRuntime.page,
      scenario: plan.scenario,
      pageId: plan.parentPageId,
      pathName: plan.pathName,
      waitFor: plan.parentWaitFor,
      waitTimeoutMs: config.waitTimeoutMs,
      dataReadyTimeoutMs: config.dataReadyTimeoutMs,
      networkIdleTimeoutMs: config.networkIdleTimeoutMs,
      keepPage: true,
    })

    const snapshots = await captureModalPlansOnPage({
      page: pageResult.page,
      scenario: plan.scenario,
      pageId: plan.parentPageId,
      pathName: plan.pathName,
      appName: app.name,
      waitTimeoutMs: config.waitTimeoutMs,
      dataReadyTimeoutMs: config.dataReadyTimeoutMs,
      networkIdleTimeoutMs: config.networkIdleTimeoutMs,
      parentWaitFor: plan.parentWaitFor,
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
    if (ownsRuntime) await closeAppPhaseRuntime(activeRuntime)
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

async function openAndCapture({
  app,
  context,
  page: reusablePage = null,
  scenario,
  pageId,
  pathName,
  waitFor,
  waitTimeoutMs,
  dataReadyTimeoutMs = DEFAULT_DATA_READY_TIMEOUT_MS,
  networkIdleTimeoutMs = DEFAULT_NETWORK_IDLE_TIMEOUT_MS,
  keepPage = false,
}) {
  const page = reusablePage || await context.newPage()
  const ownsPage = !reusablePage
  const url = new URL(pathName, app.baseUrl)
  const captureStartedAt = Date.now()
  const consoleMessages = []
  const rateLimitResponses = []

  const onConsole = (message) => {
    if (!['error', 'warning'].includes(message.type())) return
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location(),
    })
  }

  const onResponse = (response) => {
    if (response.status() !== 429) return
    rateLimitResponses.push({
      url: response.url(),
      status: response.status(),
    })
  }

  page.on('console', onConsole)
  page.on('response', onResponse)

  try {
    const effectiveWaitTimeoutMs = effectiveWaitTimeout(scenario, pathName, waitTimeoutMs)
    const effectiveDataReadyTimeoutMs = effectiveDataReadyTimeout(scenario, pathName, dataReadyTimeoutMs)
    const captureBudgetMs = effectiveCaptureBudget(scenario, pathName)
    let waitError = null
    let readinessError = null
    let actionError = null
    let listHydrationError = null
    let pendingReadiness = []
    let navigationError = null
    let navigationKind = null
    const navigationTimeoutMs = Number(scenario.navigationTimeoutMs || effectiveWaitTimeoutMs || 45_000)
    const maxAttempts = Math.max(
      1,
      Number(scenario.rateLimitRetries ?? 0) || 1,
      Number(scenario.navigationRetries ?? 0) || 1,
    )

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      waitError = null
      readinessError = null
      actionError = null
      listHydrationError = null
      pendingReadiness = []
      navigationError = null
      navigationKind = null
      rateLimitResponses.length = 0

      try {
        navigationKind = await navigateForCapture(page, url, {
          timeout: navigationTimeoutMs,
          forceDocumentNavigation: ownsPage || reusablePage?._parityForceDocumentNavigation || scenario.forceDocumentNavigation,
        })
        if (reusablePage?._parityForceDocumentNavigation) {
          reusablePage._parityForceDocumentNavigation = false
        }
      }
      catch (error) {
        navigationError = error.message
      }

      if (!navigationError) {
        try {
          await waitForSelectors(page, waitFor, effectiveWaitTimeoutMs)
        }
        catch (error) {
          waitError = error.message
        }
      }

      if (!navigationError && !waitError) {
        try {
          await waitForPageDataReady(page, scenario, effectiveDataReadyTimeoutMs)
        }
        catch (error) {
          readinessError = error.message
          pendingReadiness = await pendingReadinessMarkers(page).catch(() => [])
        }
      }

      if (!navigationError && !waitError && !readinessError && scenario.actions?.length) {
        try {
          await performScenarioActions(page, scenario, {
            waitTimeoutMs: effectiveWaitTimeoutMs,
            dataReadyTimeoutMs: effectiveDataReadyTimeoutMs,
          })
        }
        catch (error) {
          actionError = error.message
        }
      }

      const scenarioNetworkIdleTimeoutMs = scenario.networkIdleTimeoutMs ?? scenario.defaults?.networkIdleTimeoutMs
      const effectiveNetworkIdleTimeoutMs = Number(
        scenarioNetworkIdleTimeoutMs ?? networkIdleTimeoutMs ?? DEFAULT_NETWORK_IDLE_TIMEOUT_MS,
      )
      if (effectiveNetworkIdleTimeoutMs > 0) {
        await page.waitForLoadState('networkidle', { timeout: effectiveNetworkIdleTimeoutMs }).catch(() => {})
      }
      await page.waitForTimeout(scenario.settleMs ?? scenario.defaults?.settleMs ?? 0)

      if (!navigationError && !waitError && !readinessError && !actionError) {
        try {
          const list = listCaptureInfo(pathName)
          if (list?.showAll) {
            const remainingMinCaptureMs = LIST_SHOW_ALL_MIN_CAPTURE_MS - (Date.now() - captureStartedAt)
            if (remainingMinCaptureMs > 0) {
              await page.waitForTimeout(remainingMinCaptureMs)
            }
          }
          await hydrateListPageBeforeScrape(page, pathName)
        }
        catch (error) {
          listHydrationError = error.message || String(error)
        }
      }

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
        compareOptions: scenarioCompareOptions(scenario),
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
        compareOptions: scenarioCompareOptions(scenario),
      })
    }

    snapshot.requestedPath = pathName
    snapshot.waitFor = waitFor || []
    snapshot.navigationKind = navigationKind
    snapshot.url = url.href
    snapshot.path = url.pathname + url.search
    snapshot.captureDurationMs = Date.now() - captureStartedAt
    snapshot.captureBudgetMs = captureBudgetMs
    snapshot.slowCapture = snapshot.captureDurationMs > captureBudgetMs
    snapshot.captureError = navigationError
      ? 'Navigation failed after ' + maxAttempts + ' attempt(s): ' + navigationError
      : missingSelectors.length
        ? waitError + '\nMissing after final scrape: ' + missingSelectors.join(', ')
        : readinessError
          ? readinessError + (pendingReadiness.length ? '\nPending data readiness: ' + pendingReadiness.join(', ') : '')
          : actionError
            ? actionError
            : listHydrationError
              ? 'List hydration failed: ' + listHydrationError
              : rateLimitResponses.length
                ? 'HTTP 429 responses observed: ' + rateLimitResponses.map(item => item.url).join(', ')
                : snapshot.captureError || null
    snapshot.console = consoleMessages
    snapshot.rateLimitResponses = rateLimitResponses

    if (keepPage || !ownsPage) {
      return { page, snapshot }
    }

    await page.close()
    return { page: null, snapshot }
  }
  finally {
    page.off('console', onConsole)
    page.off('response', onResponse)
  }
}

async function performScenarioActions(page, scenario, { waitTimeoutMs, dataReadyTimeoutMs }) {
  for (const [index, action] of (scenario.actions || []).entries()) {
    const actionLabel = action.label || action.type || ('action-' + (index + 1))
    const timeout = Number(action.timeoutMs ?? waitTimeoutMs)

    if (action.type === 'wait') {
      await page.waitForTimeout(Number(action.ms ?? action.waitMs ?? 0))
      continue
    }

    if (action.type === 'waitFor') {
      await waitForSelectors(page, [action.selector], timeout)
      continue
    }

    if (action.type === 'click') {
      const locator = page.locator(action.selector)
      const targetIndex = Number(action.index ?? 0)
      if (action.skipIfPresent) {
        const skipCount = await page.locator(action.skipIfPresent).count()
        if (skipCount > 0) {
          if (action.waitFor?.length) {
            await waitForSelectors(page, action.waitFor, timeout)
          }
          if (action.settleMs !== undefined) {
            await page.waitForTimeout(Number(action.settleMs))
          }
          if (action.waitForData !== false) {
            await waitForPageDataReady(page, scenario, Number(action.dataReadyTimeoutMs ?? dataReadyTimeoutMs))
          }
          continue
        }
      }
      if (action.optional) {
        const count = await locator.count()
        if (count <= targetIndex) {
          if (action.waitFor?.length) {
            await waitForSelectors(page, action.waitFor, timeout)
          }
          if (action.settleMs !== undefined) {
            await page.waitForTimeout(Number(action.settleMs))
          }
          if (action.waitForData !== false) {
            await waitForPageDataReady(page, scenario, Number(action.dataReadyTimeoutMs ?? dataReadyTimeoutMs))
          }
          continue
        }
      }
      await locator.nth(targetIndex).click({ timeout })
      if (action.waitFor?.length) {
        await waitForSelectors(page, action.waitFor, timeout)
      }
      if (action.settleMs !== undefined) {
        await page.waitForTimeout(Number(action.settleMs))
      }
      if (action.waitForData !== false) {
        await waitForPageDataReady(page, scenario, Number(action.dataReadyTimeoutMs ?? dataReadyTimeoutMs))
      }
      continue
    }

    throw new Error('Unsupported scenario action "' + actionLabel + '"')
  }
}

async function navigateForCapture(page, url, { timeout, forceDocumentNavigation = false } = {}) {
  const targetPath = url.pathname + url.search + url.hash
  const currentUrl = page.url()
  const canUseSpaNavigation = !forceDocumentNavigation
    && currentUrl
    && currentUrl !== 'about:blank'
    && originOf(currentUrl) === originOf(url.href)

  if (canUseSpaNavigation) {
    const result = await page.evaluate(async (pathName) => {
      const nuxt = window.$nuxt || window.useNuxtApp?.()
      const router = nuxt?.$router || nuxt?.vueApp?.config?.globalProperties?.$router
      if (!router?.push) return { ok: false, reason: 'router-unavailable' }
      await router.push(pathName)
      await router.isReady?.()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return { ok: true }
    }, targetPath).catch(error => ({ ok: false, reason: error?.message || String(error) }))

    if (result?.ok) return 'spa'
  }

  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout })
  return 'document'
}

function scenarioCompareOptions(scenario = {}) {
  return {
    ignoreListDataPointsOnListPage: scenario.ignoreListDataPointsOnListPage || [],
  }
}

function createFailedSnapshot({ pageId, scenarioId, label, appName, url, pathName, error, compareOptions = {} }) {
  return {
    pageId,
    scenarioId,
    label,
    appName,
    compareOptions,
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
    try {
      await page.waitForSelector(selector, { state: 'attached', timeout })
    }
    catch (error) {
      throw new Error('Timed out waiting for selector "' + selector + '": ' + (error?.message || String(error)))
    }
  }
}

async function missingWaitSelectors(page, selectors = []) {
  return page.evaluate((items) => {
    return (items || []).filter(selector => !document.querySelector(selector))
  }, selectors || [])
}

async function waitForPageDataReady(page, scenario, timeout = DEFAULT_DATA_READY_TIMEOUT_MS) {
  const effectiveTimeout = Number(timeout)
  if (!Number.isFinite(effectiveTimeout) || effectiveTimeout <= 0) return

  const deadline = Date.now() + effectiveTimeout
  let pending = await pendingReadinessMarkersWithRetry(page, deadline)
  while (pending.length && Date.now() < deadline) {
    await page.waitForTimeout(100)
    pending = await pendingReadinessMarkersWithRetry(page, deadline)
  }
  if (pending.length) {
    throw new Error('Page data did not become ready within ' + effectiveTimeout + 'ms')
  }
}

function effectiveWaitTimeout(scenario, pathName, fallback) {
  const baseTimeout = Number(scenario.waitTimeoutMs ?? scenario.defaults?.waitTimeoutMs ?? (isPortfolioCapture(scenario, pathName) ? DEFAULT_PORTFOLIO_TIMEOUT_MS : fallback))
  return listCaptureInfo(pathName)?.showAll ? Math.max(baseTimeout, LIST_SHOW_ALL_HYDRATION_TIMEOUT_MS) : baseTimeout
}

function effectiveDataReadyTimeout(scenario, pathName, fallback) {
  const baseTimeout = Number(scenario.dataReadyTimeoutMs ?? scenario.defaults?.dataReadyTimeoutMs ?? (isPortfolioCapture(scenario, pathName) ? DEFAULT_PORTFOLIO_TIMEOUT_MS : fallback))
  return listCaptureInfo(pathName)?.showAll ? Math.max(baseTimeout, LIST_SHOW_ALL_HYDRATION_TIMEOUT_MS) : baseTimeout
}

function effectiveCaptureBudget(scenario, pathName) {
  const baseBudget = Number(scenario.captureBudgetMs ?? scenario.defaults?.captureBudgetMs ?? (isPortfolioCapture(scenario, pathName) ? DEFAULT_PORTFOLIO_CAPTURE_BUDGET_MS : DEFAULT_CAPTURE_BUDGET_MS))
  return listCaptureInfo(pathName)?.showAll ? Math.max(baseBudget, LIST_SHOW_ALL_HYDRATION_TIMEOUT_MS) : baseBudget
}

function isPortfolioCapture(scenario, pathName = '') {
  return String(scenario?.id || '').includes('portfolio') || String(pathName || '').includes('/portfolio')
}

function listCaptureInfo(pathName = '') {
  let url
  try {
    url = new URL(String(pathName || ''), 'http://parity.local')
  }
  catch {
    return null
  }

  if (url.pathname === '/borrow') {
    return {
      listName: 'borrow-pair',
      selector: '[data-id="vault-list"][data-list="borrow-pair"], [data-list="borrow-pair"]',
      itemSelector: '[data-list="borrow-pair"][data-key]',
      showAll: isShowAllQuery(url.searchParams),
    }
  }

  if (url.pathname === '/lend') {
    return {
      listName: 'lend',
      selector: '[data-id="vault-list"][data-list="lend"], [data-list="lend"]',
      itemSelector: '[data-list="lend"][data-key]',
      showAll: isShowAllQuery(url.searchParams),
    }
  }

  return null
}

function isShowAllQuery(searchParams) {
  const values = searchParams.getAll('showAll')
  if (!values.length) return false
  return values.some((value) => {
    const normalized = String(value ?? '').trim().toLowerCase()
    return normalized === '' || normalized === '1' || normalized === 'true'
  })
}

async function hydrateListPageBeforeScrape(page, pathName) {
  const list = listCaptureInfo(pathName)
  if (!list) return

  const timeoutMs = list.showAll ? LIST_SHOW_ALL_HYDRATION_TIMEOUT_MS : DEFAULT_WAIT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  await page.waitForSelector(list.selector, { state: 'attached', timeout: Math.max(1, timeoutMs) })

  let stableRounds = 0
  let previousSignature = ''

  do {
    await scrollListPage(page)
    const state = await listHydrationState(page, list)
    const signature = state.itemCount + ':' + state.containerCount + ':' + state.scrollHeight

    if (signature === previousSignature) {
      stableRounds += 1
    }
    else {
      stableRounds = 0
      previousSignature = signature
    }

    if (!list.showAll || stableRounds >= LIST_HYDRATION_SETTLE_ROUNDS) break
    await page.waitForTimeout(LIST_HYDRATION_SCROLL_DELAY_MS)
  } while (Date.now() < deadline)
}

async function scrollListPage(page) {
  await page.evaluate(async ({ segments, delayMs }) => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const scrollElement = document.scrollingElement || document.documentElement

    for (let index = 1; index <= segments; index += 1) {
      const maxScrollTop = Math.max(0, scrollElement.scrollHeight - window.innerHeight)
      scrollElement.scrollTo(0, Math.round(maxScrollTop * (index / segments)))
      await sleep(delayMs)
    }
  }, {
    segments: LIST_HYDRATION_SCROLL_SEGMENTS,
    delayMs: LIST_HYDRATION_SCROLL_DELAY_MS,
  })
}

async function listHydrationState(page, list) {
  return page.evaluate(({ itemSelector, selector }) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const container = document.querySelector(selector)
    return {
      itemCount: Array.from(document.querySelectorAll(itemSelector)).filter(visible).length,
      containerCount: Number(container?.getAttribute('data-count') || 0),
      scrollHeight: document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight || 0,
    }
  }, {
    itemSelector: list.itemSelector,
    selector: list.selector,
  })
}

async function pendingReadinessMarkers(page) {
  return page.evaluate(pendingParityReadinessMarkers)
}

async function pendingReadinessMarkersWithRetry(page, deadline) {
  while (true) {
    try {
      return await pendingReadinessMarkers(page)
    }
    catch (error) {
      const message = error?.message || String(error)
      if (!message.includes('Execution context was destroyed') || Date.now() >= deadline) throw error
      await page.waitForTimeout(100)
    }
  }
}

function pendingParityReadinessMarkers() {
  const isVisible = (element) => {
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const textOf = element => String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
  const markers = []

  for (const element of Array.from(document.querySelectorAll('[aria-busy="true"], [data-loading="true"], [data-parity-loading]'))) {
    if (isVisible(element)) markers.push(element.getAttribute('data-field') || element.getAttribute('data-id') || element.tagName.toLowerCase())
  }

  for (const element of Array.from(document.querySelectorAll('.animate-pulse'))) {
    if (!isVisible(element)) continue
    const text = textOf(element)
    if (text === '...' || text.toLowerCase().includes('loading')) {
      markers.push('loading-pulse:' + (element.closest('[data-field]')?.getAttribute('data-field') || text || element.tagName.toLowerCase()))
    }
  }

  for (const element of Array.from(document.querySelectorAll('div'))) {
    if (!isVisible(element)) continue
    const classes = element.classList
    if (
      classes.contains('w-80')
      && classes.contains('h-20')
      && classes.contains('rounded-12')
      && classes.contains('bg-neutral-300/10')
    ) {
      markers.push('loadable-content-skeleton')
    }
  }

  return Array.from(new Set(markers)).slice(0, 20)
}

async function waitForFollowLinks(page, selector, timeout = 45_000) {
  if (!selector) return

  await page.waitForFunction((itemSelector) => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    return Array.from(document.querySelectorAll(itemSelector))
      .some((element) => {
        if (!isVisible(element)) return false
        const anchor = element.closest('a') || (element.tagName === 'A' ? element : null)
        return !!anchor?.href
      })
  }, selector, { timeout }).catch(() => {})
}

async function captureModalPlansOnPage({
  page,
  scenario,
  pageId,
  pathName,
  appName,
  waitTimeoutMs,
  dataReadyTimeoutMs = DEFAULT_DATA_READY_TIMEOUT_MS,
  parentWaitFor = null,
  onlyModalId = null,
}) {
  const modalCaptures = scenario.modals || []
  const snapshots = []
  const effectiveModalWaitTimeoutMs = effectiveWaitTimeout(scenario, pathName, waitTimeoutMs)

  for (const modal of modalCaptures) {
    const locator = page.locator(modal.selector)
    const count = await locator.count().catch(() => 0)
    const maxItems = Math.min(count, modal.maxItems ?? 1)

    for (let index = 0; index < maxItems; index += 1) {
      const modalId = modal.id + '-' + String(index + 1).padStart(2, '0')
      if (onlyModalId && modalId !== onlyModalId) continue

      console.log('[parity-compare] ' + pageId + ' modal ' + modal.id + ': 1 capture(s)')
      const modalPageId = pageId + '/modal/' + sanitizeFilePart(modalId)
      const label = (modal.label || modal.id) + ' ' + (index + 1)
      const captureStartedAt = Date.now()
      let captureError = null

      try {
        await locator.nth(index).click({ timeout: effectiveModalWaitTimeoutMs })
        await waitForSelectors(page, modal.waitFor || ['[data-id="data-point"]'], effectiveModalWaitTimeoutMs)
        await waitForPageDataReady(page, scenario, modal.dataReadyTimeoutMs ?? dataReadyTimeoutMs)
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
        compareOptions: scenarioCompareOptions(scenario),
      })
      snapshot.requestedPath = pathName
      snapshot.waitFor = parentWaitFor || scenario.waitFor || []
      snapshot.parentWaitFor = parentWaitFor || scenario.waitFor || []
      snapshot.path = new URL(page.url()).pathname + new URL(page.url()).search
      snapshot.captureDurationMs = Date.now() - captureStartedAt
      snapshot.captureBudgetMs = effectiveCaptureBudget(scenario, pathName)
      snapshot.slowCapture = snapshot.captureDurationMs > snapshot.captureBudgetMs
      snapshot.captureError = captureError
      snapshot.console = []

      snapshots.push({
        modalId,
        pageId: modalPageId,
        parentPageId: pageId,
        pathName,
        parentWaitFor: parentWaitFor || scenario.waitFor,
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
  const structuralContainerIds = new Set([
    'discovery-market-list',
    'discovery-market-list-item',
    'discovery-market-card',
    'discovery-market-expanded',
    'discovery-matrix-view-select',
    'discovery-graph',
    'attribute-matrix',
    'collateral-matrix',
  ])
  const listContainerOnlyIds = new Set([
    'discovery-market-expanded',
    'discovery-matrix-view-select',
    'attribute-matrix',
    'collateral-matrix',
  ])
  const keylessContainerIds = new Set([
    'discovery-market-expanded',
    'discovery-matrix-view-select',
    'attribute-matrix',
    'collateral-matrix',
  ])
  const isStructuralContainer = attrs => structuralContainerIds.has(attrs.id || '')
  const isListContainerOnly = element => listContainerOnlyIds.has(element.id || '')
  const comparableText = (element) => {
    const ignoredNodes = Array
      .from(element.querySelectorAll('[data-label], [data-parity-ignore], img, svg, .relative.flex.items-center.shrink-0'))
      .map(node => ({ node, display: node.style.display }))

    ignoredNodes.forEach(({ node }) => {
      node.style.display = 'none'
    })

    try {
      return normalize(element.innerText || element.textContent || '')
    }
    finally {
      ignoredNodes.forEach(({ node, display }) => {
        node.style.display = display
      })
    }
  }
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
  const inferredListFor = (attrs) => {
    if (attrs.list) return attrs.list
    const id = attrs.id || ''
    if (id === 'discovery-market-list' || id === 'discovery-market-list-item') return 'discovery-market'
    if (id === 'discovery-market-expanded') return 'discovery-market-expanded'
    if (id === 'discovery-matrix-view-select') return 'discovery-matrix-view-select'
    if (id === 'discovery-view-toggle') return 'discovery-view-toggle'
    if (id === 'discovery-graph' || id === 'discovery-graph-node' || id === 'discovery-graph-edge') return id
    if (id === 'attribute-matrix'
      || id === 'attribute-matrix-column'
      || id === 'attribute-matrix-row'
      || id === 'attribute-matrix-row-header'
      || id === 'attribute-matrix-cell') return id
    if (id === 'collateral-matrix'
      || id === 'collateral-matrix-column'
      || id === 'collateral-matrix-row'
      || id === 'collateral-matrix-row-header'
      || id === 'collateral-matrix-cell') return id
    return ''
  }
  const baseKeyFor = attrs => [
    attrs.id || '',
    attrs.list || '',
    keylessContainerIds.has(attrs.id || '') ? '' : (attrs.key || ''),
    keylessContainerIds.has(attrs.id || '') ? '' : (attrs.field || ''),
  ].join('|')
  const occurrenceByBaseKey = new Map()

  const elements = Array.from(document.querySelectorAll('[data-id]'))
    .filter(isVisible)
    .map((element, index) => {
      const attrs = dataAttrs(element)
      const inferredList = inferredListFor(attrs)
      if (inferredList) attrs.list = inferredList
      const baseKey = baseKeyFor(attrs)
      const occurrence = occurrenceByBaseKey.get(baseKey) || 0
      occurrenceByBaseKey.set(baseKey, occurrence + 1)
      const text = comparableText(element)
      const rect = element.getBoundingClientRect()
      const hasDataValue = Object.prototype.hasOwnProperty.call(attrs, 'value')
      const compareValue = hasDataValue
        ? attrs.value
        : isStructuralContainer(attrs)
          ? ''
          : text

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
        compareValue,
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

  const listItems = elements.filter(element => element.list && element.itemKey && !isListContainerOnly(element))
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

  for (const element of elements.filter(item => item.list && (!item.itemKey || isListContainerOnly(item)))) {
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
    compareOptions: meta.compareOptions || {},
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
        slowCaptures: baseline.slowCapture ? 1 : 0,
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
    requestedPath: baseline.requestedPath || baseline.path,
    waitFor: baseline.waitFor || [],
    parentWaitFor: baseline.parentWaitFor || baseline.waitFor || [],
    captureDurationsMs: {
      baseline: baseline.captureDurationMs ?? null,
      candidate: candidate.captureDurationMs ?? null,
      baselineBudget: baseline.captureBudgetMs ?? null,
      candidateBudget: candidate.captureBudgetMs ?? null,
    },
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
      slowCaptures: [baseline, candidate].filter(snapshot => snapshot?.slowCapture).length,
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
  const ignoredLists = ignoredListDataPointsForSnapshot(baseline)

  return listNames
    .filter(list => !isIgnoredListDataPoint(list, ignoredLists))
    .map((list) => {
      const base = baselineLists[list] || { keys: [], count: 0, containers: [] }
      const cand = candidateLists[list] || { keys: [], count: 0, containers: [] }
      const missingKeys = base.keys.filter(key => !cand.keys.includes(key))
      const extraKeys = cand.keys.filter(key => !base.keys.includes(key))
      const orderMismatch = !sameArray(base.keys, cand.keys)
      const containerMismatch = JSON.stringify(base.containers) !== JSON.stringify(cand.containers)
      const instrumentationOnly = isCandidateOnlyExploreInstrumentationList(list, base, cand, baseline.elements || [])
      const status = instrumentationOnly || !(missingKeys.length || extraKeys.length || orderMismatch || containerMismatch) ? 'match' : 'list-mismatch'

      return {
        list,
        status,
        instrumentationOnly,
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
  const ignoredLists = ignoredListDataPointsForSnapshot(baseline)
  const baselineElements = elementsForComparison(
    filterIgnoredListDataPointElements(baseline.elements, ignoredLists),
    routeVaultContextKey(baseline.path || baseline.requestedPath || ''),
  )
  const candidateElements = elementsForComparison(
    filterIgnoredListDataPointElements(candidate.elements, ignoredLists),
    routeVaultContextKey(candidate.path || candidate.requestedPath || ''),
  )
  const baselineMap = new Map(baselineElements.map(element => [element.key, element]))
  const candidateMap = new Map(candidateElements.map(element => [element.key, element]))
  const keys = Array.from(new Set([...baselineMap.keys(), ...candidateMap.keys()])).sort()
  const numericTolerance = config.numericTolerance ?? DEFAULT_NUMERIC_TOLERANCE

  return keys.map((key) => {
    const base = baselineMap.get(key)
    const cand = candidateMap.get(key)

    if (!base) {
      if (isCandidateOnlyExploreInstrumentationElement(cand, baselineElements)) {
        return {
          key,
          baseKey: cand.baseKey,
          status: 'match',
          candidate: summarizeElement(cand),
          instrumentationOnly: true,
        }
      }
      return {
        key,
        baseKey: cand.baseKey,
        status: 'extra-in-candidate',
        candidate: summarizeElement(cand),
      }
    }

    if (!cand) {
      if (isBaselineOnlyExploreInstrumentationElement(base, candidateElements)) {
        return {
          key,
          baseKey: base.baseKey,
          status: 'match',
          baseline: summarizeElement(base),
          instrumentationOnly: true,
        }
      }
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

    if (isStructuralContainerElement(base) && isStructuralContainerElement(cand)) {
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

function ignoredListDataPointsForSnapshot(snapshot) {
  if (!isScenarioListPageSnapshot(snapshot)) return []
  return normalizeIgnoredListDataPoints(snapshot.compareOptions?.ignoreListDataPointsOnListPage)
}

function isScenarioListPageSnapshot(snapshot) {
  if (!snapshot?.pageId || !snapshot.scenarioId) return false
  return snapshot.pageId === snapshot.scenarioId || snapshot.pageId.startsWith(snapshot.scenarioId + '/modal/')
}

function normalizeIgnoredListDataPoints(value) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => typeof item === 'string' ? { listPrefix: item } : item)
    .filter(Boolean)
    .map(item => ({
      listPrefix: String(item.listPrefix || item.list || '').replace(/\*$/, ''),
      fields: Array.isArray(item.fields) ? item.fields.map(String) : [],
    }))
    .filter(item => item.listPrefix || item.fields.length)
}

function isIgnoredListDataPoint(list, ignoredLists) {
  return ignoredLists.some(ignored => ignored.listPrefix && String(list || '').startsWith(ignored.listPrefix))
}

function filterIgnoredListDataPointElements(elements = [], ignoredLists = []) {
  if (!ignoredLists.length) return elements || []
  return (elements || []).filter(element => !isIgnoredListDataPointElement(element, ignoredLists))
}

function isIgnoredListDataPointElement(element, ignoredLists) {
  if (element?.id !== 'data-point') return false
  return ignoredLists.some((ignored) => {
    const listMatches = ignored.listPrefix && String(element.list || '').startsWith(ignored.listPrefix)
    const fieldMatches = ignored.fields.length && ignored.fields.includes(String(element.field || ''))
    return listMatches && (!ignored.fields.length || fieldMatches)
  })
}

const STRUCTURAL_CONTAINER_COMPARE_IDS = new Set([
  'discovery-market-list',
  'discovery-market-list-item',
  'discovery-market-card',
  'discovery-market-expanded',
  'discovery-matrix-view-select',
  'discovery-graph',
  'attribute-matrix',
  'collateral-matrix',
])

function isStructuralContainerElement(element) {
  return Boolean(
    STRUCTURAL_CONTAINER_COMPARE_IDS.has(element?.id)
    && !Object.prototype.hasOwnProperty.call(element.attrs || {}, 'value'),
  )
}

function elementsForComparison(elements = [], routeContextKey = '') {
  const headers = elements
    .filter(element => element.id === 'vault-header' && element.itemKey && element.rect)
    .slice()
    .sort(compareElementPosition)

  if (!headers.length) return elements

  const occurrenceByBaseKey = new Map()

  return elements.map((element) => {
    const contextualBaseKey = contextualDataPointBaseKey(element, headers, routeContextKey)
    if (!contextualBaseKey) return element

    const occurrence = occurrenceByBaseKey.get(contextualBaseKey) || 0
    occurrenceByBaseKey.set(contextualBaseKey, occurrence + 1)

    return {
      ...element,
      key: contextualBaseKey + '#' + occurrence,
      baseKey: contextualBaseKey,
      occurrence,
      attrs: {
        ...element.attrs,
        'parity-context': 'vault-header',
      },
    }
  })
}

const ROUTE_VAULT_CONTEXT_FIELDS = new Set([
  'Available liquidity',
  'Bad debt socialisation',
  'Base rate',
  'Borrow APY',
  'Borrow cap',
  'Can be borrowed',
  'Can be used as collateral',
  'Cycle length',
  'Disabled operations',
  'Fee receiver',
  'Fixed APY',
  'Fixed rate cycle',
  'Hook target',
  'Hooked operations',
  'Interest fee',
  'Interest rate model',
  'Kink',
  'Liquidation bonus',
  'Market',
  'Max rate',
  'Oracle router',
  'Price',
  'Projected earnings per month',
  'Rate at kink',
  'Repayment APY',
  'Repayment window',
  'Risk manager',
  'Share token exchange rate',
  'Supply APY',
  'Supply cap',
  'Total borrowed',
  'Total supply',
  'Unit of account',
  'Utilization',
  'Vault type',
  'borrow-apy-base',
  'borrow-apy-intrinsic',
  'borrow-apy-intrinsic-provider',
  'borrow-apy-intrinsic-source',
  'borrow-apy-rewards-total',
  'borrow-apy-total',
  'supply-apy-base',
  'supply-apy-base-average-label',
  'supply-apy-intrinsic',
  'supply-apy-intrinsic-provider',
  'supply-apy-intrinsic-source',
  'supply-apy-rewards-total',
  'supply-apy-total',
])

function contextualDataPointBaseKey(element, headers, routeContextKey = '') {
  if (element.id !== 'data-point') return ''
  if (element.list || element.itemKey) return ''
  if (!element.rect) return ''

  const field = contextualDataPointField(element)
  if (!field) return ''

  const contextKey = shouldUseRouteVaultContext(field, routeContextKey)
    ? routeContextKey
    : nearestPrecedingVaultHeader(element, headers)?.itemKey
  if (!contextKey) return ''

  return [
    element.id || '',
    'vault-header-context',
    contextKey,
    field,
  ].join('|')
}

function routeVaultContextKey(pathValue) {
  const path = String(pathValue || '').split('?')[0]
  const addressPattern = '0x[0-9a-fA-F]{40}'
  const lendOrEarn = path.match(new RegExp('^/(?:lend|earn)/(' + addressPattern + ')(?:/|$)'))
  if (lendOrEarn) return lendOrEarn[1].toLowerCase()

  const borrow = path.match(new RegExp('^/borrow/(' + addressPattern + ')/(' + addressPattern + ')(?:/|$)'))
  if (borrow) return borrow[1].toLowerCase() + ':' + borrow[2].toLowerCase()

  return ''
}

function shouldUseRouteVaultContext(field, routeContextKey) {
  if (!routeContextKey) return false
  if (ROUTE_VAULT_CONTEXT_FIELDS.has(field)) return true
  if (/^[A-Za-z0-9.+-]+ (?:debt|token|vault)$/.test(field)) return true
  return false
}

function nearestPrecedingVaultHeader(element, headers) {
  let candidate
  for (const header of headers) {
    if (compareElementPosition(header, element) > 0) break
    candidate = header
  }
  return candidate
}

function contextualDataPointField(element) {
  if (element.field) return element.field

  const text = String(element.text || '')
  const firstLine = text
    .split(/\n+/)
    .map(item => item.trim())
    .find(Boolean)
  if (firstLine) return firstLine

  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.split(/\s{2,}/)[0] || ''
}

function compareElementPosition(a, b) {
  const ay = Number(a?.rect?.y ?? a?.index ?? 0)
  const by = Number(b?.rect?.y ?? b?.index ?? 0)
  if (ay !== by) return ay - by

  const ax = Number(a?.rect?.x ?? 0)
  const bx = Number(b?.rect?.x ?? 0)
  if (ax !== bx) return ax - bx

  return Number(a?.index ?? 0) - Number(b?.index ?? 0)
}

function isStructuralListElement(element) {
  return Boolean(
    element?.list
    && element.id !== 'data-point'
    && !element.field
    && !Object.prototype.hasOwnProperty.call(element.attrs || {}, 'value'),
  )
}

const EXPLORE_INSTRUMENTATION_LISTS = new Set([
  'discovery-graph',
  'discovery-graph-node',
  'discovery-graph-edge',
  'discovery-view-toggle',
  'discovery-market-expanded',
  'discovery-matrix-view-select',
  'attribute-matrix',
  'attribute-matrix-column',
  'attribute-matrix-row',
  'attribute-matrix-row-header',
  'attribute-matrix-cell',
  'collateral-matrix',
  'collateral-matrix-column',
  'collateral-matrix-row',
  'collateral-matrix-row-header',
  'collateral-matrix-cell',
])

function isCandidateOnlyExploreInstrumentationList(list, base, cand, baselineElements) {
  if (!EXPLORE_INSTRUMENTATION_LISTS.has(list)) return false
  if (base.count || base.keys.length || base.containers.length) return false
  if (!cand.count && !cand.keys.length && !cand.containers.length) return false
  return !baselineElements.some(element => element.list === list || element.id === list)
}

function isCandidateOnlyExploreInstrumentationElement(candidate, baselineElements) {
  if (!EXPLORE_INSTRUMENTATION_LISTS.has(candidate?.list)) return false
  return !baselineElements.some(element => element.list === candidate.list || element.id === candidate.id)
}

function isBaselineOnlyExploreInstrumentationElement(baseline, candidateElements) {
  if (!EXPLORE_INSTRUMENTATION_LISTS.has(baseline?.list)) return false
  return !candidateElements.some(element => element.list === baseline.list || element.id === baseline.id)
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

  const diff = {
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
      slowCaptures: pageDiffs.reduce((total, page) => total + (page.summary.slowCaptures || 0), 0),
      missingInCandidate: pageDiffs.reduce((total, page) => total + page.summary.missingInCandidate, 0),
      extraInCandidate: pageDiffs.reduce((total, page) => total + page.summary.extraInCandidate, 0),
      valueMismatches: pageDiffs.reduce((total, page) => total + page.summary.valueMismatches, 0),
      numericTolerance: config.numericTolerance,
    },
    pages: pageDiffs,
    pagesWithDiscrepancies: summarizeDiscrepantPages(failedPages),
  }
  return diff
}

async function writeIncrementalJsonArtifacts({ run, config, baselineSnapshots, candidateSnapshots, pageDiffs }) {
  const diff = buildDiff({
    run,
    config,
    outputDir: config.outputDir,
    baselineSnapshots,
    candidateSnapshots,
    pageDiffs,
  })

  await Promise.all([
    writeJson(path.join(config.outputDir, 'baseline.json'), {
      app: run.baseline,
      snapshots: baselineSnapshots,
    }),
    writeJson(path.join(config.outputDir, 'candidate.json'), {
      app: run.candidate,
      snapshots: candidateSnapshots,
    }),
    writeJson(path.join(config.outputDir, 'diff.json'), diff),
    fs.writeFile(path.join(ROOT_DIR, 'artifacts/parity/latest-run.json'), JSON.stringify({
      runId: config.runId,
      outputDir: config.outputDir,
      diff: path.join(config.outputDir, 'diff.json'),
      report: path.join(config.outputDir, 'report.html'),
    }, null, 2) + '\n'),
  ])
}

function createScrapeFailureGuard(config) {
  return {
    consecutive: 0,
    observe(snapshot) {
      const reason = scrapeFailureReason(snapshot)
      if (!reason) {
        this.consecutive = 0
        return
      }

      this.consecutive += 1
      const limit = Math.max(1, Number(config.scrapeFailureLimit || DEFAULT_SCRAPE_FAILURE_LIMIT))
      console.warn('[parity-compare] Scrape failed '
        + this.consecutive + '/' + limit
        + ' for ' + (snapshot?.appName || 'unknown')
        + ' ' + (snapshot?.pageId || 'unknown page')
        + ': ' + reason)

      if (this.consecutive >= limit) {
        throw new Error('Stopping after ' + this.consecutive + ' consecutive scrape failures. Last failure: '
          + (snapshot?.appName || 'unknown') + ' '
          + (snapshot?.pageId || 'unknown page') + ': ' + reason)
      }
    },
  }
}

function scrapeFailureReason(snapshot) {
  if (!snapshot) return 'missing snapshot'
  if (snapshot.captureError) return String(snapshot.captureError).split('\n')[0]
  if (Number(snapshot.counts?.tagged || 0) === 0) return '0 tagged elements scraped'
  return ''
}

function summarizeDiscrepantPages(pages) {
  return pages.map(page => ({
    pageId: page.pageId,
    scenarioId: page.scenarioId,
    label: page.label,
    path: page.path,
    baselineUrl: page.baselineUrl,
    candidateUrl: page.candidateUrl,
    requestedPath: page.requestedPath,
    waitFor: page.waitFor,
    parentWaitFor: page.parentWaitFor,
    persistence: page.persistence || null,
    captureDurationsMs: page.captureDurationsMs,
    summary: page.summary,
    captureErrors: page.captureErrors,
    consoleErrors: page.consoleErrors,
  }))
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
      '<td>' + (page.summary.slowCaptures || 0) + '</td>',
      '<td>' + page.summary.missingInCandidate + '</td>',
      '<td>' + page.summary.extraInCandidate + '</td>',
      '<td>' + page.summary.valueMismatches + '</td>',
      '</tr>',
    ].join('')
  }).join('\n')

  const problemLinks = diff.pagesWithDiscrepancies.map(page =>
    '<li><code>' + escapeHtml(page.pageId) + '</code> '
    + '<a href="' + escapeAttr(page.baselineUrl) + '">baseline</a> '
    + '<a href="' + escapeAttr(page.candidateUrl) + '">candidate</a> '
    + escapeHtml(page.persistence?.status ? '(' + page.persistence.status + ')' : '') + '</li>',
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
  <p>Reload recheck: ${renderPersistenceSummary(diff.persistenceSummary)}</p>
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
        <th>Slow captures</th>
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
  console.log('[parity-compare] slow captures: ' + diff.summary.slowCaptures)
  if (diff.persistenceSummary) {
    console.log('[parity-compare] reload recheck: ' + renderPersistenceSummary(diff.persistenceSummary))
  }

  if (diff.pagesWithDiscrepancies.length) {
    console.log('[parity-compare] pages with discrepancies:')
    for (const page of diff.pagesWithDiscrepancies) {
      console.log('  ' + page.pageId)
      console.log('    baseline:  ' + page.baselineUrl)
      console.log('    candidate: ' + page.candidateUrl)
    }
  }
}

function renderPersistenceSummary(summary) {
  if (!summary) return '0 checked, 0 persistent, 0 resolved, 0 failed to verify'
  const base = summary.checked + ' checked, '
    + summary.persistent + ' persistent, '
    + summary.resolved + ' resolved, '
    + summary.failed + ' failed to verify'

  if (!summary.skipped) return base

  const maxPercent = Math.round(Number(summary.maxRatio || 0) * 100)
  const failedPercent = Math.round(Number(summary.failedRatio || 0) * 100)
  return base + ', ' + summary.skipped + ' skipped'
    + (summary.reason === 'discrepancy-ratio-exceeded'
      ? ' (' + failedPercent + '% discrepant captures exceeded ' + maxPercent + '% threshold)'
      : '')
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
      throw new Error('Production server exited before becoming ready.')
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
  --baseline-branch <branch>  Create/reuse a worktree for this branch. Default: ${DEFAULT_BASELINE_BRANCH}
  --baseline-dir <dir>        Start baseline app from this checkout.
  --candidate-dir <dir>       Start candidate app from this checkout. Default: current repo.
  --baseline-url <url>        Attach to a running baseline app.
  --candidate-url <url>       Attach to a running candidate app.
  --output-dir <dir>          Artifact directory. Default: artifacts/parity/<timestamp>
  --work-dir <dir>            Worktree/scratch directory. Default: ${DEFAULT_WORK_DIR}
  --env-file <file[,file]>    Load app env from root-relative file(s). Default: .env. Use "none" to disable.
  --max-follow-items <n>      Limit list item detail pages. Default: all.
  --ready-timeout-ms <n>      Production server readiness timeout. Default: 120000.
  --wait-timeout-ms <n>       Per-selector and modal action timeout. Default: ${DEFAULT_WAIT_TIMEOUT_MS}.
  --data-ready-timeout-ms <n> Wait for visible loading placeholders to clear. Default: ${DEFAULT_DATA_READY_TIMEOUT_MS}.
  --network-idle-timeout-ms <n> Network idle wait after selectors. Default: ${DEFAULT_NETWORK_IDLE_TIMEOUT_MS}.
  --persistence-recheck-max-ratio <n> Skip reload recheck above this discrepant capture ratio. Default: ${DEFAULT_PERSISTENCE_RECHECK_MAX_RATIO}.
  --scrape-failure-limit <n> Stop after this many consecutive failed/empty scrapes. Default: ${DEFAULT_SCRAPE_FAILURE_LIMIT}.
  --navigation-timeout-ms <n> Per-page navigation timeout. Default: 45000.
  --navigation-retries <n>    Retry page navigations before recording a capture error. Default: 3.
  --numeric-tolerance <n|%>   Relative tolerance for numeric values. Default: 2%.
  --rate-limit-retries <n>    Retry page captures that observe HTTP 429. Default: 3.
  --app-phased                Capture all baseline pages first, then all candidate pages. Default.
  --alternating               Slow diagnostic mode: alternate baseline/candidate page-by-page.
  --sequential                Legacy alias for --alternating.
  --parallel                  Run both apps together and compare each scenario before moving on.
  --headed                    Show browser.
  --no-fail                   Exit 0 even when diffs are found.
  --skip-install              Do not run npm ci in missing-node_modules worktrees.
  --skip-build                Reuse existing .output production builds.

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
  PARITY_DATA_READY_TIMEOUT_MS Same as --data-ready-timeout-ms.
  PARITY_PERSISTENCE_RECHECK_MAX_RATIO Same as --persistence-recheck-max-ratio.
  PARITY_SCRAPE_FAILURE_LIMIT Same as --scrape-failure-limit.
  PARITY_NAVIGATION_TIMEOUT_MS Same as --navigation-timeout-ms.
  PARITY_NAVIGATION_RETRIES   Same as --navigation-retries.
  PARITY_ALTERNATING=1        Same as --alternating.
  PARITY_PARALLEL=1           Same as --parallel.
  PARITY_HEADED=1             Show browser.
`)
}
