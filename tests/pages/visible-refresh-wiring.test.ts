import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const source = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('visible-tab refresh wiring', () => {
  it('runs the app refresh from one visible-tab ticker, with no wallet-only timer', () => {
    const app = source('app.vue')
    expect(app).toMatch(/const appRefresh = useAppRefresh\(\)\s*\nonMounted\(appRefresh\.start\)/)
    expect(app).not.toMatch(/setInterval\(/)
  })

  it('polls portfolio positions only while the page is active and the tab is visible', () => {
    const portfolio = source('pages/portfolio.vue')
    expect(portfolio).toMatch(/useVisibleTicker\(\[\(\) => updatePositions\(\)\]\)/)
    expect(portfolio).toMatch(/onDeactivated\(positionsRefresh\.stop\)/)
    expect(portfolio).not.toMatch(/setInterval\(/)
  })

  it('refreshes the open position page silently', () => {
    const position = source('pages/position/[number]/index.vue')
    expect(position).toMatch(/usePositionAutoRefresh\(\{[\s\S]*reread: \(\) => load\(\{ silent: true \}\)/)
    expect(position).toMatch(/onMounted\(positionRefresh\.start\)/)
  })
})
