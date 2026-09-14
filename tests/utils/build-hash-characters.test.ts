import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT_BUNDLE_DIR = join(process.cwd(), '.output', 'public', '_nuxt')

describe('client bundle chunk hashes', () => {
  if (!existsSync(CLIENT_BUNDLE_DIR)) {
    if (process.env.CI) {
      it('FAILS — .output/public/_nuxt/ missing under CI (build step likely missing)', () => {
        expect(false).toBe(true)
      })
      return
    }
    it.skip('skipped — .output/public/_nuxt/ missing (run `npm run build` first)', () => {})
    return
  }

  const jsFiles = readdirSync(CLIENT_BUNDLE_DIR)
    .filter(file => file.endsWith('.js'))

  it('found at least one client JavaScript chunk to inspect', () => {
    expect(jsFiles.length).toBeGreaterThan(0)
  })

  it('uses only hexadecimal characters in JavaScript chunk names', () => {
    const nonHexFiles = jsFiles.filter(file => !/^[a-f0-9]+\.js$/.test(file))

    expect(
      nonHexFiles,
      `found ${nonHexFiles.length} client chunk(s) with non-hexadecimal names`,
    ).toEqual([])
  })
})
