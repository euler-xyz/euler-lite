#!/usr/bin/env node
/**
 * Runs execution recorder groups against one Anvil fork.
 *
 * Each group starts from the same Anvil snapshot, then invokes
 * scripts/execution-record.mjs with that group's scenario filter. The aggregate
 * report counts transaction coverage only from passed scenarios.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_GROUPS = path.join(ROOT_DIR, 'tests/execution/groups.json')
const DEFAULT_SCENARIOS = path.join(ROOT_DIR, 'tests/execution/scenarios.json')
const DEFAULT_FIXTURE = path.join(ROOT_DIR, 'tests/execution/anvil-mainnet.fixture.json')
const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, 'artifacts/execution-recordings/suite')
const DEFAULT_ANVIL_RPC_URL = 'http://127.0.0.1:8545'

const args = parseArgs(process.argv.slice(2))

void main().catch((error) => {
  console.error('[execution-suite]', error?.stack || error?.message || error)
  process.exit(1)
})

async function main() {
  const groupsPath = path.resolve(ROOT_DIR, args.groups ?? DEFAULT_GROUPS)
  const scenariosPath = path.resolve(ROOT_DIR, args.scenarios ?? DEFAULT_SCENARIOS)
  const fixturePath = path.resolve(ROOT_DIR, args.fixture ?? DEFAULT_FIXTURE)
  const outputDir = path.resolve(ROOT_DIR, args['output-dir'] ?? DEFAULT_OUTPUT_DIR)
  const anvilRpcUrl = String(args['anvil-rpc'] ?? DEFAULT_ANVIL_RPC_URL)
  const groupsFile = await readJson(groupsPath)
  const scenariosFile = await readJson(scenariosPath)
  const selectedGroups = selectGroups(groupsFile.groups ?? [], args.group)

  if (!selectedGroups.length) {
    throw new Error(`No execution groups matched group=${args.group ?? '*'}`)
  }

  await mkdirp(outputDir)
  const initialSnapshot = await rpc(anvilRpcUrl, 'evm_snapshot', [])
  let baseSnapshot = initialSnapshot
  const results = []

  for (const group of selectedGroups) {
    console.log(`[execution-suite] ▶ ${group.id} — ${group.label ?? ''}`)
    await rpc(anvilRpcUrl, 'evm_revert', [baseSnapshot])
    baseSnapshot = await rpc(anvilRpcUrl, 'evm_snapshot', [])

    const groupDir = path.join(outputDir, group.id)
    const recorderArgs = buildRecorderArgs({
      group,
      groupDir,
      fixturePath,
      scenariosPath,
      anvilRpcUrl,
    })
    const startedAt = new Date().toISOString()
    const exitCode = await runNode(recorderArgs)
    const finishedAt = new Date().toISOString()
    const result = await readGroupResult({ group, groupDir, exitCode, startedAt, finishedAt })
    results.push(result)

    if (exitCode !== 0 && args['fail-fast']) {
      break
    }
  }

  const summary = buildSummary({
    groupsPath,
    scenariosPath,
    fixturePath,
    outputDir,
    anvilRpcUrl,
    scenariosFile,
    results,
  })
  await writeJson(path.join(outputDir, 'summary.json'), summary)
  await fs.writeFile(path.join(outputDir, 'report.md'), renderSuiteReport(summary), 'utf8')
  await fs.writeFile(path.join(outputDir, 'report.html'), renderSuiteHtmlReport(summary, outputDir), 'utf8')

  console.log(`[execution-suite] wrote ${path.relative(ROOT_DIR, outputDir)}`)

  if (summary.failedGroups.length || summary.missingTransactionTypes.length) {
    process.exitCode = 1
  }
}

function buildRecorderArgs({ group, groupDir, fixturePath, scenariosPath, anvilRpcUrl }) {
  const recorderArgs = [
    path.join(ROOT_DIR, 'scripts/execution-record.mjs'),
    '--fixture',
    path.relative(ROOT_DIR, fixturePath),
    '--scenarios',
    path.relative(ROOT_DIR, scenariosPath),
    '--scenario',
    group.scenarios.join(','),
    '--output-dir',
    groupDir,
    '--anvil-rpc',
    anvilRpcUrl,
  ]

  for (const key of ['url', 'vault-snapshot', 'swap-api-url', 'pyth-updates-url']) {
    if (args[key]) {
      recorderArgs.push(`--${key}`, String(args[key]))
    }
  }
  for (const key of [
    'headless',
    'keep-open',
    'skip-v3-preflight',
    'v3-preflight',
    'all-browser-rpc-to-anvil',
    'no-video',
  ]) {
    if (args[key]) {
      recorderArgs.push(`--${key}`)
    }
  }

  return recorderArgs
}

function selectGroups(groups, filter) {
  if (!filter) return groups
  const selected = new Set(String(filter).split(',').map(item => item.trim()).filter(Boolean))
  return groups.filter(group => selected.has(group.id))
}

async function readGroupResult({ group, groupDir, exitCode, startedAt, finishedAt }) {
  const runPath = path.join(groupDir, 'run.json')
  const reportPath = path.join(groupDir, 'report.md')
  const htmlReportPath = path.join(groupDir, 'report.html')
  const result = {
    id: group.id,
    label: group.label ?? null,
    scenarios: group.scenarios,
    outputDir: path.relative(ROOT_DIR, groupDir),
    reportPath: path.relative(ROOT_DIR, reportPath),
    htmlReportPath: path.relative(ROOT_DIR, htmlReportPath),
    exitCode,
    startedAt,
    finishedAt,
    status: exitCode === 0 ? 'passed' : 'failed',
    passedScenarios: [],
    failedScenarios: [],
    coveredTransactionTypes: [],
    transactions: [],
    scenarioResults: [],
    sdkQueryRecords: 0,
    networkRecords: 0,
    walletRequests: 0,
    videoRecords: 0,
  }

  try {
    const run = await readJson(runPath)
    result.passedScenarios = run.scenarios.filter(s => s.status === 'passed').map(s => s.id)
    result.failedScenarios = run.scenarios.filter(s => s.status !== 'passed').map(s => ({
      id: s.id,
      error: s.error?.message ?? String(s.error ?? 'failed'),
      failureArtifacts: s.failureArtifacts ?? null,
    }))
    result.coveredTransactionTypes = [...new Set(run.scenarios
      .filter(s => s.status === 'passed')
      .flatMap(s => s.covers ?? []))]
    const walletRequests = Array.isArray(run.walletRequests)
      ? run.walletRequests
      : await readJsonl(path.join(groupDir, run.walletRequests.file))
    result.transactions = walletRequests
      .filter(item => item.method === 'eth_sendTransaction' && item.status === 'success')
      .map(item => item.result)
    result.scenarioResults = run.scenarios.map(scenario => summarizeScenarioResult(scenario, walletRequests))
    result.videoRecords = result.scenarioResults.filter(scenario => scenario.video?.file).length
    result.sdkQueryRecords = Array.isArray(run.sdkQueries) ? run.sdkQueries.length : (run.sdkQueries?.count ?? 0)
    result.networkRecords = Array.isArray(run.network) ? run.network.length : (run.network?.count ?? 0)
    result.walletRequests = Array.isArray(run.walletRequests) ? run.walletRequests.length : (run.walletRequests?.count ?? 0)
  }
  catch (error) {
    result.failedScenarios.push({
      id: '(group setup)',
      error: `Could not read ${path.relative(ROOT_DIR, runPath)}: ${error?.message ?? error}`,
      failureArtifacts: null,
    })
  }

  return result
}

function summarizeScenarioResult(scenario, walletRequests) {
  return {
    id: scenario.id,
    label: scenario.label ?? null,
    status: scenario.status,
    covers: scenario.covers ?? [],
    startedAt: scenario.startedAt,
    finishedAt: scenario.finishedAt ?? null,
    durationMs: durationMs(scenario.startedAt, scenario.finishedAt),
    actions: scenario.actions ?? [],
    captures: (scenario.captures ?? []).map(capture => ({
      id: capture.id,
      url: capture.url ?? null,
      tagCount: capture.tags?.length ?? 0,
      sampleTags: (capture.tags ?? []).slice(0, 20),
    })),
    error: scenario.error ?? null,
    failureArtifacts: scenario.failureArtifacts ?? null,
    video: scenario.video ?? null,
    transactions: transactionsForScenario(walletRequests, scenario),
  }
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

function durationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt)
  const finished = Date.parse(finishedAt)
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null
  return finished - started
}

function buildSummary({ groupsPath, scenariosPath, fixturePath, outputDir, anvilRpcUrl, scenariosFile, results }) {
  const covered = [...new Set(results.flatMap(group => group.coveredTransactionTypes))]
  const required = scenariosFile.requiredTransactionTypes ?? []
  const unsupported = scenariosFile.unsupportedTransactionTypes ?? []
  const unsupportedSet = new Set(unsupported)
  const missing = required.filter(item => !covered.includes(item) && !unsupportedSet.has(item))
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    groupsPath: path.relative(ROOT_DIR, groupsPath),
    scenariosPath: path.relative(ROOT_DIR, scenariosPath),
    fixturePath: path.relative(ROOT_DIR, fixturePath),
    outputDir: path.relative(ROOT_DIR, outputDir),
    anvilRpcUrl,
    passedGroups: results.filter(group => group.status === 'passed').map(group => group.id),
    failedGroups: results.filter(group => group.status !== 'passed').map(group => group.id),
    coveredTransactionTypes: covered,
    unsupportedTransactionTypes: unsupported,
    missingTransactionTypes: missing,
    groups: results,
  }
}

function renderSuiteReport(summary) {
  const txHashes = summary.groups.flatMap(group => group.transactions)
  const videoRecords = summary.groups.reduce((total, group) => total + Number(group.videoRecords ?? 0), 0)
  const scenarioCount = summary.groups.reduce((total, group) => total + Number(group.scenarioResults?.length ?? group.scenarios.length), 0)
  return [
    '# Execution Suite Report',
    '',
    `- Groups: ${summary.passedGroups.length} passed, ${summary.failedGroups.length} failed`,
    `- Covered transaction types: ${summary.coveredTransactionTypes.length ? summary.coveredTransactionTypes.join(', ') : 'none'}`,
    `- Unsupported transaction types: ${summary.unsupportedTransactionTypes.length ? summary.unsupportedTransactionTypes.join(', ') : 'none'}`,
    `- Missing transaction types: ${summary.missingTransactionTypes.length ? summary.missingTransactionTypes.join(', ') : 'none'}`,
    `- Transactions sent: ${txHashes.length}`,
    `- Videos recorded: ${videoRecords}/${scenarioCount}`,
    `- Output dir: ${summary.outputDir}`,
    `- HTML report: ${path.join(summary.outputDir, 'report.html')}`,
    '',
    '## Groups',
    '',
    ...summary.groups.map(group => [
      `### ${group.status === 'passed' ? 'PASS' : 'FAIL'} ${group.id}`,
      '',
      `- Scenarios: ${group.passedScenarios.length} passed, ${group.failedScenarios.length} failed`,
      `- Covered: ${group.coveredTransactionTypes.length ? group.coveredTransactionTypes.join(', ') : 'none'}`,
      `- Transactions: ${group.transactions.length}`,
      `- Videos: ${group.videoRecords}/${group.scenarioResults?.length ?? group.scenarios.length}`,
      `- Report: ${group.reportPath}`,
      `- HTML: ${group.htmlReportPath}`,
      ...(group.failedScenarios.length
        ? [
            '- Failures:',
            ...group.failedScenarios.map(s => `  - ${s.id}: ${s.error}`),
          ]
        : []),
      '',
    ].join('\n')),
    '## Transactions',
    '',
    ...(txHashes.length ? txHashes.map(hash => `- ${hash}`) : ['- none']),
    '',
  ].join('\n')
}

function renderSuiteHtmlReport(summary, outputDir) {
  const scenarios = summary.groups.flatMap(group => (group.scenarioResults ?? []).map(scenario => ({ ...scenario, group })))
  const passedScenarios = scenarios.filter(scenario => scenario.status === 'passed')
  const failedScenarios = scenarios.filter(scenario => scenario.status !== 'passed')
  const txHashes = summary.groups.flatMap(group => group.transactions)
  const videoCount = scenarios.filter(scenario => scenario.video?.file).length

  return htmlPage('Execution Suite Report', `
    <header>
      <p class="eyebrow">Forked transaction e2e suite</p>
      <h1>Execution Suite Report</h1>
      <p class="muted">Generated ${escapeHtml(summary.generatedAt)}</p>
    </header>

    <section class="summary-grid">
      ${summaryCard('Groups', `${summary.passedGroups.length} passed / ${summary.failedGroups.length} failed`, summary.failedGroups.length ? 'bad' : 'good')}
      ${summaryCard('Tests', `${passedScenarios.length} passed / ${failedScenarios.length} failed`, failedScenarios.length ? 'bad' : 'good')}
      ${summaryCard('Videos', `${videoCount}/${scenarios.length}`, videoCount === scenarios.length ? 'good' : 'warn')}
      ${summaryCard('Transactions', String(txHashes.length), txHashes.length ? 'good' : 'warn')}
      ${summaryCard('Unsupported', summary.unsupportedTransactionTypes.length ? String(summary.unsupportedTransactionTypes.length) : 'none', summary.unsupportedTransactionTypes.length ? 'warn' : 'good')}
      ${summaryCard('Missing Types', summary.missingTransactionTypes.length ? String(summary.missingTransactionTypes.length) : 'none', summary.missingTransactionTypes.length ? 'bad' : 'good')}
    </section>

    <section>
      <h2>Run</h2>
      <dl class="metadata">
        <div><dt>Groups file</dt><dd>${escapeHtml(summary.groupsPath)}</dd></div>
        <div><dt>Scenarios file</dt><dd>${escapeHtml(summary.scenariosPath)}</dd></div>
        <div><dt>Fixture</dt><dd>${escapeHtml(summary.fixturePath)}</dd></div>
        <div><dt>Output dir</dt><dd>${escapeHtml(summary.outputDir)}</dd></div>
        <div><dt>Anvil RPC</dt><dd>${escapeHtml(summary.anvilRpcUrl)}</dd></div>
      </dl>
    </section>

    <section>
      <h2>Coverage</h2>
      <div class="pills">
        ${summary.coveredTransactionTypes.length ? summary.coveredTransactionTypes.map(type => `<span>${escapeHtml(type)}</span>`).join('') : '<span class="warn">none</span>'}
      </div>
      ${summary.unsupportedTransactionTypes.length ? `<p class="muted">Unsupported: ${escapeHtml(summary.unsupportedTransactionTypes.join(', '))}</p>` : ''}
      ${summary.missingTransactionTypes.length ? `<p class="bad-text">Missing: ${escapeHtml(summary.missingTransactionTypes.join(', '))}</p>` : ''}
    </section>

    <section>
      <h2>Groups</h2>
      <div class="group-grid">
        ${summary.groups.map(group => renderGroupCard(group, outputDir)).join('')}
      </div>
    </section>

    <section>
      <h2>Tests</h2>
      <div class="test-list">
        ${scenarios.map(({ group, ...scenario }) => renderScenarioHtml({ scenario, group, outputDir })).join('')}
      </div>
    </section>

    <section>
      <h2>Sidecars</h2>
      <ul class="links">
        <li><a href="summary.json">summary.json</a></li>
        <li><a href="report.md">report.md</a></li>
      </ul>
    </section>
  `)
}

function renderGroupCard(group, outputDir) {
  const href = artifactHref(outputDir, group.htmlReportPath)
  return `
    <article class="group-card ${group.status === 'passed' ? 'passed' : 'failed'}">
      <div>
        <span class="status ${group.status === 'passed' ? 'passed' : 'failed'}">${escapeHtml(group.status.toUpperCase())}</span>
        <h3>${escapeHtml(group.id)}</h3>
        <p>${escapeHtml(group.label ?? '')}</p>
      </div>
      <dl class="metadata compact">
        <div><dt>Scenarios</dt><dd>${group.passedScenarios.length} passed / ${group.failedScenarios.length} failed</dd></div>
        <div><dt>Transactions</dt><dd>${group.transactions.length}</dd></div>
        <div><dt>Videos</dt><dd>${group.videoRecords}/${group.scenarioResults?.length ?? group.scenarios.length}</dd></div>
      </dl>
      <a href="${escapeAttr(href)}">Group report</a>
    </article>
  `
}

function renderScenarioHtml({ scenario, group, outputDir }) {
  const status = scenario.status === 'passed' ? 'passed' : 'failed'
  const groupHref = artifactHref(outputDir, group.htmlReportPath)
  return `
    <details class="test-card ${status}">
      <summary>
        <span class="status ${status}">${escapeHtml(status.toUpperCase())}</span>
        <span class="test-title">${escapeHtml(scenario.id)}</span>
        <span class="test-meta">${escapeHtml(group.id)} - ${escapeHtml(scenario.label ?? '')}</span>
      </summary>
      <div class="test-body">
        <div class="scenario-grid">
          <div>
            <h3>Details</h3>
            <dl class="metadata compact">
              <div><dt>Group</dt><dd><a href="${escapeAttr(groupHref)}">${escapeHtml(group.id)}</a></dd></div>
              <div><dt>Started</dt><dd>${escapeHtml(scenario.startedAt)}</dd></div>
              <div><dt>Finished</dt><dd>${escapeHtml(scenario.finishedAt ?? '')}</dd></div>
              <div><dt>Duration</dt><dd>${scenario.durationMs === null ? '' : `${scenario.durationMs} ms`}</dd></div>
              <div><dt>Transactions</dt><dd>${scenario.transactions.length}</dd></div>
              <div><dt>Captures</dt><dd>${scenario.captures.length}</dd></div>
            </dl>
            <div class="pills">${scenario.covers.map(type => `<span>${escapeHtml(type)}</span>`).join('') || '<span>none</span>'}</div>
          </div>
          <div>
            <h3>Recording</h3>
            ${renderVideo(scenario.video, outputDir)}
          </div>
        </div>

        ${scenario.error ? `<section class="error"><h3>Error</h3><pre>${escapeHtml(scenario.error.message ?? JSON.stringify(scenario.error, null, 2))}</pre></section>` : ''}
        ${scenario.failureArtifacts ? renderFailureArtifacts(scenario.failureArtifacts, outputDir) : ''}
        ${renderActions(scenario.actions)}
        ${renderTransactions(scenario.transactions)}
        ${renderCaptureSummary(scenario.captures)}
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
          <summary>${escapeHtml(capture.id)} - ${capture.tagCount} visible tagged elements</summary>
          <p class="muted">${escapeHtml(capture.url ?? '')}</p>
          ${renderTagSample(capture.sampleTags ?? [], capture.tagCount)}
        </details>
      `).join('')}
    </section>
  `
}

function renderTagSample(tags, total) {
  if (!tags.length) return '<p class="muted">No visible tags captured.</p>'
  return `
    <table>
      <thead><tr><th>Element</th><th>Data</th><th>Text</th></tr></thead>
      <tbody>
        ${tags.map(tag => `
          <tr>
            <td>${escapeHtml(tag.tag)}</td>
            <td><code>${escapeHtml(JSON.stringify(tag.attrs ?? {}))}</code></td>
            <td>${escapeHtml(tag.text ?? '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${total > tags.length ? `<p class="muted">Showing ${tags.length} of ${total}. Full capture is in the group run.json.</p>` : ''}
  `
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
    .bad-text { color: var(--bad); font-weight: 600; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .summary-card, section, .test-card, .group-card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
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
    .group-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; }
    .group-card { padding: 14px; display: grid; gap: 12px; align-content: start; }
    .group-card h3 { margin: 8px 0 4px; }
    .group-card p { margin: 0; color: var(--muted); }
    .group-card.passed { border-color: #9ad8b5; }
    .group-card.failed { border-color: #f5a6a0; }
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

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}

async function runNode(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('close', code => resolve(code ?? 1))
    child.on('error', (error) => {
      console.error('[execution-suite]', error?.stack || error?.message || error)
      resolve(1)
    })
  })
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

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function writeJson(file, data) {
  await mkdirp(path.dirname(file))
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

async function mkdirp(dir) {
  await fs.mkdir(dir, { recursive: true })
}
