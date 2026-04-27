import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Bundle-shape regression. Pino lives in `server/utils/logger.ts` and is
 * imported only by server-runtime code. Nuxt's directory convention keeps
 * `server/**` out of the app-side bundle, so pino's server-only deps (the
 * `pino-pretty` transport, `pino-std-serializers`) should never reach the
 * client. If that ever stops working, the bundle balloons and we pull in
 * `node:worker_threads` references that break in browsers.
 *
 * The test reads the production client output at `.output/public/_nuxt/` and
 * fails if any forbidden marker appears. It auto-skips if no build is on disk
 * (so plain `npm test` doesn't force a build), but CI must run `npm run build`
 * before `npm run test:run` for this assertion to actually fire.
 *
 * Markers chosen for stability:
 *   - `pino-pretty`     — only imported by `server/utils/logger.ts` for dev pretty-printing
 *   - `pino-std-serializers` — only used inside pino's server runtime
 *   - `errSerializer`   — local symbol unique to `server/utils/logger.ts`
 *
 * NOT a marker: bare `pino`. That string is in `@walletconnect/logger`'s
 * client bundle (Reown ships pino in browser already) and was in the bundle
 * before this PR, so excluding it would have been false advertising.
 */

const CLIENT_BUNDLE_DIR = join(process.cwd(), '.output', 'public', '_nuxt')

const FORBIDDEN_MARKERS = [
  'pino-pretty',
  'pino-std-serializers',
  'errSerializer',
] as const

const collectJsFiles = (dir: string): string[] => {
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      const s = statSync(full)
      if (s.isDirectory()) walk(full)
      else if (s.isFile() && full.endsWith('.js')) out.push(full)
    }
  }
  walk(dir)
  return out
}

describe('client bundle does not ship server-only logger code', () => {
  if (!existsSync(CLIENT_BUNDLE_DIR)) {
    // CI must run `npm run build` before `npm run test:run` for this assertion
    // to fire. Hard-fail when running under CI so a missing build doesn't
    // silently turn the regression check into a no-op; locally we just skip.
    if (process.env.CI) {
      it('FAILS — .output/public/_nuxt/ missing under CI (build step likely missing)', () => {
        expect(false).toBe(true)
      })
      return
    }
    it.skip('skipped — .output/public/_nuxt/ missing (run `npm run build` first)', () => {})
    return
  }

  const files = collectJsFiles(CLIENT_BUNDLE_DIR)

  it('found at least one client JS chunk to inspect', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const marker of FORBIDDEN_MARKERS) {
    it(`no client chunk contains "${marker}"`, () => {
      const offenders: string[] = []
      for (const file of files) {
        const content = readFileSync(file, 'utf8')
        if (content.includes(marker)) offenders.push(file.replace(process.cwd(), '.'))
      }
      expect(offenders, `marker "${marker}" leaked into ${offenders.length} client chunk(s)`).toEqual([])
    })
  }
})
