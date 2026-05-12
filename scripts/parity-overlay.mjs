import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3000
const READY_TIMEOUT_MS = 120_000

const overlayInitScript = `
(() => {
  if (window.__PARITY_OVERLAY__) return

  const STYLE_ID = '__parity_data_overlay_style__'
  const TOOLBAR_ID = '__parity_data_overlay_toolbar__'
  const DIFF_PANEL_ID = '__parity_data_overlay_diff_panel__'
  const TOOLTIP_ID = '__parity_data_overlay_tooltip__'
  let scheduled = false
  let activeTooltipTarget = null
  let diffPanelExpanded = false

  const hashHue = (value) => {
    let hash = 0
    for (let i = 0; i < value.length; i += 1) {
      hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
    }
    return Math.abs(hash) % 360
  }

  const describe = (element) => {
    const parts = []
    const id = element.getAttribute('data-id')
    const list = element.getAttribute('data-list')
    const field = element.getAttribute('data-field')
    const key = element.getAttribute('data-key')
    const value = element.getAttribute('data-value')

    if (id) parts.push('id=' + id)
    if (list) parts.push('list=' + list)
    if (field) parts.push('field=' + field)
    if (key) parts.push('key=' + key)
    if (value) parts.push('value=' + value)

    return parts.join(' | ')
  }

  const diffForCurrentPage = () => {
    const diff = window.__PARITY_DIFF__
    if (!diff || !diff.pages) return null

    const path = window.location.pathname + window.location.search
    return diff.pages[path] || diff.pages[window.location.pathname] || null
  }

  const baseParityKey = (element) => [
    element.getAttribute('data-id') || '',
    element.getAttribute('data-list') || '',
    element.getAttribute('data-key') || '',
    element.getAttribute('data-field') || '',
  ].join('|')

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

  const compact = (value, maxLength = 180) => {
    const normalized = String(value ?? '').replace(/\\s+/g, ' ').trim()
    if (!normalized) return '(empty)'
    return normalized.length > maxLength
      ? normalized.slice(0, maxLength - 1) + '...'
      : normalized
  }

  const fullValue = (value) => {
    const text = String(value ?? '')
    return text.trim() ? text : '(empty)'
  }

  const formatNumber = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return ''
    if (value === 0) return '0'
    if (Math.abs(value) < 0.000001 || Math.abs(value) > 1_000_000) return value.toExponential(4)
    return String(Number(value.toPrecision(8)))
  }

  const problemLabel = (problem) => [
    problem.field || problem.id || problem.status || 'diff',
    problem.itemKey ? compact(problem.itemKey, 28) : '',
  ].filter(Boolean).join(' ')

  const sourceValue = (source) => {
    const value = [source?.value, source?.compareValue, source?.text]
      .find(entry => entry !== undefined && entry !== null && String(entry).trim() !== '')
    return value ?? ''
  }

  const shouldShowDataTooltip = (element) =>
    element?.hasAttribute?.('data-field') || element?.getAttribute?.('data-id') === 'data-point'

  const liveElementDetail = (element) => {
    const closestLink = element.closest?.('a[href]')
    const value = element.getAttribute('data-value') || ''
    const text = (element.innerText || element.textContent || '').trim()

    return {
      key: element.getAttribute('data-parity-key') || '',
      baseKey: baseParityKey(element),
      status: 'tagged-data',
      id: element.getAttribute('data-id') || '',
      field: element.getAttribute('data-field') || '',
      list: element.getAttribute('data-list') || '',
      itemKey: element.getAttribute('data-key') || '',
      current: {
        id: element.getAttribute('data-id') || '',
        list: element.getAttribute('data-list') || '',
        itemKey: element.getAttribute('data-key') || '',
        field: element.getAttribute('data-field') || '',
        value,
        compareValue: value,
        text,
        href: element.href || closestLink?.href || '',
      },
    }
  }

  const mismatchRows = (problem) => {
    const rows = []
    const mismatch = problem.mismatch || {}
    const valueMismatch = mismatch.value
    const textMismatch = mismatch.text
    const baseline = problem.baseline
    const candidate = problem.candidate
    const current = problem.current

    if (valueMismatch) {
      rows.push({
        label: 'value',
        baseline: valueMismatch.baseline,
        candidate: valueMismatch.candidate,
        comparison: valueMismatch.comparison,
      })
    }

    if (textMismatch) {
      rows.push({
        label: 'text',
        baseline: textMismatch.baseline,
        candidate: textMismatch.candidate,
        comparison: textMismatch.comparison,
      })
    }

    if (!rows.length && current) {
      const value = current.value || current.compareValue
      if (value) {
        rows.push({
          label: 'value',
          current: value,
          comparison: null,
        })
      }

      if (current.text && current.text !== value) {
        rows.push({
          label: 'text',
          current: current.text,
          comparison: null,
        })
      }
    }

    if (!rows.length && (baseline || candidate)) {
      rows.push({
        label: 'display',
        baseline: sourceValue(baseline),
        candidate: sourceValue(candidate),
        comparison: null,
      })
    }

    return rows
  }

  const comparisonSummary = (comparison) => {
    if (!comparison) return ''
    const parts = []
    if (comparison.mode) parts.push('mode=' + comparison.mode)
    if (typeof comparison.tolerance === 'number') parts.push('tolerance=' + formatNumber(comparison.tolerance * 100) + '%')
    if (typeof comparison.difference === 'number') parts.push('delta=' + formatNumber(comparison.difference))
    if (typeof comparison.allowedDifference === 'number') parts.push('allowed=' + formatNumber(comparison.allowedDifference))
    return parts.join(' | ')
  }

  const renderProblemTooltip = (problem) => {
    const rows = mismatchRows(problem)
    const body = rows.map((row) => {
      const summary = comparisonSummary(row.comparison)
      if (Object.hasOwn(row, 'current')) {
        return [
          '<div class="parity-tooltip-row">',
          '<div><strong>' + escapeHtml(row.label) + '</strong></div>',
          '<div><em>current</em><code>' + escapeHtml(compact(row.current)) + '</code></div>',
          '</div>',
        ].join('')
      }

      return [
        '<div class="parity-tooltip-row">',
        '<div><strong>' + escapeHtml(row.label) + '</strong>' + (summary ? '<span>' + escapeHtml(summary) + '</span>' : '') + '</div>',
        '<div><em>baseline</em><code>' + escapeHtml(compact(row.baseline)) + '</code></div>',
        '<div><em>candidate</em><code>' + escapeHtml(compact(row.candidate)) + '</code></div>',
        '</div>',
      ].join('')
    }).join('')

    return [
      '<div class="parity-tooltip-title">',
      '<code>' + escapeHtml(problem.status) + '</code>',
      '<span>' + escapeHtml(problemLabel(problem)) + '</span>',
      '</div>',
      '<div class="parity-tooltip-meta">' + escapeHtml(problem.key || '') + '</div>',
      body,
    ].join('')
  }

  const renderProblemTitle = (problem) => [
    problemLabel(problem),
    ...mismatchRows(problem).map((row) => {
      if (Object.hasOwn(row, 'current')) {
        return row.label + ': current=' + compact(row.current)
      }

      return row.label + ': baseline=' + compact(row.baseline) + ' candidate=' + compact(row.candidate)
    }),
  ].join('\\n')

  const renderProblemLine = (problem) => {
    const row = mismatchRows(problem)[0]
    const values = row
      ? '<small>' + (
          Object.hasOwn(row, 'current')
            ? escapeHtml(compact(row.current, 112))
            : escapeHtml(compact(row.baseline, 54)) + ' -> ' + escapeHtml(compact(row.candidate, 54))
        ) + '</small>'
      : ''

    return [
      '<div class="parity-diff-row">',
      '<code>' + escapeHtml(problem.status) + '</code> ',
      '<span>' + escapeHtml(problemLabel(problem)) + '</span>',
      values,
      '</div>',
    ].join('')
  }

  const renderProblemFullLine = (problem) => {
    const rows = mismatchRows(problem)
    const body = rows.length
      ? rows.map((row) => {
          const summary = comparisonSummary(row.comparison)
          if (Object.hasOwn(row, 'current')) {
            return [
              '<div class="parity-diff-detail">',
              '<div><strong>' + escapeHtml(row.label) + '</strong></div>',
              '<div><em>current</em><code>' + escapeHtml(fullValue(row.current)) + '</code></div>',
              '</div>',
            ].join('')
          }

          return [
            '<div class="parity-diff-detail">',
            '<div><strong>' + escapeHtml(row.label) + '</strong>' + (summary ? '<span>' + escapeHtml(summary) + '</span>' : '') + '</div>',
            '<div><em>baseline</em><code>' + escapeHtml(fullValue(row.baseline)) + '</code></div>',
            '<div><em>candidate</em><code>' + escapeHtml(fullValue(row.candidate)) + '</code></div>',
            '</div>',
          ].join('')
        }).join('')
      : '<div class="parity-diff-detail"><code>' + escapeHtml(JSON.stringify(problem, null, 2)) + '</code></div>'

    return [
      '<div class="parity-diff-row parity-diff-row-expanded">',
      '<div><code>' + escapeHtml(problem.status) + '</code> ',
      '<span>' + escapeHtml(problemLabel(problem)) + '</span></div>',
      '<div class="parity-diff-key">' + escapeHtml(problem.key || '') + '</div>',
      body,
      '</div>',
    ].join('')
  }

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return

    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = [
      'html[data-parity-overlay="off"] [data-id] { outline: none !important; box-shadow: none !important; }',
      'html[data-parity-overlay="off"] #' + TOOLTIP_ID + ' { display: none !important; }',
      'html[data-parity-overlay="on"] :where([data-id]) {',
      '  --parity-hue: 205;',
      '  outline: 1.5px solid hsl(var(--parity-hue) 92% 48% / 0.92) !important;',
      '  outline-offset: 2px !important;',
      '  box-shadow: inset 0 0 0 9999px hsl(var(--parity-hue) 92% 58% / 0.035) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-id]):not(svg):not(g):not(path):not(circle):not(line):not(polyline):not(polygon):not(text) {',
      '  position: relative !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-id="data-point"]) {',
      '  border-radius: 4px !important;',
      '  background: hsl(var(--parity-hue) 92% 58% / 0.07) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status="match"]) {',
      '  outline-color: rgb(34 197 94 / 0.95) !important;',
      '  box-shadow: inset 0 0 0 9999px rgb(34 197 94 / 0.045) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status="value-mismatch"]) {',
      '  outline: 2px solid rgb(220 38 38 / 0.98) !important;',
      '  box-shadow: inset 0 0 0 9999px rgb(220 38 38 / 0.09) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status="missing-in-candidate"]) {',
      '  outline: 2px solid rgb(245 158 11 / 0.98) !important;',
      '  box-shadow: inset 0 0 0 9999px rgb(245 158 11 / 0.11) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status="extra-in-candidate"]) {',
      '  outline: 2px solid rgb(168 85 247 / 0.98) !important;',
      '  box-shadow: inset 0 0 0 9999px rgb(168 85 247 / 0.11) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-id])::after {',
      '  content: attr(data-id);',
      '  position: absolute !important;',
      '  top: -10px !important;',
      '  left: 0 !important;',
      '  z-index: 2147483646 !important;',
      '  max-width: min(260px, 80vw) !important;',
      '  padding: 1px 5px !important;',
      '  border-radius: 3px !important;',
      '  background: hsl(var(--parity-hue) 92% 28% / 0.94) !important;',
      '  color: white !important;',
      '  font: 10px/14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;',
      '  letter-spacing: 0 !important;',
      '  white-space: nowrap !important;',
      '  overflow: hidden !important;',
      '  text-overflow: ellipsis !important;',
      '  pointer-events: none !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-id][data-field])::after {',
      '  content: attr(data-id) " " attr(data-field);',
      '}',
      'html[data-parity-overlay="on"] :where([data-id="data-point"][data-field])::after {',
      '  content: attr(data-field);',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status][data-field])::after {',
      '  content: attr(data-parity-status) " " attr(data-field);',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status]:not([data-field]))::after {',
      '  content: attr(data-parity-status) " " attr(data-id);',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status="match"][data-field])::after {',
      '  display: none !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status="match"]:not([data-field]))::after {',
      '  display: none !important;',
      '}',
      'html[data-parity-overlay="on"][data-parity-labels="off"] :where([data-id])::after {',
      '  display: none !important;',
      '}',
      '#' + TOOLBAR_ID + ' {',
      '  position: fixed !important;',
      '  right: 12px !important;',
      '  bottom: 12px !important;',
      '  z-index: 2147483647 !important;',
      '  display: flex !important;',
      '  gap: 8px !important;',
      '  align-items: center !important;',
      '  padding: 8px 10px !important;',
      '  border: 1px solid rgb(255 255 255 / 0.18) !important;',
      '  border-radius: 6px !important;',
      '  background: rgb(12 18 28 / 0.9) !important;',
      '  color: white !important;',
      '  box-shadow: 0 8px 30px rgb(0 0 0 / 0.24) !important;',
      '  font: 12px/16px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;',
      '  letter-spacing: 0 !important;',
      '  pointer-events: none !important;',
      '}',
      '#' + TOOLBAR_ID + ' strong { color: #8fd3ff !important; font-weight: 700 !important; }',
      '#' + TOOLBAR_ID + ' span { color: rgb(255 255 255 / 0.7) !important; }',
      '#' + DIFF_PANEL_ID + ' {',
      '  position: fixed !important;',
      '  left: 12px !important;',
      '  bottom: 12px !important;',
      '  z-index: 2147483647 !important;',
      '  max-width: min(560px, calc(100vw - 24px)) !important;',
      '  max-height: 36vh !important;',
      '  overflow: auto !important;',
      '  padding: 10px 12px !important;',
      '  border: 1px solid rgb(255 255 255 / 0.18) !important;',
      '  border-radius: 6px !important;',
      '  background: rgb(12 18 28 / 0.92) !important;',
      '  color: white !important;',
      '  box-shadow: 0 8px 30px rgb(0 0 0 / 0.24) !important;',
      '  font: 12px/16px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;',
      '  pointer-events: auto !important;',
      '}',
      '#' + DIFF_PANEL_ID + ' strong { color: #fca5a5 !important; }',
      '#' + DIFF_PANEL_ID + ' div { margin-top: 4px !important; }',
      '#' + DIFF_PANEL_ID + ' code { color: #d1d5db !important; }',
      '#' + DIFF_PANEL_ID + ' .parity-diff-header {',
      '  display: flex !important;',
      '  align-items: center !important;',
      '  justify-content: space-between !important;',
      '  gap: 12px !important;',
      '  margin-top: 0 !important;',
      '}',
      '#' + DIFF_PANEL_ID + ' button {',
      '  border: 1px solid rgb(255 255 255 / 0.22) !important;',
      '  border-radius: 4px !important;',
      '  background: rgb(255 255 255 / 0.08) !important;',
      '  color: white !important;',
      '  padding: 2px 7px !important;',
      '  font: inherit !important;',
      '  cursor: pointer !important;',
      '}',
      '#' + DIFF_PANEL_ID + ' button:hover { background: rgb(255 255 255 / 0.14) !important; }',
      '#' + DIFF_PANEL_ID + '[data-expanded="true"] {',
      '  max-width: min(960px, calc(100vw - 24px)) !important;',
      '  max-height: min(78vh, calc(100vh - 24px)) !important;',
      '}',
      '#' + DIFF_PANEL_ID + ' .parity-diff-row small {',
      '  display: block !important;',
      '  margin-left: 0 !important;',
      '  color: rgb(255 255 255 / 0.58) !important;',
      '  white-space: nowrap !important;',
      '  overflow: hidden !important;',
      '  text-overflow: ellipsis !important;',
      '}',
      '#' + DIFF_PANEL_ID + ' .parity-diff-row-expanded {',
      '  margin-top: 10px !important;',
      '  padding-top: 10px !important;',
      '  border-top: 1px solid rgb(255 255 255 / 0.12) !important;',
      '}',
      '#' + DIFF_PANEL_ID + ' .parity-diff-key {',
      '  color: rgb(255 255 255 / 0.48) !important;',
      '  overflow-wrap: anywhere !important;',
      '}',
      '#' + DIFF_PANEL_ID + ' .parity-diff-detail {',
      '  margin-top: 8px !important;',
      '}',
      '#' + DIFF_PANEL_ID + ' .parity-diff-detail strong { color: #bfdbfe !important; }',
      '#' + DIFF_PANEL_ID + ' .parity-diff-detail span { margin-left: 8px !important; color: rgb(255 255 255 / 0.5) !important; }',
      '#' + DIFF_PANEL_ID + ' .parity-diff-detail div + div { margin-top: 4px !important; }',
      '#' + DIFF_PANEL_ID + ' .parity-diff-detail em { display: inline-block !important; width: 72px !important; color: rgb(255 255 255 / 0.5) !important; font-style: normal !important; }',
      '#' + DIFF_PANEL_ID + ' .parity-diff-detail code { color: #e5e7eb !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; }',
      '#' + TOOLTIP_ID + ' {',
      '  position: fixed !important;',
      '  z-index: 2147483647 !important;',
      '  display: none !important;',
      '  width: min(520px, calc(100vw - 24px)) !important;',
      '  max-height: min(420px, calc(100vh - 24px)) !important;',
      '  overflow: auto !important;',
      '  padding: 10px 12px !important;',
      '  border: 1px solid rgb(255 255 255 / 0.2) !important;',
      '  border-radius: 6px !important;',
      '  background: rgb(12 18 28 / 0.96) !important;',
      '  color: white !important;',
      '  box-shadow: 0 12px 40px rgb(0 0 0 / 0.34) !important;',
      '  font: 12px/16px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;',
      '  letter-spacing: 0 !important;',
      '  pointer-events: none !important;',
      '}',
      '#' + TOOLTIP_ID + ' .parity-tooltip-title { display: flex !important; gap: 8px !important; align-items: center !important; }',
      '#' + TOOLTIP_ID + ' .parity-tooltip-title code { color: #fca5a5 !important; }',
      '#' + TOOLTIP_ID + ' .parity-tooltip-title span { color: white !important; font-weight: 700 !important; }',
      '#' + TOOLTIP_ID + ' .parity-tooltip-meta { margin-top: 4px !important; color: rgb(255 255 255 / 0.48) !important; overflow-wrap: anywhere !important; }',
      '#' + TOOLTIP_ID + ' .parity-tooltip-row { margin-top: 8px !important; padding-top: 8px !important; border-top: 1px solid rgb(255 255 255 / 0.12) !important; }',
      '#' + TOOLTIP_ID + ' .parity-tooltip-row strong { color: #bfdbfe !important; }',
      '#' + TOOLTIP_ID + ' .parity-tooltip-row span { margin-left: 8px !important; color: rgb(255 255 255 / 0.5) !important; }',
      '#' + TOOLTIP_ID + ' .parity-tooltip-row div + div { margin-top: 4px !important; }',
      '#' + TOOLTIP_ID + ' .parity-tooltip-row em { display: inline-block !important; width: 72px !important; color: rgb(255 255 255 / 0.5) !important; font-style: normal !important; }',
      '#' + TOOLTIP_ID + ' .parity-tooltip-row code { color: #e5e7eb !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; }',
    ].join('\\n')

    document.head.appendChild(style)
  }

  const ensureToolbar = () => {
    let toolbar = document.getElementById(TOOLBAR_ID)
    if (toolbar) return toolbar

    toolbar = document.createElement('div')
    toolbar.id = TOOLBAR_ID
    toolbar.setAttribute('aria-hidden', 'true')
    document.body.appendChild(toolbar)
    return toolbar
  }

  const ensureDiffPanel = () => {
    let panel = document.getElementById(DIFF_PANEL_ID)
    if (panel) return panel

    panel = document.createElement('div')
    panel.id = DIFF_PANEL_ID
    panel.setAttribute('aria-hidden', 'true')
    document.body.appendChild(panel)
    return panel
  }

  const ensureTooltip = () => {
    let tooltip = document.getElementById(TOOLTIP_ID)
    if (tooltip) return tooltip

    tooltip = document.createElement('div')
    tooltip.id = TOOLTIP_ID
    tooltip.setAttribute('aria-hidden', 'true')
    document.body.appendChild(tooltip)
    return tooltip
  }

  const detailForElement = (element) => {
    const key = element?.getAttribute?.('data-parity-key')
    if (!key) return null
    return diffForCurrentPage()?.detailsByKey?.[key] || null
  }

  const tooltipDetailForElement = (element) => {
    const detail = detailForElement(element)
    if (detail && (detail.status !== 'match' || shouldShowDataTooltip(element))) return detail
    if (shouldShowDataTooltip(element)) return liveElementDetail(element)
    return null
  }

  const positionTooltip = (tooltip, event) => {
    const margin = 12
    const gap = 14
    const width = tooltip.offsetWidth || 520
    const height = tooltip.offsetHeight || 180
    let left = event.clientX + gap
    let top = event.clientY + gap

    if (left + width + margin > window.innerWidth) left = event.clientX - width - gap
    if (top + height + margin > window.innerHeight) top = event.clientY - height - gap

    tooltip.style.left = Math.max(margin, left) + 'px'
    tooltip.style.top = Math.max(margin, top) + 'px'
  }

  const showTooltip = (target, event) => {
    if (document.documentElement.getAttribute('data-parity-overlay') !== 'on') return
    const problem = tooltipDetailForElement(target)
    if (!problem) return

    const tooltip = ensureTooltip()
    tooltip.innerHTML = renderProblemTooltip(problem)
    tooltip.style.display = 'block'
    activeTooltipTarget = target
    positionTooltip(tooltip, event)
  }

  const hideTooltip = () => {
    activeTooltipTarget = null
    const tooltip = document.getElementById(TOOLTIP_ID)
    if (tooltip) tooltip.style.display = 'none'
  }

  const applyMetadata = () => {
    const elements = document.querySelectorAll('[data-id]')
    const pageDiff = diffForCurrentPage()
    const occurrenceByBaseKey = new Map()

    elements.forEach((element) => {
      const baseKey = baseParityKey(element)
      const occurrence = occurrenceByBaseKey.get(baseKey) || 0
      const parityKey = baseKey + '#' + occurrence
      occurrenceByBaseKey.set(baseKey, occurrence + 1)

      const seed = [
        element.getAttribute('data-id') || '',
        element.getAttribute('data-list') || '',
        element.getAttribute('data-field') || '',
      ].join(':')

      element.style.setProperty('--parity-hue', String(hashHue(seed)))
      element.setAttribute('data-parity-tagged', 'true')
      element.setAttribute('data-parity-key', parityKey)

      const status = pageDiff?.statuses?.[parityKey]
      if (status) {
        element.setAttribute('data-parity-status', status)
      } else {
        element.removeAttribute('data-parity-status')
      }

      const tooltipDetail = tooltipDetailForElement(element)
      if (tooltipDetail) {
        element.setAttribute('data-parity-tooltip', problemLabel(tooltipDetail))
        element.setAttribute('title', renderProblemTitle(tooltipDetail))
        if (tooltipDetail.status !== 'match' && tooltipDetail.status !== 'tagged-data') {
          element.setAttribute('data-parity-diff', problemLabel(tooltipDetail))
        } else {
          element.removeAttribute('data-parity-diff')
        }
      } else {
        element.removeAttribute('data-parity-tooltip')
        element.removeAttribute('data-parity-diff')
        element.removeAttribute('title')
      }

      const description = describe(element)
      if (description) element.setAttribute('data-parity-label', description)
    })
  }

  const updateDiffPanel = () => {
    const pageDiff = diffForCurrentPage()
    const existing = document.getElementById(DIFF_PANEL_ID)

    if (!pageDiff || !pageDiff.problems || pageDiff.problems.length === 0) {
      if (existing) existing.remove()
      return
    }

    const panel = ensureDiffPanel()
    panel.dataset.expanded = diffPanelExpanded ? 'true' : 'false'
    const visibleProblems = diffPanelExpanded ? pageDiff.problems : pageDiff.problems.slice(0, 12)
    panel.innerHTML =
      '<div class="parity-diff-header"><strong>' + pageDiff.problems.length + ' parity discrepancies</strong>' +
      '<button type="button" data-parity-diff-toggle>' + (diffPanelExpanded ? 'collapse' : 'expand') + '</button></div>' +
      visibleProblems.map(diffPanelExpanded ? renderProblemFullLine : renderProblemLine).join('') +
      (!diffPanelExpanded && pageDiff.problems.length > visibleProblems.length ? '<div>...and ' + (pageDiff.problems.length - visibleProblems.length) + ' more</div>' : '')
  }

  const updateToolbar = () => {
    const toolbar = ensureToolbar()
    const tagged = document.querySelectorAll('[data-id]').length
    const dataPoints = document.querySelectorAll('[data-id="data-point"]').length
    const lists = document.querySelectorAll('[data-list]').length
    const overlay = document.documentElement.getAttribute('data-parity-overlay') === 'on' ? 'on' : 'off'
    const labels = document.documentElement.getAttribute('data-parity-labels') === 'on' ? 'on' : 'off'
    const pageDiff = diffForCurrentPage()
    const problems = pageDiff?.problems?.length || 0

    toolbar.innerHTML =
      '<strong>parity tags</strong>' +
      '<span>' + tagged + ' tagged</span>' +
      '<span>' + dataPoints + ' data</span>' +
      '<span>' + lists + ' lists</span>' +
      (pageDiff ? '<span>' + problems + ' diffs</span>' : '') +
      '<span>Alt+P ' + overlay + '</span>' +
      '<span>Alt+L labels ' + labels + '</span>'
  }

  const refresh = () => {
    scheduled = false
    ensureStyle()

    if (!document.documentElement.hasAttribute('data-parity-overlay')) {
      document.documentElement.setAttribute('data-parity-overlay', 'on')
    }

    if (!document.documentElement.hasAttribute('data-parity-labels')) {
      document.documentElement.setAttribute('data-parity-labels', 'on')
    }

    applyMetadata()
    updateDiffPanel()
    updateToolbar()
  }

  const scheduleRefresh = () => {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(refresh)
  }

  const show = () => {
    document.documentElement.setAttribute('data-parity-overlay', 'on')
    scheduleRefresh()
  }

  const hide = () => {
    document.documentElement.setAttribute('data-parity-overlay', 'off')
    scheduleRefresh()
  }

  const toggle = () => {
    if (document.documentElement.getAttribute('data-parity-overlay') === 'on') hide()
    else show()
  }

  const toggleLabels = () => {
    const current = document.documentElement.getAttribute('data-parity-labels')
    document.documentElement.setAttribute('data-parity-labels', current === 'on' ? 'off' : 'on')
    scheduleRefresh()
  }

  window.__PARITY_OVERLAY__ = {
    refresh,
    show,
    hide,
    toggle,
    toggleLabels,
  }

  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

    if (event.code === 'KeyP') {
      event.preventDefault()
      toggle()
    }

    if (event.code === 'KeyL') {
      event.preventDefault()
      toggleLabels()
    }
  })

  document.addEventListener('click', (event) => {
    if (!event.target?.closest?.('[data-parity-diff-toggle]')) return
    event.preventDefault()
    diffPanelExpanded = !diffPanelExpanded
    scheduleRefresh()
  })

  document.addEventListener('pointerover', (event) => {
    const target = event.target?.closest?.('[data-parity-key]')
    if (target) showTooltip(target, event)
  })

  document.addEventListener('pointermove', (event) => {
    if (!activeTooltipTarget) return
    const tooltip = document.getElementById(TOOLTIP_ID)
    if (tooltip) positionTooltip(tooltip, event)
  })

  document.addEventListener('pointerout', (event) => {
    if (!activeTooltipTarget) return
    if (event.relatedTarget && activeTooltipTarget.contains(event.relatedTarget)) return
    hideTooltip()
  })

  document.addEventListener('focusin', (event) => {
    const target = event.target?.closest?.('[data-parity-key]')
    if (!target || !tooltipDetailForElement(target)) return
    showTooltip(target, { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 })
  })

  document.addEventListener('focusout', hideTooltip)

  const observer = new MutationObserver(scheduleRefresh)
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-id', 'data-list', 'data-key', 'data-field', 'data-value'],
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh, { once: true })
  } else {
    refresh()
  }
})()
`

const args = parseArgs(process.argv.slice(2))

if (args.flags.help || args.flags.h) {
  printHelp()
  process.exit(0)
}

void main().catch((error) => {
  console.error('[parity-overlay] ' + (error?.stack || error?.message || error))
  process.exit(1)
})

async function main() {
  const positional = args.positionals[0]
  const diffPath = valueOf('diff') || process.env.PARITY_DIFF
  const diffSide = valueOf('side') || process.env.PARITY_DIFF_SIDE || 'candidate'
  const diffPayload = diffPath ? await loadOverlayDiff(diffPath, diffSide) : null
  const injectedOverlayScriptPath = await writeInjectedOverlayScript(diffPayload)
  const target = await resolveTarget(positional, injectedOverlayScriptPath)
  const state = {
    browser: null,
  }
  const serverProcess = target.serverProcess
  let shuttingDown = false

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true

    if (state.browser?.isConnected()) {
      await state.browser.close().catch(() => {})
    }

    await stopServer(serverProcess)
    await removeInjectedOverlayScript(injectedOverlayScriptPath)
    process.exit(exitCode)
  }

  process.once('SIGINT', () => void shutdown(0))
  process.once('SIGTERM', () => void shutdown(0))

  if (serverProcess) {
    await waitForHttp(target.baseUrl, READY_TIMEOUT_MS, serverProcess)
  }
  else {
    await waitForHttp(target.url.href, READY_TIMEOUT_MS)
  }

  state.browser = await launchBrowser()
  state.browser.on('disconnected', () => void shutdown(0))

  const context = await state.browser.newContext({
    viewport: {
      width: Number(process.env.PARITY_VIEWPORT_WIDTH || 1440),
      height: Number(process.env.PARITY_VIEWPORT_HEIGHT || 1000),
    },
  })

  if (diffPayload) {
    await context.addInitScript({ content: 'window.__PARITY_DIFF__ = ' + JSON.stringify(diffPayload) })
  }
  await context.addInitScript({ content: overlayInitScript })

  const page = await context.newPage()
  console.log('[parity-overlay] Opening ' + target.url.href)
  console.log('[parity-overlay] Shortcuts: Alt+P toggles borders, Alt+L toggles labels. Close the browser or press Ctrl+C to stop.')
  if (diffPayload) {
    console.log('[parity-overlay] Loaded diff for ' + diffSide + ' side from ' + diffPath)
  }

  await page.goto(target.url.href, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await page.evaluate(() => window.__PARITY_OVERLAY__?.refresh?.())

  const counts = await page.evaluate(() => ({
    tagged: document.querySelectorAll('[data-id]').length,
    dataPoints: document.querySelectorAll('[data-id="data-point"]').length,
    lists: document.querySelectorAll('[data-list]').length,
  }))

  console.log(
    '[parity-overlay] Initial page has '
    + counts.tagged
    + ' tagged elements, '
    + counts.dataPoints
    + ' data points, '
    + counts.lists
    + ' list markers.',
  )

  await new Promise(() => {})
}

async function writeInjectedOverlayScript(diffPayload) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'euler-parity-overlay-'))
  const filePath = path.join(dir, 'overlay.js')
  const chunks = []

  if (diffPayload) {
    chunks.push('window.__PARITY_DIFF__ = ' + serializeForInlineScript(diffPayload))
  }

  chunks.push(overlayInitScript)
  await fs.writeFile(filePath, chunks.join('\n;\n'), 'utf8')
  return filePath
}

async function removeInjectedOverlayScript(filePath) {
  if (!filePath) return
  await fs.rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => {})
}

function serializeForInlineScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case '<': return '\\u003c'
      case '>': return '\\u003e'
      case '&': return '\\u0026'
      case '\u2028': return '\\u2028'
      case '\u2029': return '\\u2029'
      default: return character
    }
  })
}

async function loadOverlayDiff(filePath, side) {
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'))
  const diff = raw.diff ? JSON.parse(await fs.readFile(raw.diff, 'utf8')) : raw
  const pages = {}

  for (const page of diff.pages || []) {
    const pageUrl = new URL(side === 'baseline' ? page.baselineUrl : page.candidateUrl)
    const pageKey = pageUrl.pathname + pageUrl.search
    const statuses = {}
    const detailsByKey = {}
    const problems = []

    for (const item of page.elementDiffs || []) {
      statuses[item.key] = item.status
      const source = side === 'baseline' ? item.baseline : item.candidate
      const detail = {
        key: item.key,
        baseKey: item.baseKey,
        status: item.status,
        id: source?.id || item.baseline?.id || item.candidate?.id || '',
        field: source?.field || item.baseline?.field || item.candidate?.field || '',
        list: source?.list || item.baseline?.list || item.candidate?.list || '',
        itemKey: source?.itemKey || item.baseline?.itemKey || item.candidate?.itemKey || '',
        baseline: item.baseline,
        candidate: item.candidate,
        mismatch: item.mismatch,
      }
      detailsByKey[item.key] = detail

      if (item.status !== 'match') {
        problems.push(detail)
      }
    }

    for (const listDiff of page.listDiffs || []) {
      if (listDiff.status === 'match') continue
      problems.push({
        key: 'list:' + listDiff.list,
        status: listDiff.status,
        id: 'list',
        field: listDiff.list,
        list: listDiff.list,
        itemKey: '',
      })
    }

    for (const captureError of page.captureErrors || []) {
      problems.push({
        key: 'capture-error:' + captureError.side,
        status: 'capture-error',
        id: 'page',
        field: captureError.side,
        list: '',
        itemKey: '',
      })
    }

    for (const consoleError of page.consoleErrors || []) {
      problems.push({
        key: 'console-error:' + consoleError.side,
        status: 'console-error',
        id: 'page',
        field: consoleError.side,
        list: '',
        itemKey: '',
      })
    }

    pages[pageKey] = {
      pageId: page.pageId,
      status: page.status,
      summary: page.summary,
      baselineUrl: page.baselineUrl,
      candidateUrl: page.candidateUrl,
      statuses,
      detailsByKey,
      problems,
    }
  }

  return {
    side,
    runId: diff.runId,
    pages,
  }
}

async function resolveTarget(positional, injectedOverlayScriptPath) {
  if (isHttpUrl(positional)) {
    return {
      url: new URL(positional),
      baseUrl: originOf(positional),
      serverProcess: null,
    }
  }

  if (process.env.PARITY_URL) {
    const base = new URL(process.env.PARITY_URL)
    return {
      url: positional ? new URL(normalizePath(positional), base) : base,
      baseUrl: originOf(base.href),
      serverProcess: null,
    }
  }

  const host = process.env.PARITY_HOST || DEFAULT_HOST
  const startPort = Number(process.env.PARITY_PORT || DEFAULT_PORT)
  const port = await findFreePort(host, startPort)
  const baseUrl = 'http://' + host + ':' + port
  const path = positional || process.env.PARITY_PATH || '/'

  return {
    url: new URL(normalizePath(path), baseUrl),
    baseUrl,
    serverProcess: startDevServer(host, port, injectedOverlayScriptPath),
  }
}

function startDevServer(host, port, injectedOverlayScriptPath) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(npmCommand, ['run', 'dev', '--', '--host', host, '--port', String(port)], {
    env: {
      ...process.env,
      BROWSER: 'none',
      PARITY_OVERLAY_INJECT: '1',
      PARITY_OVERLAY_SCRIPT_PATH: injectedOverlayScriptPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', chunk => process.stdout.write(chunk))
  child.stderr.on('data', chunk => process.stderr.write(chunk))

  child.once('exit', (code, signal) => {
    if (code || signal) {
      console.error('[parity-overlay] Dev server exited with code=' + code + ' signal=' + signal)
    }
  })

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

async function launchBrowser() {
  const headless = process.env.PARITY_HEADLESS === '1'
  const channel = process.env.PARITY_BROWSER_CHANNEL === 'none'
    ? undefined
    : process.env.PARITY_BROWSER_CHANNEL || 'chrome'

  if (channel) {
    try {
      return await chromium.launch({ channel, headless })
    }
    catch (error) {
      console.warn('[parity-overlay] Could not launch Chromium channel "' + channel + '": ' + error.message)
      console.warn('[parity-overlay] Falling back to Playwright-managed Chromium.')
    }
  }

  try {
    return await chromium.launch({ headless })
  }
  catch (error) {
    throw new Error(
      'Could not launch a browser. Install Playwright Chromium with "npx playwright install chromium" or set PARITY_BROWSER_CHANNEL to an installed channel. Original error: '
      + error.message,
    )
  }
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
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortFree(host, port)) return port
  }

  throw new Error('No free port found between ' + startPort + ' and ' + (startPort + 49))
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

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function normalizePath(value) {
  if (!value || value === '.') return '/'
  return value.startsWith('/') ? value : '/' + value
}

function originOf(value) {
  const url = new URL(value)
  return url.origin
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function printHelp() {
  console.log(`
Usage:
  npm run parity:overlay
  npm run parity:overlay -- /earn
  PARITY_URL=http://127.0.0.1:3000 npm run parity:overlay
  PARITY_DIFF=artifacts/parity/latest-run.json npm run parity:overlay -- /lend?network=1

Options and environment:
  First arg                  Route path or full URL to open.
  --diff <file>              Load diff.json or latest-run.json and highlight parity status.
  --side <side>              Diff side to render: candidate or baseline. Default: candidate.
  PARITY_URL                 Attach to an existing app URL instead of starting dev.
  PARITY_PATH                Route path when no first arg is provided.
  PARITY_DIFF                Same as --diff.
  PARITY_DIFF_SIDE           Same as --side.
  PARITY_HOST                Dev server host. Default: ${DEFAULT_HOST}
  PARITY_PORT                First dev server port to try. Default: ${DEFAULT_PORT}
  PARITY_BROWSER_CHANNEL     Browser channel. Default: chrome. Use "none" for bundled Chromium.
  PARITY_HEADLESS=1          Run headless.
  PARITY_VIEWPORT_WIDTH      Browser viewport width. Default: 1440
  PARITY_VIEWPORT_HEIGHT     Browser viewport height. Default: 1000

When the runner starts the app itself, it also injects the overlay into the
served HTML. Opening the printed URL in another browser tab will show the same
tag styling and diff panel.

In the browser:
  Alt+P toggles tag borders.
  Alt+L toggles tag labels.
`)
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
    const [key, inlineValue] = trimmed.split('=', 2)
    const next = argv[index + 1]

    if (inlineValue !== undefined) {
      flags[key] = inlineValue
    }
    else if (next && !next.startsWith('-')) {
      flags[key] = next
      index += 1
    }
    else {
      flags[key] = true
    }
  }

  return { flags, positionals }
}

function valueOf(name) {
  const value = args.flags[name]
  return typeof value === 'string' ? value : null
}
