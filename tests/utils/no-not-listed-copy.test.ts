import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const listSources = (directory: string): string[] => readdirSync(resolve(root, directory), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory()
    ? listSources(`${directory}/${entry.name}`)
    : /\.(?:ts|vue)$/.test(entry.name) ? [`${directory}/${entry.name}`] : [])

describe('vault listing wording', () => {
  it('never tells the user a vault is not listed', () => {
    const offenders = ['components', 'pages', 'composables', 'utils']
      .flatMap(listSources)
      .filter(path => /not[\s-]listed/i.test(readFileSync(resolve(root, path), 'utf8')))
    expect(offenders).toEqual([])
  })
})
