import { describe, expect, it } from 'vitest'
import {
  buildAnnouncementConfig,
  isAnnouncementEnabled,
  parseAnnouncementItems,
} from '~/utils/announcement-config'

describe('announcement-config', () => {
  it('enables only explicit truthy values', () => {
    expect(isAnnouncementEnabled('true')).toBe(true)
    expect(isAnnouncementEnabled('1')).toBe(true)
    expect(isAnnouncementEnabled('yes')).toBe(true)
    expect(isAnnouncementEnabled('false')).toBe(false)
    expect(isAnnouncementEnabled('')).toBe(false)
  })

  it('parses JSON array item config', () => {
    expect(parseAnnouncementItems('["First"," Second ","",42]')).toEqual(['First', 'Second'])
  })

  it('parses newline-delimited item config', () => {
    expect(parseAnnouncementItems('First\n Second \n\nThird')).toEqual(['First', 'Second', 'Third'])
  })

  it('ignores malformed JSON array item config', () => {
    expect(parseAnnouncementItems('["First",')).toEqual([])
  })

  it('requires an enabled flag and id before showing', () => {
    expect(buildAnnouncementConfig({
      enabled: 'true',
      id: '',
      title: 'Hello',
    })).toMatchObject({
      enabled: false,
      id: '',
    })

    expect(buildAnnouncementConfig({
      enabled: 'false',
      id: 'migrations-v1',
      title: 'Hello',
    })).toMatchObject({
      enabled: false,
      id: 'migrations-v1',
    })
  })

  it('normalizes enabled announcement content', () => {
    expect(buildAnnouncementConfig({
      enabled: 'true',
      id: ' migrations-v1 ',
      title: ' Migrate positions ',
      body: ' Move positions between protocols. ',
      items: 'One\nTwo',
      url: ' https://example.com ',
    })).toEqual({
      enabled: true,
      id: 'migrations-v1',
      title: 'Migrate positions',
      body: 'Move positions between protocols.',
      items: ['One', 'Two'],
      url: 'https://example.com',
    })
  })
})
