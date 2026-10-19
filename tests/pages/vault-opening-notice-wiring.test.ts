import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const listPages = (directory: string): string[] => readdirSync(resolve(root, directory), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory()
    ? listPages(`${directory}/${entry.name}`)
    : entry.name.endsWith('.vue') ? [`${directory}/${entry.name}`] : [])
const calls = (path: string) => readFileSync(resolve(root, path), 'utf8').match(/useVaultOpeningNotice\(/g)?.length ?? 0

describe('vault opening pop-up placement', () => {
  it('opens on the Lend, Borrow and Earn vault pages only, once each', () => {
    const wired = listPages('pages').filter(path => calls(path) > 0).sort()
    expect(wired).toEqual([
      'pages/borrow/[collateral]/[borrow]/index.vue',
      'pages/earn/[vault]/index.vue',
      'pages/lend/[vault]/index.vue',
    ])
    for (const path of wired) expect(calls(path)).toBe(1)
  })

  it('opens without waiting for a wallet', () => {
    for (const path of ['pages/borrow/[collateral]/[borrow]/index.vue', 'pages/earn/[vault]/index.vue', 'pages/lend/[vault]/index.vue']) {
      const call = readFileSync(resolve(root, path), 'utf8').match(/useVaultOpeningNotice\(([^\n]*)\)/)?.[1] ?? ''
      expect(call).not.toMatch(/isConnected|walletChainId|address\.value/)
    }
  })
})
