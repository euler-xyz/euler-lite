import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'components/BatchReviewModal.vue'),
  'utf8',
)

const sectionBetween = (start: string, end: string): string => {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

const expectCeremonyPlanFirst = (section: string) => {
  const selectorIndex = section.indexOf('getBatchReviewDisplayPlan(')
  const ceremonyIndex = section.indexOf('executionCeremonyRef.value?.reviewByEntryId[entry.id]?.plan')
  const capturedPlanIndex = section.indexOf('entryPlans.value[entry.id]')

  expect(selectorIndex).toBeGreaterThanOrEqual(0)
  expect(ceremonyIndex).toBeGreaterThan(selectorIndex)
  expect(capturedPlanIndex).toBeGreaterThan(ceremonyIndex)
}

describe('BatchReviewModal ceremony wiring', () => {
  it('derives expanded operation rows from the ceremony plan', () => {
    const displaySection = sectionBetween(
      'const stepsByEntryId = computed',
      'const signatureStepsByEntryId = computed',
    )

    expectCeremonyPlanFirst(displaySection)
    expect(source).toContain(':steps="stepsByEntryId[entry.id]"')
  })

  it('derives unverified-vault disclosure from the ceremony plan', () => {
    const disclosureSection = sectionBetween(
      'const unverifiedVaultNames = computed',
      'const hasUnverified = computed',
    )

    expectCeremonyPlanFirst(disclosureSection)
    expect(source).toContain('v-if="hasUnverified"')
    expect(source).toContain('unverifiedVaultNames.join(\', \')')
  })
})
