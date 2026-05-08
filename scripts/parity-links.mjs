import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const target = process.argv[2] || path.join(ROOT_DIR, 'artifacts/parity/latest-run.json')

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp()
  process.exit(0)
}

void main().catch((error) => {
  console.error('[parity-links] ' + (error?.stack || error?.message || error))
  process.exit(1)
})

async function main() {
  const diff = await loadDiff(target)
  const pages = diff.pagesWithDiscrepancies || []

  if (!pages.length) {
    console.log('No pages with discrepancies.')
    return
  }

  for (const page of pages) {
    console.log(page.pageId)
    console.log('  path:      ' + page.path)
    console.log('  baseline:  ' + page.baselineUrl)
    console.log('  candidate: ' + page.candidateUrl)
    console.log(
      '  diffs:     elements='
      + page.summary.elementDiffs
      + ' lists='
      + page.summary.listDiffs
      + ' capture='
      + page.summary.captureErrors
      + ' console='
      + page.summary.consoleErrors
      + ' missing='
      + page.summary.missingInCandidate
      + ' extra='
      + page.summary.extraInCandidate
      + ' values='
      + page.summary.valueMismatches,
    )
  }
}

async function loadDiff(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))

  if (parsed.diff) {
    return JSON.parse(await fs.readFile(parsed.diff, 'utf8'))
  }

  return parsed
}

function printHelp() {
  console.log(`
Usage:
  npm run parity:links
  npm run parity:links -- artifacts/parity/<run>/diff.json

The default input is artifacts/parity/latest-run.json.
`)
}
